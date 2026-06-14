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
  resolveLatencyLimits,
  analyzeLatencyFail,
  analyzeSignalAgeFail,
  analyzeFinalCheckFail,
  tickPriceSnapshot,
  tickPriceSlippagePass,
  describePriceSlippageFail
} from '../risk/risk-manager.js';
import { logTradeSkip } from '../monitoring/trade-skip-log.js';
import { appendTextLog } from '../../common/monitoring/append-text-log.js';
import { calcTradePnl, calcTradeGross, calcTradeFeeCost } from '../execution/result-reporter.js';
import {
  attachFillPricesToTrace,
  createTradeLatencyTrace,
  formatLatencyLogLines,
  formatPriceStageLines,
  markLatency,
  setFreshTickOnLatencyTrace
} from '../monitoring/trade-latency.js';
import { refreshTickFromRest } from '../services/quote-refresh.js';

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

function closeSideFromQty(qty) {
  if (qty > 0) return 'sell';
  if (qty < 0) return 'buy';
  return null;
}

export class CexCexTask {
  constructor(sharedResources, strategyConfig, precisionChecker) {
    this.sr = sharedResources;
    this.cfg = {
      ...strategyConfig,
      zOpen: strategyConfig.zOpen ?? strategyConfig.zOpenAb ?? 2.0,
      zClose: strategyConfig.zClose ?? 0.0,
      signalMaxAgeMs: strategyConfig.signalMaxAgeMs ?? 100
    };
    this.precision = precisionChecker;
    this.risk = new RiskManager(strategyConfig);
    this.engines = new Map();
    this.lastOrderTs = new Map();
    this.lockedDirection = new Map();
    this.lockedBranch = new Map();
    this.executingSymbols = new Set();
    this.forceClosingSymbols = new Set();
    /** 持仓失衡 warn 节流（每 symbol 30s 最多 1 条） */
    this._imbalanceWarnTs = new Map();
    /** 单边孤儿持仓 REST 对账节流（每 symbol 5s 最多 1 次） */
    this._reconcileTs = new Map();
    /** 强平触发价缓存（symbol -> { a, b, multiplier, updatedAt }） */
    this._forceCloseCache = new Map();
    /** 上一帧 signal，用于热路径先推 dashboard（对齐 stable：价格先更新，z-score 后算） */
    this._lastSignalBySymbol = new Map();
    this.enforceLatency = sharedResources.enforceLatency;
    this.latencyLimits = resolveLatencyLimits(this.cfg, this.enforceLatency);
    this.cexCost = resolveCexCostConfig(strategyConfig);
    this.logTradeSkips = strategyConfig.logTradeSkips !== false;
    this.logTradeSkipThrottleMs = strategyConfig.logTradeSkipThrottleMs ?? 10_000;
    this.strategyTextLogToConsole = strategyConfig.strategyTextLogToConsole === true;

    for (const sym of strategyConfig.symbols) {
      this.engines.set(sym, new RollingSignalEngine({
        windowSeconds: strategyConfig.windowSeconds,
        minDataPoints: strategyConfig.minDataPoints
      }));
      this.lastOrderTs.set(sym, 0);
    }
  }

  getStrategyConfig() {
    return this.cfg;
  }

  updateStrategyConfig(nextStrategyConfig = {}) {
    this.cfg = {
      ...nextStrategyConfig,
      zOpen: nextStrategyConfig.zOpen ?? nextStrategyConfig.zOpenAb ?? 2.0,
      zClose: nextStrategyConfig.zClose ?? 0.0,
      signalMaxAgeMs: nextStrategyConfig.signalMaxAgeMs ?? 100
    };
    this.risk = new RiskManager(this.cfg);
    this.latencyLimits = resolveLatencyLimits(this.cfg, this.enforceLatency);
    this.cexCost = resolveCexCostConfig(this.cfg);
    this.logTradeSkips = this.cfg.logTradeSkips !== false;
    this.logTradeSkipThrottleMs = this.cfg.logTradeSkipThrottleMs ?? 10_000;
    this.strategyTextLogToConsole = this.cfg.strategyTextLogToConsole === true;
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

  #logSkip(symbol, stage, reason) {
    const noisyThresholdStage = typeof stage === 'string' && stage.startsWith('z-score·');
    if (noisyThresholdStage) return;
    logTradeSkip(symbol, stage, reason, {
      enabled: this.logTradeSkips,
      throttleMs: this.logTradeSkipThrottleMs,
      tradingEnabled: this.sr.tradingEnabled,
      // 拦截类日志仅写文本文件，不镜像到控制台，避免刷屏。
      mirrorConsole: false
    });
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

  async #forceCloseSymbolNow(symbol, { aQty, bQty }) {
    const sym = String(symbol || '').replace(/[-_]/g, '').toUpperCase();
    if (!sym) return false;
    if (this.executingSymbols.has(sym)) return false;

    const aSide = closeSideFromQty(aQty);
    const bSide = closeSideFromQty(bQty);
    if (!aSide && !bSide) return false;

    this.executingSymbols.add(sym);
    this.forceClosingSymbols.add(sym);
    this.lastOrderTs.set(sym, Date.now());
    try {
      const cfg = this.precision?.minQtyBySymbol?.[sym] || {};
      const binanceStepSize = Number(cfg?.binance?.stepSize) || undefined;
      const gateCfg = cfg?.gate || {};
      const gateMult = Number(gateCfg?.quantoMultiplier);
      const gateDecimalSize = Boolean(gateCfg?.enableDecimal || gateCfg?.quantityUnit === 'base');
      const actions = [];

      if (aSide) {
        actions.push(this.sr.cexManager.placeOrder('binance', {
          symbol: sym,
          side: aSide,
          type: 'market',
          amount: Math.abs(aQty),
          stepSize: binanceStepSize,
          reduceOnly: true,
          positionDirection: aQty > 0 ? '+a-b' : '-a+b',
          positionSide: aQty > 0 ? 'LONG' : 'SHORT'
        }));
      }
      if (bSide) {
        const gateBaseQty = Math.abs(bQty);
        const gateContracts = gateMult > 0 ? (gateBaseQty / gateMult) : gateBaseQty;
        if (!(gateContracts > 0)) {
          console.error(
            `[FORCE_CLOSE] ${sym} gate 平仓量非法: base=${gateBaseQty} contracts=${gateContracts}`
          );
          return false;
        }
        actions.push(this.sr.cexManager.placeOrder('gate', {
          symbol: sym,
          side: bSide,
          type: 'market',
          amount: gateContracts,
          decimalSize: gateDecimalSize,
          reduceOnly: true
        }));
      }

      const results = await Promise.allSettled(actions);
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length > 0) {
        const msg = failed.map((r) => r.reason?.message || 'unknown').join(' | ');
        console.error(`[FORCE_CLOSE] ${sym} 强平提交失败: ${msg}`);
        return false;
      }

      await this.sr.accountCache.syncSymbolPositionsAfterFill(this.sr.cexManager, sym, {
        retries: 8,
        delayMs: 500
      });
      await this.#refreshForceCloseCache(sym);
      const afterA = this.sr.accountCache.getPosition('binance', sym);
      const afterB = this.sr.accountCache.getPosition('gate', sym);
      this.#clearLocksIfFlat(sym);
      console.warn(`[FORCE_CLOSE] ${sym} 强平完成，仓位 A=${afterA} B=${afterB}`);
      return true;
    } finally {
      this.forceClosingSymbols.delete(sym);
      this.executingSymbols.delete(sym);
    }
  }

  async #refreshForceCloseCache(symbol) {
    const multiplier = Number(this.cfg.forceClosePriceMultiplier);
    const sym = String(symbol || '').replace(/[-_]/g, '').toUpperCase();
    if (!sym) return;
    if (!(multiplier > 1) || this.sr.useMockAccount) {
      this._forceCloseCache.delete(sym);
      return;
    }

    const key = String(sym).replace(/[-_]/g, '');
    const [binRows, gateRows] = await Promise.all([
      this.sr.cexManager.getPositions('binance', { silent: true }).catch(() => []),
      this.sr.cexManager.getPositions('gate', { silent: true }).catch(() => [])
    ]);
    const aPos = (binRows || []).find((p) => String(p.symbol).replace(/[-_]/g, '') === key) || null;
    const bPos = (gateRows || []).find((p) => String(p.symbol).replace(/[-_]/g, '') === key) || null;

    const aEntry = Number(aPos?.entryPrice || 0);
    const bEntry = Number(bPos?.entryPrice || 0);
    const aQty = Number(aPos?.qty || 0);
    const bQty = Number(bPos?.qty || 0);
    const hasA = Math.abs(aQty) > 1e-12 && aEntry > 0;
    const hasB = Math.abs(bQty) > 1e-12 && bEntry > 0;
    if (!hasA && !hasB) {
      this._forceCloseCache.delete(sym);
      return;
    }

    this._forceCloseCache.set(sym, {
      multiplier,
      updatedAt: Date.now(),
      // 亏损保护触发：
      // - 多仓(qty>0)：价格跌到 entry/multiplier
      // - 空仓(qty<0)：价格涨到 entry*multiplier
      a: hasA
        ? {
            qty: aQty,
            entryPrice: aEntry,
            triggerPrice: aQty > 0 ? (aEntry / multiplier) : (aEntry * multiplier),
            triggerOp: aQty > 0 ? '<=' : '>='
          }
        : null,
      b: hasB
        ? {
            qty: bQty,
            entryPrice: bEntry,
            triggerPrice: bQty > 0 ? (bEntry / multiplier) : (bEntry * multiplier),
            triggerOp: bQty > 0 ? '<=' : '>='
          }
        : null
    });
  }

  async #forceCloseByEntryMultiplierIfNeeded(symbol, tick) {
    const multiplier = Number(this.cfg.forceClosePriceMultiplier);
    if (!(multiplier > 1) || this.sr.useMockAccount || this.executingSymbols.has(symbol)) return false;
    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    if (isFlatPosition(aQty, bQty)) {
      this._forceCloseCache.delete(symbol);
      return false;
    }

    const cache = this._forceCloseCache.get(symbol);
    if (!cache) return false;
    const midA = Number(tick?.aBid) > 0 && Number(tick?.aAsk) > 0 ? (Number(tick.aBid) + Number(tick.aAsk)) / 2 : 0;
    const midB = Number(tick?.bBid) > 0 && Number(tick?.bAsk) > 0 ? (Number(tick.bBid) + Number(tick.bAsk)) / 2 : 0;
    const aTrigger = Number(cache?.a?.triggerPrice || 0);
    const bTrigger = Number(cache?.b?.triggerPrice || 0);
    const aOp = cache?.a?.triggerOp || '>=';
    const bOp = cache?.b?.triggerOp || '>=';
    const aHit = aTrigger > 0 && midA > 0 && (aOp === '<=' ? midA <= aTrigger : midA >= aTrigger);
    const bHit = bTrigger > 0 && midB > 0 && (bOp === '<=' ? midB <= bTrigger : midB >= bTrigger);
    if (!aHit && !bHit) return false;

    console.warn(
      `[FORCE_CLOSE] ${symbol} 触发价格阈值强平: `
      + `A ${midA.toFixed(8)} ${aOp} ${aTrigger > 0 ? aTrigger.toFixed(8) : '-'} `
      + `B ${midB.toFixed(8)} ${bOp} ${bTrigger > 0 ? bTrigger.toFixed(8) : '-'} `
      + `(multiplier=${multiplier})`
    );
    await this.#forceCloseSymbolNow(symbol, { aQty, bQty });
    // 只要触发了强平阈值，本次 tick 就不再继续正常交易流程。
    return true;
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
    const prevSignal = this._lastSignalBySymbol.get(symbol) ?? null;
    const latencyAtSignal = analyzeLatencyFail(tick, this.latencyLimits);

    // 对齐 stable handlePriceUpdate：先推价格/UI，不 await REST 对账、不挡 WS 热路径
    this.sr.dashboardBridge?.updateMarketSnapshot({
      symbol,
      tick,
      spreads,
      signal: prevSignal,
      lock: this.#syncLockState(symbol, prevSignal)
    });

    // 强平执行期间，该币种忽略所有新信号，避免与下一轮交易交叉。
    if (this.forceClosingSymbols.has(symbol)) {
      this.#logSkip(symbol, '强平中', '等待当前强平流程完成，忽略本轮信号');
      return;
    }

    // 对齐 stable：陈旧帧不参与信号计算，避免窗口被 stale tick 污染并拖慢长窗口运行。
    if (this.enforceLatency && !latencyAtSignal.pass) {
      this.#logSkip(symbol, '延迟·信号前', latencyAtSignal.reason);
      return;
    }

    const signal = engine.updateAndCalc({
      timestamp: tick.timestamp,
      spreadAb: spreads.spreadAb,
      spreadBa: spreads.spreadBa,
      spreadAbAdj: spreads.spreadAbAdj,
      spreadBaAdj: spreads.spreadBaAdj
    });
    this._lastSignalBySymbol.set(symbol, signal);

    this.#reconcileStalePositionsIfNeeded(symbol).catch(() => {});

    if (await this.#forceCloseByEntryMultiplierIfNeeded(symbol, tick)) {
      return;
    }

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

    if (!signal.windowReady || signal.openZAb == null || signal.openZBa == null) return;

    if (tick.fundingA != null && tick.fundingA < this.cfg.fundingMin) {
      this.#logSkip(
        symbol,
        '资金费率',
        `Binance funding=${tick.fundingA} < 下限${this.cfg.fundingMin}`
          + ` (低${(this.cfg.fundingMin - tick.fundingA).toFixed(4)})`
      );
      return;
    }
    if (tick.fundingB != null && tick.fundingB < this.cfg.fundingMin) {
      this.#logSkip(
        symbol,
        '资金费率',
        `Gate funding=${tick.fundingB} < 下限${this.cfg.fundingMin}`
          + ` (低${(this.cfg.fundingMin - tick.fundingB).toFixed(4)})`
      );
      return;
    }

    const sinceOrder = Date.now() - this.lastOrderTs.get(symbol);
    if (sinceOrder < this.cfg.cooldownMs) return;
    if (this.executingSymbols.has(symbol)) return;
    const maxInFlight = Number(this.cfg.maxInFlightTrades);
    if (Number.isFinite(maxInFlight) && maxInFlight > 0 && this.sr.inFlightCount >= maxInFlight) {
      this.#logSkip(
        symbol,
        '在途笔数',
        `inFlight=${this.sr.inFlightCount} >= 上限${maxInFlight}`
          + ` (超出${this.sr.inFlightCount - maxInFlight})`
      );
      return;
    }

    let tradePlan = null;

    if (lock.flat) {
      tradePlan = pickOpenFromFlat(signal, this.cfg.zOpen);
      if (!tradePlan) {
        this.#logSkip(
          symbol,
          'z-score·开仓',
          `openZAb=${signal.openZAb?.toFixed(3) ?? '?'} openZBa=${signal.openZBa?.toFixed(3) ?? '?'}`
            + ` < zOpen=${this.cfg.zOpen}`
        );
      }
    } else if (lock.direction && lock.branch) {
      const { openZ, closeZ } = lockedZValues(signal, lock.direction, lock.branch);
      const decision = decideAddOrClose(openZ, closeZ, this.cfg.zOpen, this.cfg.zClose);
      if (!decision) {
        this.#logSkip(
          symbol,
          'z-score·加仓平仓',
          `openZ=${openZ?.toFixed(3) ?? '?'} closeZ=${closeZ?.toFixed(3) ?? '?'}`
            + ` 未达 zOpen=${this.cfg.zOpen} / zClose=${this.cfg.zClose}`
        );
        return;
      }

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
      this.#logSkip(symbol, '持仓锁', '有持仓但 direction/branch 未就绪，跳过');
      return;
    }

    if (!tradePlan) return;

    const isClose = tradePlan.action === 'close';
    const execDirection = isClose ? closeTradeDirection(tradePlan.direction) : tradePlan.direction;
    const spreadFilterDir = tradePlan.spreadFilterDirection ?? tradePlan.direction;
    const filterSpread = spreadFilterDir === '-a+b' ? spreads.spreadAbAdj : spreads.spreadBaAdj;

    const finalAtSignal = analyzeFinalCheckFail(tick, filterSpread, this.latencyLimits);
    if (!finalAtSignal.pass) {
      this.#logSkip(symbol, `终检·${tradePlan.action}`, finalAtSignal.reason);
      return;
    }

    const orderBuild = this.precision.buildOrder({
      direction: execDirection,
      tick,
      orderUsd: this.cfg.orderUsd
    });
    if (orderBuild.qty <= 0) {
      this.#logSkip(symbol, '下单量', `buildOrder qty=${orderBuild.qty} <= 0`);
      return;
    }

    let orderForExec = orderBuild;
    let qty = orderBuild.qty;
    if (isClose) {
      // 平仓按“配置档位”一一对冲，不再自动裁剪到更小数量（如 70 -> 60）。
      // 若任一腿持仓不足该档位，则本次跳过，避免产生非预期平仓量。
      const holdA = Math.abs(this.sr.accountCache.getPosition('binance', symbol));
      const holdB = Math.abs(this.sr.accountCache.getPosition('gate', symbol));
      if (holdA + 1e-12 < qty || holdB + 1e-12 < qty) {
        this.#logSkip(
          symbol,
          '平仓量',
          `配置档位 qty=${qty}，持仓不足 A=${holdA} B=${holdB}，本次不降档平仓`
        );
        return;
      }
      orderForExec = orderBuild;
    } else {
      const clipped = this.risk.clipQty(qty, tick, execDirection, this.sr.accountCache);
      const finalized = this.precision.finalizeOpenOrder({
        direction: execDirection,
        tick,
        clippedQty: clipped,
        orderUsd: this.cfg.orderUsd
      });
      if (!finalized) {
        this.#logSkip(symbol, '开仓量', 'finalizeOpenOrder 未达两腿最小可成交量');
        return;
      }
      orderForExec = finalized;
      qty = finalized.qty;
    }

    const priceSnapshot = tickPriceSnapshot(symbol, tick);
    const latencyTrace = createTradeLatencyTrace(tick, {
      direction: execDirection,
      priceSnapshot
    });
    markLatency(latencyTrace, 'prep_done');

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
        } catch (err) {
          this.#logSkip(symbol, '刷账户', `ensureFresh 失败: ${err?.message || err}`);
          return;
        }
      }
    }
    markLatency(latencyTrace, 'account_fresh_done');

    const signalAgeCheck = analyzeSignalAgeFail(tick, this.latencyLimits.signalMaxAgeMs);
    if (this.enforceLatency && !signalAgeCheck.pass) {
      this.#logSkip(symbol, '信号时效', signalAgeCheck.reason);
      return;
    }

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
      const reserveReason = this.sr.reservationManager.describeReserveFail({
        symbol,
        qty,
        aNeed,
        bNeed,
        maxPositionQty: maxPosQty,
        increasesAbs
      });
      this.#logSkip(symbol, `预占·${tradePlan.action}`, reserveReason);
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
    const mirror = false;
    if (reason) {
      appendTextLog(`[延迟·中止] ${reason}`, { level: 'warn', mirrorConsole: mirror });
      if (partial) {
        for (const line of formatLatencyLogLines(trace)) {
          appendTextLog(line, { level: 'warn', mirrorConsole: mirror });
        }
      }
      return;
    }
    for (const line of formatLatencyLogLines(trace)) {
      appendTextLog(line, { level: 'log', mirrorConsole: mirror });
    }
  }

  #logFailurePriceAndLatency(symbol, reason, trace) {
    if (!this.sr.tradingEnabled) return;
    console.warn(`[实盘·失败] ${symbol} ${reason}`);
    for (const line of formatPriceStageLines(trace)) {
      console.warn(line);
    }
    for (const line of formatLatencyLogLines(trace)) {
      console.warn(line);
    }
  }

  async #forceRollbackAddExposure(symbol, fill, order) {
    if (!fill?.legExposure) {
      return { attempted: false };
    }
    const aFilled = Number(fill.aFilledQty) || 0;
    const bFilled = Number(fill.bFilledQty) || 0;
    const eps = 1e-9;
    let rollbackPlan = null;

    const binanceStepSize = Number(order?.cfg?.binance?.stepSize) || undefined;
    const gateDecimalSize = Boolean(order?.gateDecimalSize);
    const gateMult = Number(order?.gateQuantoMultiplier);
    const gateBaseToContracts = (baseQty) => {
      if (!(baseQty > 0)) return 0;
      if (Number.isFinite(gateMult) && gateMult > 0) return baseQty / gateMult;
      return baseQty;
    };

    const buildBinanceRollback = (baseQty, filledSide) => {
      if (!(baseQty > eps)) return;
      const openLong = filledSide === 'buy';
      const side = openLong ? 'sell' : 'buy';
      rollbackPlan = {
        exchange: 'binance',
        side,
        amount: baseQty,
        order: {
          symbol,
          side,
          type: 'market',
          amount: baseQty,
          stepSize: binanceStepSize,
          reduceOnly: true,
          positionDirection: openLong ? '+a-b' : '-a+b',
          positionSide: openLong ? 'LONG' : 'SHORT'
        }
      };
    };

    const buildGateRollback = (baseQty, filledSide) => {
      if (!(baseQty > eps)) return;
      const contracts = gateBaseToContracts(baseQty);
      if (!(contracts > eps)) return;
      const side = filledSide === 'buy' ? 'sell' : 'buy';
      rollbackPlan = {
        exchange: 'gate',
        side,
        amount: baseQty,
        order: {
          symbol,
          side,
          type: 'market',
          amount: contracts,
          decimalSize: gateDecimalSize,
          reduceOnly: true
        }
      };
    };

    if (aFilled > eps && bFilled <= eps) {
      // 严格按“刚刚成交量”回滚，不做差额推导
      buildBinanceRollback(aFilled, fill.aSide);
    } else if (bFilled > eps && aFilled <= eps) {
      // 严格按“刚刚成交量”回滚，不做差额推导
      buildGateRollback(bFilled, fill.bSide);
    }

    if (!rollbackPlan) {
      return { attempted: false };
    }

    console.warn(
      `[ADD_ROLLBACK] ${symbol} 加仓出现单腿，按成交量原量平仓`
      + ` (${rollbackPlan.exchange} ${rollbackPlan.side} qty=${rollbackPlan.amount})`
    );
    try {
      await this.sr.cexManager.placeOrder(rollbackPlan.exchange, rollbackPlan.order);
    } catch (err) {
      const msg = err?.message || 'unknown';
      console.error(`[ADD_ROLLBACK] ${symbol} 自动回滚失败: ${msg}`);
      return { attempted: true, ok: false, error: msg };
    }

    await this.sr.accountCache.syncSymbolPositionsAfterFill(this.sr.cexManager, symbol, {
      retries: 8,
      delayMs: 500
    });
    const aQty = this.sr.accountCache.getPosition('binance', symbol);
    const bQty = this.sr.accountCache.getPosition('gate', symbol);
    console.warn(`[ADD_ROLLBACK] ${symbol} 自动回滚完成，当前仓位 A=${aQty} B=${bQty}`);
    return { attempted: true, ok: true, aQty, bQty };
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
      const restBeforeOrder = this.cfg.restRefreshBeforeOrder === true;
      const freshTick = restBeforeOrder
        ? await refreshTickFromRest(this.sr.cexManager, this.sr.quoteAggregator, symbol)
        : this.sr.quoteAggregator.buildTick(symbol);
      const latencyAtExec = analyzeLatencyFail(freshTick, this.latencyLimits);
      const latencyOk = !this.enforceLatency || latencyAtExec.pass;
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
        const skipReason = !freshTick
          ? '无行情（发单前 buildTick 失败）'
          : !latencyOk
            ? latencyAtExec.reason
            : describePriceSlippageFail(slipCheck) || 'WS 价格超过滑点';
        const skipStage = !freshTick
          ? '发单前·无行情'
          : !latencyOk
            ? '发单前·延迟'
            : '发单前·滑点';
        this.#logSkip(symbol, skipStage, skipReason);
        this.#logLatency(latencyTrace, { reason: skipReason, partial: true });
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      const finalAtExec = analyzeFinalCheckFail(freshTick, adjSpread, this.latencyLimits);
      if (!finalAtExec.pass) {
        this.#logSkip(symbol, '发单前·终检', finalAtExec.reason);
        this.#logLatency(latencyTrace, { reason: finalAtExec.reason });
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
        this.#logFailurePriceAndLatency(symbol, `下单失败: ${err.message}`, latencyTrace);
        console.error(`[CexCexTask] ${symbol} 下单失败:`, err.message);
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      const hasAnyFill = fill.aFilledQty > 0 || fill.bFilledQty > 0;
      if (!fill.simulated && !hasAnyFill) {
        this.#logLatency(latencyTrace, { reason: '两腿均未成交' });
        this.#logFailurePriceAndLatency(symbol, '两腿均未成交', latencyTrace);
        this.#releaseSymbolClaim(symbol, { restoreCooldown: true });
        return;
      }

      if (action === 'add' && fill.legExposure) {
        await this.#forceRollbackAddExposure(symbol, fill, order);
      }

      this.sr.accountCache.applyFillToCache(symbol, execDirection, fill);

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

      const netPnl = calcTradePnl(fill);
      attachFillPricesToTrace(latencyTrace, fill);

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
        for (const line of formatPriceStageLines(latencyTrace)) {
          console.log(line);
        }
        for (const line of formatLatencyLogLines(latencyTrace)) {
          console.log(line);
        }
      }
      this.#refreshForceCloseCache(symbol).catch(() => {});
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

  async manualSyncSymbolPosition(symbol) {
    const sym = String(symbol || '').replace(/[-_]/g, '').toUpperCase();
    if (!sym) return { ok: false, error: 'invalid_symbol' };
    if (this.sr.useMockAccount) {
      return { ok: false, symbol: sym, error: 'mock account mode does not support position sync' };
    }
    if (this.executingSymbols.has(sym)) {
      return { ok: false, symbol: sym, error: `${sym} executing, try later` };
    }

    await this.sr.accountCache.reconcileSymbolPositions(this.sr.cexManager, sym);
    await this.#refreshForceCloseCache(sym).catch(() => {});
    const aQty = this.sr.accountCache.getPosition('binance', sym);
    const bQty = this.sr.accountCache.getPosition('gate', sym);
    const inferred = inferDirectionFromPosition(aQty, bQty);

    if (isFlatPosition(aQty, bQty)) {
      this.lockedDirection.delete(sym);
      this.lockedBranch.delete(sym);
      return { ok: true, symbol: sym, aQty, bQty, flat: true, direction: null };
    }

    if (inferred) {
      this.lockedDirection.set(sym, inferred);
      this.lockedBranch.delete(sym);
      return {
        ok: true,
        symbol: sym,
        aQty,
        bQty,
        flat: false,
        hedged: isHedgedPosition(aQty, bQty),
        direction: inferred
      };
    }

    this.lockedDirection.delete(sym);
    this.lockedBranch.delete(sym);
    return {
      ok: true,
      symbol: sym,
      aQty,
      bQty,
      flat: false,
      hedged: false,
      direction: null,
      warning: 'position_imbalanced'
    };
  }

}

export default CexCexTask;
