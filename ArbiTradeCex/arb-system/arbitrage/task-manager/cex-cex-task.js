/**
 * CEX-CEX 任务：多 symbol、预占、drop-fast
 */
import { RollingSignalEngine } from '../calculator/rolling-signal-engine.js';
import { calcSpreads, pickDirection } from '../services/spread-calculator.js';
import { PrecisionChecker, RiskManager, finalCheckPass } from '../risk/risk-manager.js';
import { calcTradePnl } from '../execution/result-reporter.js';

export class CexCexTask {
  constructor(sharedResources, strategyConfig, precisionChecker) {
    this.sr = sharedResources;
    this.cfg = strategyConfig;
    this.precision = precisionChecker;
    this.risk = new RiskManager(strategyConfig);
    this.engines = new Map();
    this.lastOrderTs = new Map();
    this.totalCostPct = (strategyConfig.feeBpsTotal + strategyConfig.slippageBpsTotal) / 100;

    for (const sym of strategyConfig.symbols) {
      this.engines.set(sym, new RollingSignalEngine({
        windowSeconds: strategyConfig.windowSeconds,
        minDataPoints: strategyConfig.minDataPoints
      }));
      this.lastOrderTs.set(sym, 0);
    }
  }

  async onTick(symbol) {
    const tick = this.sr.quoteAggregator.buildTick(symbol);
    const engine = this.engines.get(symbol);

    if (!tick) {
      this.sr.dashboardBridge?.updateMarketSnapshot({ symbol, tick: null, spreads: null, signal: null });
      return;
    }

    const spreads = calcSpreads(tick, this.totalCostPct);
    const signal = engine.updateAndCalc({
      timestamp: tick.timestamp,
      spreadAbAdj: spreads.spreadAbAdj,
      spreadBaAdj: spreads.spreadBaAdj
    });
    this.sr.dashboardBridge?.updateMarketSnapshot({ symbol, tick, spreads, signal });

    if (tick.priceAgeMs > this.cfg.maxPriceAgeMs) return;

    if (!signal.windowReady || signal.zAb == null || signal.zBa == null) return;

    if (tick.fundingA != null && tick.fundingA < this.cfg.fundingMin) return;
    if (tick.fundingB != null && tick.fundingB < this.cfg.fundingMin) return;

    const picked = pickDirection(signal, spreads.spreadAbAdj, spreads.spreadBaAdj, this.cfg.zOpenAb, this.cfg.zOpenBa);
    if (!picked) return;

    const { direction, adjSpread, zUsed } = picked;
    if (Date.now() - this.lastOrderTs.get(symbol) < this.cfg.cooldownMs) return;
    if (this.sr.inFlightCount >= this.cfg.maxInFlightTrades) return;

    const orderBuild = this.precision.buildOrder({ direction, tick, orderUsd: this.cfg.orderUsd });
    if (orderBuild.qty <= 0) return;

    let qty = this.risk.clipQty(orderBuild.qty, tick, direction, this.sr.accountCache);
    if (qty <= 0) return;

    const posBefore = {
      a: this.sr.accountCache.getPosition('binance', symbol),
      b: this.sr.accountCache.getPosition('gate', symbol)
    };
    const increasesAbs = this.risk.wouldIncreaseAbs(posBefore, direction, qty);
    const maxPosQty = this.risk.maxPositionQty(tick, direction);
    const { aNeed, bNeed } = this.precision.calcUsdtNeed(direction, qty, tick, this.cfg.balanceCheckRate);

    const tradeId = `${symbol}_${Date.now()}`;
    const reservations = await this.sr.reservationManager.tryReserve({
      tradeId,
      symbol,
      direction,
      qty,
      aNeed,
      bNeed,
      maxPositionQty: maxPosQty,
      increasesAbs
    });

    if (!reservations) {
      this.sr.eventBus.emitExecutionStatus({ stage: 'RESERVE_FAILED', symbol, direction });
      return;
    }

    this.sr.inFlightCount += 1;
    this.executeAsync({ symbol, direction, tick, order: { ...orderBuild, qty }, adjSpread, zUsed, reservations })
      .catch((err) => console.error(`[CexCexTask] execute error ${symbol}:`, err.message));
  }

  async executeAsync(ctx) {
    const { symbol, direction, tick, order, adjSpread, reservations } = ctx;
    try {
      if (!finalCheckPass(tick, direction, adjSpread, this.cfg.maxPriceAgeMs)) {
        this.sr.eventBus.emitExecutionStatus({ stage: 'FINAL_SKIP', symbol });
        return;
      }

      const fill = await this.sr.orderExecutor.executeBothLegs({ direction, tick, order });
      const netPnl = calcTradePnl(fill, direction, this.cfg.feeBpsTotal, this.cfg.slippageBpsTotal);
      this.sr.resultReporter.recordTrade({
        symbol,
        direction,
        fill,
        netPnl,
        accountCache: this.sr.accountCache,
        dashboardBridge: this.sr.dashboardBridge
      });
      this.lastOrderTs.set(symbol, Date.now());

      if (!fill.simulated) {
        await this.sr.accountCache.refreshFromAdapters(this.sr.getBinance(), this.sr.getGate());
      }
      this.sr.eventBus.emitExecutionStatus({ stage: 'TRADE_DONE', symbol, direction, netPnl });
    } finally {
      await this.sr.reservationManager.releaseAll(reservations);
      this.sr.inFlightCount -= 1;
    }
  }

  async refreshFunding(symbol) {
    try {
      const [fa, fb] = await Promise.all([
        this.sr.getBinance().getFundingRate(symbol),
        this.sr.getGate().getFundingRate(symbol)
      ]);
      this.sr.quoteAggregator.setFunding(symbol, fa, fb);
    } catch {
      // ignore funding fetch errors
    }
  }
}

export default CexCexTask;
