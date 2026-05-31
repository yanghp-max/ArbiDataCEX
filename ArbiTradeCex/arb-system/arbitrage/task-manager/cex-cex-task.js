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
  inferDirectionFromPosition
} from '../services/spread-calculator.js';
import { PrecisionChecker, RiskManager, finalCheckPass } from '../risk/risk-manager.js';
import { calcTradePnl } from '../execution/result-reporter.js';

export class CexCexTask {
  constructor(sharedResources, strategyConfig, precisionChecker) {
    this.sr = sharedResources;
    this.cfg = {
      ...strategyConfig,
      zOpen: strategyConfig.zOpen ?? strategyConfig.zOpenAb ?? 2.0,
      zClose: strategyConfig.zClose ?? 0.0
    };
    this.precision = precisionChecker;
    this.risk = new RiskManager(strategyConfig);
    this.engines = new Map();
    this.lastOrderTs = new Map();
    this.lockedDirection = new Map();
    this.lockedBranch = new Map();
    this.totalCostPct = (strategyConfig.feeBpsTotal + strategyConfig.slippageBpsTotal) / 100;

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

    if (isFlatPosition(aQty, bQty)) {
      this.lockedDirection.delete(symbol);
      this.lockedBranch.delete(symbol);
      return { flat: true, direction: null, branch: null };
    }

    let direction = this.lockedDirection.get(symbol) ?? inferDirectionFromPosition(aQty, bQty);
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

  async onTick(symbol) {
    const tick = this.sr.quoteAggregator.buildTick(symbol);
    const engine = this.engines.get(symbol);

    if (!tick) {
      this.sr.dashboardBridge?.updateMarketSnapshot({ symbol, tick: null, spreads: null, signal: null, lock: null });
      return;
    }

    const spreads = calcSpreads(tick, this.totalCostPct);
    const signal = engine.updateAndCalc({
      timestamp: tick.timestamp,
      spreadAb: spreads.spreadAb,
      spreadBa: spreads.spreadBa,
      spreadAbAdj: spreads.spreadAbAdj,
      spreadBaAdj: spreads.spreadBaAdj
    });

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

    if (tick.priceAgeMs > this.cfg.maxPriceAgeMs) return;
    if (!signal.windowReady || signal.openZAb == null || signal.openZBa == null) return;

    if (tick.fundingA != null && tick.fundingA < this.cfg.fundingMin) return;
    if (tick.fundingB != null && tick.fundingB < this.cfg.fundingMin) return;

    if (Date.now() - this.lastOrderTs.get(symbol) < this.cfg.cooldownMs) return;
    if (this.sr.inFlightCount >= this.cfg.maxInFlightTrades) return;

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

    const isClose = tradePlan.action === 'close';
    const execDirection = isClose ? closeTradeDirection(tradePlan.direction) : tradePlan.direction;
    const spreadFilterDir = tradePlan.spreadFilterDirection ?? tradePlan.direction;
    const filterSpread = spreadFilterDir === '-a+b' ? spreads.spreadAbAdj : spreads.spreadBaAdj;

    if (!finalCheckPass(tick, spreadFilterDir, filterSpread, this.cfg.maxPriceAgeMs)) return;

    const orderBuild = this.precision.buildOrder({
      direction: execDirection,
      tick,
      orderUsd: this.cfg.orderUsd
    });
    if (orderBuild.qty <= 0) return;

    let qty = orderBuild.qty;
    if (isClose) {
      qty = this.risk.clipCloseQty(qty, tick, this.sr.accountCache);
    } else {
      qty = this.risk.clipQty(qty, tick, execDirection, this.sr.accountCache);
    }
    if (qty <= 0) return;

    const posBefore = {
      a: this.sr.accountCache.getPosition('binance', symbol),
      b: this.sr.accountCache.getPosition('gate', symbol)
    };
    const increasesAbs = !isClose && this.risk.wouldIncreaseAbs(posBefore, execDirection, qty);
    const maxPosQty = this.risk.maxPositionQty(tick, isClose ? tradePlan.direction : execDirection);
    const { aNeed, bNeed } = this.precision.calcUsdtNeed(execDirection, qty, tick, this.cfg.balanceCheckRate);

    const tradeId = `${symbol}_${Date.now()}`;
    const reservations = await this.sr.reservationManager.tryReserve({
      tradeId,
      symbol,
      direction: execDirection,
      qty,
      aNeed,
      bNeed,
      maxPositionQty: maxPosQty,
      increasesAbs
    });

    if (!reservations) {
      this.sr.eventBus.emitExecutionStatus({ stage: 'RESERVE_FAILED', symbol, direction: execDirection });
      return;
    }

    this.sr.inFlightCount += 1;
    this.executeAsync({
      symbol,
      action: tradePlan.action,
      lockedDirection: tradePlan.direction,
      execDirection,
      branch: tradePlan.branch,
      tick,
      order: { ...orderBuild, qty },
      adjSpread: filterSpread,
      openZ: tradePlan.openZ,
      closeZ: tradePlan.closeZ,
      reservations
    }).catch((err) => console.error(`[CexCexTask] execute error ${symbol}:`, err.message));
  }

  async executeAsync(ctx) {
    const {
      symbol,
      action,
      lockedDirection,
      execDirection,
      branch,
      tick,
      order,
      adjSpread,
      reservations
    } = ctx;
    try {
      if (!finalCheckPass(tick, execDirection, adjSpread, this.cfg.maxPriceAgeMs)) {
        this.sr.eventBus.emitExecutionStatus({ stage: 'FINAL_SKIP', symbol });
        return;
      }

      const fill = await this.sr.orderExecutor.executeBothLegs({ direction: execDirection, tick, order });
      const pnlDirection = action === 'close' ? lockedDirection : execDirection;
      const netPnl = calcTradePnl(fill, pnlDirection, this.cfg.feeBpsTotal, this.cfg.slippageBpsTotal);

      this.sr.resultReporter.recordTrade({
        symbol,
        direction: execDirection,
        action,
        lockedDirection,
        fill,
        netPnl,
        accountCache: this.sr.accountCache,
        dashboardBridge: this.sr.dashboardBridge
      });
      this.lastOrderTs.set(symbol, Date.now());

      if (!fill.simulated) {
        await this.sr.accountCache.refreshFromCexManager(this.sr.cexManager);
      }

      const aQty = this.sr.accountCache.getPosition('binance', symbol);
      const bQty = this.sr.accountCache.getPosition('gate', symbol);
      if (action === 'open') {
        this.lockedDirection.set(symbol, lockedDirection ?? execDirection);
        this.lockedBranch.set(symbol, branch);
      } else if (action === 'close' && isFlatPosition(aQty, bQty)) {
        this.lockedDirection.delete(symbol);
        this.lockedBranch.delete(symbol);
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
