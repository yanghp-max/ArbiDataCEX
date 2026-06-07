/**
 * CEX-CEX 任务：开/平仓状态机（对齐 backtest_cex_cex_open_only.py）
 */
import { RollingSignalEngine } from '../calculator/rolling-signal-engine.js';
import {
  calcSpreads,
  pickOpenFromFlat,
  lockedZValues,
  decideAddOrClose,
  closeTradeDirection,
  isFlatPosition,
  isHedgedPosition,
  isOneSidedOrphan,
  isPositionLockConsistent,
  inferDirectionFromPosition,
  resolveCexCostConfig,
  resolveCexCostConfigForSymbol
} from '../services/spread-calculator.js';
import {
  PrecisionChecker,
  RiskManager,
  finalCheckPass,
  resolveLatencyLimits,
  tickLatencyPass,
  tickSignalAgePass,
  tickPriceSnapshot,
  tickPriceSlippagePass,
  describePriceSlippageFail
} from '../risk/risk-manager.js';
import { calcTradePnl, calcTradeGross, calcTradeFeeCost } from '../execution/result-reporter.js';
import {
  createTradeLatencyTrace,
  formatLatencyLogLines,
  markLatency,
  setFreshTickOnLatencyTrace
} from '../monitoring/trade-latency.js';

import {
  calcLegSlippageBps,
  formatSlippageBps,
  formatPriceForDisplay,
  nominalPriceForLeg
} from '../monitoring/trade-slippage.js';

function formatFilledLegLine(exchange, side, quoteBid, quoteAsk, fillPrice, qty, priceNominal = null) {
  const quoteTag = side === 'sell' ? 'bid' : side === 'buy' ? 'ask' : '名义';
  const nominal = nominalPriceForLeg({
    side,
    bid: quoteBid,
    ask: quoteAsk,
    priceNominal
  });
  const quote = nominal != null ? formatPriceForDisplay(nominal, nominal) : '—';
  const fill = fillPrice != null && Number.isFinite(Number(fillPrice))
    ? formatPriceForDisplay(Number(fillPrice), nominal ?? fillPrice)
    : '—';
  const bps = calcLegSlippageBps({ side, nominal, fill: fillPrice });
  const slip = bps != null ? ` 滑点${formatSlippageBps(bps)}` : '';
  const sideCn = side === 'buy' ? '买' : side === 'sell' ? '卖' : String(side || '-');
  return `  ${exchange} ${sideCn} 盘口 ${quoteTag} ${quote} → 成交价 ${fill} qty=${qty}${slip}`;
}

export class CexCexTask {
  constructor(sharedResources, strategyConfig, precisionChecker) {
    this.sr = sharedResources;
    this.cfg = {
      ...strategyConfig,
      zOpen: strategyConfig.zOpen ?? strategyConfig.zOpenAb ?? 2.0,
      zClose: strategyConfig.zClose ?? 0.0,
      signalMaxAgeMs: strategyConfig.signalMaxAgeMs ?? 50
    };
    this.precision = precisionChecker;
    this.risk = new RiskManager(strategyConfig);
    this.engines = new Map();
    this.lastOrderTs = new Map();
    this.lockedDirection = new Map();
    this.lockedBranch = new Map();
    this.executingSymbols = new Set();
    /** 持仓失衡 warn 节流（每 symbol 30s 最多 1 条） */
    this._imbalanceWarnTs = new Map();
    /** 单边孤儿持仓 REST 对账节流（每 symbol 5s 最多 1 次） */
    this._reconcileTs = new Map();
    this.enforceLatency = sharedResources.enforceLatency;
    this.latencyLimits = resolveLatencyLimits(this.cfg, this.enforceLatency);
    this.cexCost = resolveCexCostConfig(strategyConfig);

    for (const sym of strategyConfig.symbols) {
      this.engines.set(sym, new RollingSignalEngine({
        windowSeconds: strategyConfig.windowSeconds,
        minDataPoints: strategyConfig.minDataPoints
      }));
      this.lastOrderTs.set(sym, 0);
    }
  }

  #syncLockState(symbol, signal) {
    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    const inFlight = this.executingSymbols.has(symbol);

    if (isFlatPosition(aQty, bQty)) {
      // 下单进行中：持仓尚未写入缓存，保留锁，避免并发 tick 再次 open
      if (inFlight) {
        const direction = this.lockedDirection.get(symbol) ?? null;
        const branch = this.lockedBranch.get(symbol) ?? null;
        if (direction) {
          return { flat: false, direction, branch };
        }
      }
      this.lockedDirection.delete(symbol);
      this.lockedBranch.delete(symbol);
      return { flat: true, direction: null, branch: null };
    }

    const inferred = inferDirectionFromPosition(aQty, bQty);
    let direction = inferred ?? this.lockedDirection.get(symbol) ?? null;
    if (direction && !isPositionLockConsistent(direction, aQty, bQty)) {
      this.lockedDirection.delete(symbol);
      this.lockedBranch.delete(symbol);
      direction = inferred;
    }
    if (!direction) {
      return { flat: false, direction: null, branch: null };
    }

    if (!this.lockedDirection.has(symbol)) {
      this.lockedDirection.set(symbol, direction);
    }

    let branch = this.lockedBranch.get(symbol);
    if (!branch && signal) {
      branch = direction === '-a+b' ? signal.branchAb : signal.branchBa;
      if (branch) this.lockedBranch.set(symbol, branch);
    }

    return { flat: false, direction, branch };
  }

  #clearLocksIfFlat(symbol) {
    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    if (isFlatPosition(aQty, bQty)) {
      this.lockedDirection.delete(symbol);
      this.lockedBranch.delete(symbol);
    }
  }

  /** 缓存与实盘不一致时按 symbol REST 对账（不依赖加仓信号触发） */
  async #reconcileStalePositionsIfNeeded(symbol) {
    if (this.sr.useMockAccount || this.executingSymbols.has(symbol)) return;

    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    if (isFlatPosition(aQty, bQty) || isHedgedPosition(aQty, bQty)) return;

    const now = Date.now();
    const last = this._reconcileTs.get(symbol) || 0;
    if (now - last < 1000) return;
    this._reconcileTs.set(symbol, now);

    await this.sr.accountCache.reconcileSymbolPositions(this.sr.cexManager, symbol);
    this.#clearLocksIfFlat(symbol);
  }

  /** 定时兜底：不依赖 WS 来价也能纠正陈旧持仓 */
  async reconcileAllStalePositions() {
    if (this.sr.useMockAccount) return;
    for (const sym of this.cfg.symbols || []) {
      if (this.executingSymbols.has(sym)) continue;
      const aQty = this.sr.accountCache.getPosition('binance', sym);
      const bQty = this.sr.accountCache.getPosition('gate', sym);
      if (isFlatPosition(aQty, bQty) || isHedgedPosition(aQty, bQty)) continue;
      await this.sr.accountCache.reconcileSymbolPositions(this.sr.cexManager, sym);
      this.#clearLocksIfFlat(sym);
    }
  }

  async onTick(symbol) {
    const tick = this.sr.quoteAggregator.buildTick(symbol);
    const engine = this.engines.get(symbol);

    if (!tick) {
      this.sr.dashboardBridge?.updateMarketSnapshot({ symbol, tick: null, spreads: null, signal: null, lock: null });
      return;
    }

    const symbolCost = resolveCexCostConfigForSymbol(this.cfg, symbol);
    const spreads = calcSpreads(tick, symbolCost);
    const signal = engine.updateAndCalc({
      timestamp: tick.timestamp,
      spreadAb: spreads.spreadAb,
      spreadBa: spreads.spreadBa,
      spreadAbAdj: spreads.spreadAbAdj,
      spreadBaAdj: spreads.spreadBaAdj
    });

    await this.#reconcileStalePositionsIfNeeded(symbol);

    const lock = this.#syncLockState(symbol, signal);
    this.sr.dashboardBridge?.updateMarketSnapshot({
      symbol,
      tick,
      spreads,
      signal,
      lock: {
        direction: lock.direction,
        branch: lock.branch,
        flat: lock.flat
      }
    });

    if (this.enforceLatency && !tickLatencyPass(tick, this.latencyLimits)) return;
    if (!signal.windowReady || signal.openZAb == null || signal.openZBa == null) return;

    if (tick.fundingA != null && tick.fundingA < this.cfg.fundingMin) return;
    if (tick.fundingB != null && tick.fundingB < this.cfg.fundingMin) return;

    const sinceOrder = Date.now() - this.lastOrderTs.get(symbol);
    if (sinceOrder < this.cfg.cooldownMs) return;
    if (this.executingSymbols.has(symbol)) return;
    const maxInFlight = Number(this.cfg.maxInFlightTrades);
    if (Number.isFinite(maxInFlight) && maxInFlight > 0 && this.sr.inFlightCount >= maxInFlight) {
      return;
    }

    let tradePlan = null;

    if (lock.flat) {
      tradePlan = pickOpenFromFlat(signal, this.cfg.zOpen);
    } else if (lock.direction && lock.branch) {
      const { openZ, closeZ } = lockedZValues(signal, lock.direction, lock.branch);
      const decision = decideAddOrClose(openZ, closeZ, this.cfg.zOpen, this.cfg.zClose);
      if (!decision) return;

      const execDirection = lock.direction;
      const adjSpread = execDirection === '-a+b' ? spreads.spreadAbAdj : spreads.spreadBaAdj;
      if (decision.action === 'add') {
        let aQty = this.sr.accountCache.getPosition('binance', symbol);
        let bQty = this.sr.accountCache.getPosition('gate', symbol);
        if (!isHedgedPosition(aQty, bQty) && !this.sr.useMockAccount) {
          await this.sr.accountCache.reconcileSymbolPositions(this.sr.cexManager, symbol);
          aQty = this.sr.accountCache.getPosition('binance', symbol);
          bQty = this.sr.accountCache.getPosition('gate', symbol);
        }
        if (!isHedgedPosition(aQty, bQty)) {
          if (isFlatPosition(aQty, bQty)) {
            this.#clearLocksIfFlat(symbol);
            return;
          }
          const now = Date.now();
          const last = this._imbalanceWarnTs.get(symbol) || 0;
          if (now - last >= 30000) {
            this._imbalanceWarnTs.set(symbol, now);
            console.warn(
              `[CexCexTask] ${symbol} 持仓失衡(A=${aQty} B=${bQty})，跳过加仓直至对冲恢复`
              + '（若 App 也无仓：多为缓存残留，已对账；仍出现请点 Dashboard 刷新账户）'
            );
          }
          return;
        }
        tradePlan = {
          action: 'add',
          direction: execDirection,
          branch: lock.branch,
          adjSpread,
          openZ: decision.openZ,
          closeZ: decision.closeZ
        };
      } else {
        tradePlan = {
          action: 'close',
          direction: execDirection,
          branch: lock.branch,
          adjSpread: execDirection === '-a+b' ? spreads.spreadBaAdj : spreads.spreadAbAdj,
          spreadFilterDirection: closeTradeDirection(execDirection),
          openZ: decision.openZ,
          closeZ: decision.closeZ
        };
      }
    } else {
      return;
    }

    if (!tradePlan) return;

    const latencyTrace = createTradeLatencyTrace(tick);

    const isClose = tradePlan.action === 'close';
    const execDirection = isClose ? closeTradeDirection(tradePlan.direction) : tradePlan.direction;
    const spreadFilterDir = tradePlan.spreadFilterDirection ?? tradePlan.direction;
    const filterSpread = spreadFilterDir === '-a+b' ? spreads.spreadAbAdj : spreads.spreadBaAdj;

    if (!finalCheckPass(tick, spreadFilterDir, filterSpread, this.latencyLimits)) return;

    const orderBuild = this.precision.buildOrder({
      direction: execDirection,
      tick,
      orderUsd: this.cfg.orderUsd
    });
    if (orderBuild.qty <= 0) return;

    let orderForExec = orderBuild;
    let qty = orderBuild.qty;
    if (isClose) {
      const clipped = this.risk.clipCloseQty(qty, tick, this.sr.accountCache);
      const aligned = this.precision.alignHedgeFromBaseQty(tick, clipped);
      if (aligned.qty <= 0) return;
      orderForExec = { ...orderBuild, qty: aligned.qty, gateSize: aligned.gateSize };
      qty = aligned.qty;
    } else {
      const clipped = this.risk.clipQty(qty, tick, execDirection, this.sr.accountCache);
      const finalized = this.precision.finalizeOpenOrder({
        direction: execDirection,
        tick,
        clippedQty: clipped,
        orderUsd: this.cfg.orderUsd
      });
      if (!finalized) return;
      orderForExec = finalized;
      qty = finalized.qty;
    }

    if (this.enforceLatency && !tickSignalAgePass(tick, this.latencyLimits.signalMaxAgeMs)) return;

    markLatency(latencyTrace, 'prep_done');

    const priceSnapshot = tickPriceSnapshot(symbol, tick);

    const posBefore = {
      a: this.sr.accountCache.getPosition('binance', symbol),
      b: this.sr.accountCache.getPosition('gate', symbol)
    };
    const increasesAbs = !isClose && this.risk.wouldIncreaseAbs(posBefore, execDirection, qty);
    const maxPosQty = this.risk.maxPositionQty(tick, isClose ? tradePlan.direction : execDirection);
    const { aNeed, bNeed } = this.precision.calcUsdtNeed(execDirection, qty, tick, this.cfg.balanceCheckRate);

    if (!this.sr.useMockAccount) {
      const cache = this.sr.accountCache;
      const maxAge = cache.accountCacheMaxAgeMs ?? 5000;
      const needFresh = ['binance', 'gate'].some(
        (ex) => !cache.isReliable(ex) || cache.isStale(ex, maxAge)
      );
      if (needFresh) {
        try {
          await cache.ensureFresh(this.sr.cexManager);
        } catch {
          return;
        }
      }
    }
    markLatency(latencyTrace, 'account_fresh_done');

    // 在 await 之前占位（对齐 ArbiTrade-1 预占前互斥 + 单路径 tick）
    if (this.executingSymbols.has(symbol)) return;
    this.executingSymbols.add(symbol);
    this.lastOrderTs.set(symbol, Date.now());
    if (!isClose) {
      this.lockedDirection.set(symbol, tradePlan.direction);
      if (tradePlan.branch) this.lockedBranch.set(symbol, tradePlan.branch);
    }

    const tradeId = `${symbol}_${Date.now()}`;
    let reservations;
    try {
      reservations = await this.sr.reservationManager.tryReserve({
        tradeId,
        symbol,
        direction: execDirection,
        qty,
        aNeed,
        bNeed,
        maxPositionQty: maxPosQty,
        increasesAbs
      });
    } catch (err) {
      this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
      throw err;
    }

    if (!reservations) {
      this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
      return;
    }
    markLatency(latencyTrace, 'reserve_done');

    this.sr.inFlightCount += 1;
    this.sr.reservationManager.markExecuting(tradeId);
    this.executeAsync({
      symbol,
      action: tradePlan.action,
      lockedDirection: tradePlan.direction,
      execDirection,
      branch: tradePlan.branch,
      tick,
      priceSnapshot,
      order: orderForExec,
      adjSpread: filterSpread,
      openZ: tradePlan.openZ,
      closeZ: tradePlan.closeZ,
      reservations,
      latencyTrace
    }).catch((err) => console.error(`[CexCexTask] execute error ${symbol}:`, err.message));
  }

  async #auditPostTradeHedge(symbol, fill) {
    if (fill?.legExposure || !(fill?.aFilledQty > 0 && fill?.bFilledQty > 0)) return;

    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    if (isHedgedPosition(aQty, bQty)) return;

    const key = String(symbol).replace(/[-_]/g, '');
    const gateRows = await this.sr.cexManager.getPositions('gate', { silent: true }).catch(() => []);
    const raw = (gateRows || []).find(
      (p) => String(p.symbol).replace(/[-_]/g, '') === key
    );

    console.error(
      `[CexCexTask] ${symbol} 成交后未对冲: cache A=${aQty} B=${bQty}`
      + ` | 回执 A=${fill.aFilledQty} B=${fill.bFilledQty}`
      + (raw
        ? ` | Gate REST contracts=${raw.contracts ?? '?'} baseQty=${raw.qty}`
        : ' | Gate REST 无该合约持仓')
      + (Math.abs(aQty) > 1e-6 && Math.abs(bQty) < 1e-6
        ? ` → 建议 Gate 开多 ${Math.abs(aQty)} 或 Binance 平空 ${Math.abs(aQty)}`
        : '')
    );
  }

  #logLatency(trace, { reason = null, partial = false } = {}) {
    if (!trace) return;
    if (reason) {
      console.warn(`[延迟·中止] ${reason}`);
      if (partial) {
        for (const line of formatLatencyLogLines(trace)) {
          console.warn(line);
        }
      }
      return;
    }
    for (const line of formatLatencyLogLines(trace)) {
      console.log(line);
    }
  }

  #releaseSymbolClaim(symbol, { restoreCooldown = false } = {}) {
    this.executingSymbols.delete(symbol);
    if (restoreCooldown) {
      this.lastOrderTs.set(symbol, 0);
    }
    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    if (isFlatPosition(aQty, bQty)) {
      this.lockedDirection.delete(symbol);
      this.lockedBranch.delete(symbol);
    }
  }

  async executeAsync(ctx) {
    const {
      symbol,
      action,
      lockedDirection,
      execDirection,
      branch,
      tick,
      priceSnapshot,
      order,
      adjSpread,
      reservations,
      latencyTrace
    } = ctx;
    const tradeId = reservations?.tradeId;
    try {
      markLatency(latencyTrace, 'exec_async_start');
      const freshTick = this.sr.quoteAggregator.buildTick(symbol);
      const latencyOk = !this.enforceLatency || tickLatencyPass(freshTick, this.latencyLimits);
      const symbolCost = resolveCexCostConfigForSymbol(this.cfg, symbol);
      const slipCheck = freshTick
        ? tickPriceSlippagePass(priceSnapshot, freshTick, execDirection, {
          binanceSlippageBps: symbolCost.binanceSlippageBps,
          gateSlippageBps: symbolCost.gateSlippageBps
        })
        : { ok: false, reason: '无行情' };
      const priceOk = slipCheck.ok;
      if (!freshTick || !latencyOk || !priceOk) {
        if (freshTick) {
          setFreshTickOnLatencyTrace(latencyTrace, freshTick);
          markLatency(latencyTrace, 'fresh_tick_done');
        }
        this.#logLatency(latencyTrace, {
          reason: !freshTick
            ? '无行情'
            : !latencyOk
              ? '延迟检查未过'
              : describePriceSlippageFail(slipCheck) || 'WS 价格超过滑点',
          partial: true
        });
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      if (!finalCheckPass(freshTick, execDirection, adjSpread, this.latencyLimits)) {
        this.#logLatency(latencyTrace, { reason: '最终价差校验未过' });
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      setFreshTickOnLatencyTrace(latencyTrace, freshTick);
      markLatency(latencyTrace, 'fresh_tick_done');

      let fill;
      try {
        fill = await this.sr.orderExecutor.executeBothLegs({
          direction: execDirection,
          tick: freshTick,
          order,
          reduceOnly: action === 'close',
          lockedDirection,
          latencyTrace,
          cexFeeBpsPerLeg: symbolCost.cexFeeBpsPerLeg,
          binanceFeeBps: symbolCost.binanceFeeBps,
          gateFeeBps: symbolCost.gateFeeBps,
          maxPositionQty: this.risk.maxPositionQty(
            freshTick,
            action === 'close' ? (lockedDirection ?? execDirection) : execDirection
          )
        });
      } catch (err) {
        await this.sr.accountCache.refreshFromCexManager(this.sr.cexManager).catch(() => {});
        this.#logLatency(latencyTrace, { reason: `下单失败: ${err.message}` });
        console.error(`[CexCexTask] ${symbol} 下单失败:`, err.message);
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      const hasAnyFill = fill.aFilledQty > 0 || fill.bFilledQty > 0;
      if (!fill.simulated && !hasAnyFill) {
        this.#logLatency(latencyTrace, { reason: '两腿均未成交' });
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      this.sr.accountCache.applyFillToCache(symbol, execDirection, fill);

      const netPnl = calcTradePnl(fill);

      this.sr.resultReporter.recordTrade({
        symbol,
        direction: execDirection,
        action,
        lockedDirection,
        fill,
        netPnl,
        accountCache: this.sr.accountCache,
        dashboardBridge: this.sr.dashboardBridge,
        latencyTrace
      });

      if (!fill.simulated) {
        const syncRes = await this.sr.accountCache.syncSymbolPositionsAfterFill(
          this.sr.cexManager,
          symbol
        );
        if (syncRes.timeout && !syncRes.hedged && !syncRes.flat) {
          console.warn(
            `[CexCexTask] ${symbol} 成交后 REST 未在时限内确认对冲，保留回执缓存 A=`
            + `${this.sr.accountCache.getPosition('binance', symbol)} B=`
            + `${this.sr.accountCache.getPosition('gate', symbol)}`
          );
        }
        await this.#auditPostTradeHedge(symbol, fill);
      }

      const aQty = this.sr.accountCache.getPosition('binance', symbol);
      const bQty = this.sr.accountCache.getPosition('gate', symbol);
      if (action === 'open' || action === 'add') {
        this.lockedDirection.set(symbol, lockedDirection ?? execDirection);
        if (branch) this.lockedBranch.set(symbol, branch);
      } else if (action === 'close' && isFlatPosition(aQty, bQty)) {
        this.lockedDirection.delete(symbol);
        this.lockedBranch.delete(symbol);
      }

      if (this.sr.tradingEnabled) {
        const legTag = fill.legExposure ? '单腿' : '双腿';
        const quote = fill.quote ?? {};
        const legLines = [];
        if (fill.aFilledQty > 0) {
          legLines.push(formatFilledLegLine(
            'Binance',
            fill.aSide,
            quote.aBid,
            quote.aAsk,
            fill.aFillPrice ?? fill.aPrice,
            fill.aFilledQty,
            quote.aPriceNominal
          ));
        }
        if (fill.bFilledQty > 0) {
          legLines.push(formatFilledLegLine(
            'Gate',
            fill.bSide,
            quote.bBid,
            quote.bAsk,
            fill.bFillPrice ?? fill.bPrice,
            fill.bFilledQty,
            quote.bPriceNominal
          ));
        }
        const pnlTag = fill.pnlComplete === false || netPnl == null
          ? 'pnl=待确认(未拿到成交fee)'
          : `pnl=${netPnl.toFixed(4)} USDT`;
        console.log(
          `[实盘·成交·${legTag}] ${symbol} ${action} ${execDirection} ${pnlTag}`
        );
        for (const line of legLines) {
          console.log(line);
        }
        const gross = calcTradeGross(fill);
        const feeCost = calcTradeFeeCost(fill);
        if (netPnl != null && Number.isFinite(netPnl)) {
          if (gross != null && Number.isFinite(gross)) {
            console.log(
              `  实际利润 毛${gross >= 0 ? '+' : ''}${gross.toFixed(4)}`
              + ` · 净${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT（回执）`
              + ` · 手续费 -${feeCost.toFixed(4)}`
            );
          } else {
            console.log(`  实际利润 净${netPnl >= 0 ? '+' : ''}${netPnl.toFixed(4)} USDT（回执·单腿）`);
          }
        } else {
          console.warn(`  实际利润 未计入累计：成交 fee 回执未就绪，请稍后查交易所 my_trades`);
        }
        if (fill.aLeg?.filled) {
          const feeTag = fill.aLeg.pnlComplete === false ? 'fee待确认' : `fee ${Number(fill.aLeg.fee || 0).toFixed(4)}`;
          console.log(
            `  Binance USDT ${fill.aLeg.usdtChange >= 0 ? '+' : ''}${fill.aLeg.usdtChange.toFixed(4)}`
            + ` (${feeTag} · quote ${Number(fill.aLeg.quoteVolume || 0).toFixed(4)})`
          );
        }
        if (fill.bLeg?.filled) {
          const feeTag = fill.bLeg.pnlComplete === false ? 'fee待确认' : `fee ${Number(fill.bLeg.fee || 0).toFixed(4)}`;
          console.log(
            `  Gate USDT ${fill.bLeg.usdtChange >= 0 ? '+' : ''}${fill.bLeg.usdtChange.toFixed(4)}`
            + ` (${feeTag} · quote ${Number(fill.bLeg.quoteVolume || 0).toFixed(4)})`
          );
        }
        if (fill.legExposure) {
          const why = fill.failedLeg === 'binance'
            ? `Binance未成交: ${fill.failReason || '成交量为0'}`
            : fill.failedLeg === 'gate'
              ? `Gate未成交: ${fill.failReason || '成交量为0'}`
              : `A=${fill.aFilledQty} B=${fill.bFilledQty}`;
          console.warn(`[实盘·单腿风险] ${symbol} ${why}`);
        }
        for (const line of formatLatencyLogLines(latencyTrace)) {
          console.log(line);
        }
      }
      this.sr.eventBus.emitExecutionStatus({
        stage: 'TRADE_DONE',
        symbol,
        direction: execDirection,
        action,
        netPnl
      });
    } finally {
      await this.sr.reservationManager.releaseAll(reservations);
      if (tradeId) this.sr.reservationManager.markExecutionDone(tradeId);
      this.#releaseSymbolClaim(symbol);
      this.sr.inFlightCount -= 1;
    }
  }

  async refreshFunding(symbol) {
    try {
      const [fa, fb] = await Promise.all([
        this.sr.cexManager.getFundingRate('binance', symbol),
        this.sr.cexManager.getFundingRate('gate', symbol)
      ]);
      this.sr.quoteAggregator.setFunding(symbol, fa, fb);
    } catch {
      // ignore funding fetch errors
    }
  }
}

export default CexCexTask;
