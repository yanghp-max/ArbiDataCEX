/**
 * 共享资源（对标 shared-resources.js）
 */
import { CexManager } from '../../cex/manager.js';
import { AccountCache, ReservationManager } from '../cache/index.js';
import { OrderExecutor } from '../execution/order-executor.js';
import { ResultReporter } from '../execution/result-reporter.js';
import { QuoteAggregator } from '../services/quote-aggregator.js';
import eventBus from '../event-bus/index.js';

export class SharedResources {
  constructor(config, options = {}) {
    this.config = config;
    this.tradingEnabled = options.tradingEnabled ?? false;
    this.cexManager = null;
    this.accountCache = new AccountCache();
    this.quoteAggregator = new QuoteAggregator();
    this.reservationManager = null;
    this.orderExecutor = null;
    this.resultReporter = new ResultReporter();
    this.eventBus = eventBus;
    this.inFlightCount = 0;
    this.useMockAccount = false;
  }

  async init() {
    this.cexManager = await CexManager.createDefault();
    const binance = this.cexManager.get('binance');
    const gate = this.cexManager.get('gate');
    const strat = this.config.strategy;
    this.useMockAccount = Boolean(strat.useMockAccount) && !this.tradingEnabled;

    if (this.useMockAccount) {
      const balanceUsdt = Number(strat.mockBalanceUsdt) || 10000;
      this.accountCache.seedMock({ balanceUsdt });
      console.log(`[SharedResources] mock account: ${balanceUsdt} USDT per exchange (skip balance REST)`);
    } else {
      await this.accountCache.refreshFromAdapters(binance, gate);
    }

    this.accountCache.minAvailableUsdt = strat.minAvailableUsdt;
    this.reservationManager = new ReservationManager({
      accountCache: this.accountCache,
      ttlMs: this.config.strategy.reservationTtlMs
    });
    this.orderExecutor = new OrderExecutor({
      binanceAdapter: binance,
      gateAdapter: gate,
      tradingEnabled: this.tradingEnabled
    });
  }

  getBinance() {
    return this.cexManager.get('binance');
  }

  getGate() {
    return this.cexManager.get('gate');
  }

  async shutdown() {
    await Promise.all([
      this.getBinance()?.disconnect(),
      this.getGate()?.disconnect()
    ]);
  }
}

export default SharedResources;
