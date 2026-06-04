/**
 * TaskManager（对标 arbitrage/task-manager/index.js）
 */
import path from 'node:path';
import { loadConfig, getRootDir } from '../../config/global-config.js';
import { EventTypes } from '../../cex/types.js';
import { SharedResources } from './shared-resources.js';
import { CexCexTask } from './cex-cex-task.js';
import { PrecisionChecker } from '../risk/risk-manager.js';

export class TaskManager {
  constructor(options = {}) {
    this.config = options.config || loadConfig();
    this.tradingEnabled = options.tradingEnabled ?? false;
    this.sharedResources = null;
    this.task = null;
    this.fundingTimer = null;
    this.tickTimer = null;
  }

  async start() {
    const rootDir = getRootDir();
    const strat = this.config.strategy;
    const minQtyPath = path.isAbsolute(strat.minQtyJson)
      ? strat.minQtyJson
      : path.resolve(rootDir, strat.minQtyJson);

    this.sharedResources = new SharedResources(this.config, {
      tradingEnabled: this.tradingEnabled
    });
    await this.sharedResources.init();

    const precision = await PrecisionChecker.loadFromJson(minQtyPath, strat.symbols, {
      orderUsd: strat.orderUsd,
      minOrderLotQtySymbols: strat.minOrderLotQtySymbols
    });
    this.task = new CexCexTask(this.sharedResources, strat, precision);

    const cexManager = this.sharedResources.cexManager;
    const adapterSymbols = strat.symbols.map((s) => cexManager.normalizeSymbol('binance', s));

    const binance = cexManager.getAdapter('binance');
    const gate = cexManager.getAdapter('gate');

    // 对齐 ArbiTrade-1：WS 只更新行情缓存；策略 tick 由定时器统一驱动（避免 WS+timer 双触发并发）
    binance.on(EventTypes.TICKER, (t) => {
      const symbol = t.symbol.replace('-', '');
      this.sharedResources.quoteAggregator.onTicker('binance', { ...t, symbol });
    });
    gate.on(EventTypes.TICKER, (t) => {
      this.sharedResources.quoteAggregator.onTicker('gate', t);
    });

    await Promise.all([
      cexManager.subscribe('binance', adapterSymbols, ['bookTicker']),
      cexManager.subscribe('gate', adapterSymbols, ['book_ticker'])
    ]);

    if (!this.sharedResources.useMockAccount && this.sharedResources.accountStreamBridge) {
      await this.sharedResources.accountStreamBridge.start();
    }

    for (const sym of strat.symbols) {
      await this.task.refreshFunding(sym);
    }

    this.fundingTimer = setInterval(() => {
      for (const sym of strat.symbols) {
        this.task.refreshFunding(sym).catch(() => {});
      }
    }, 60000);

    this.tickTimer = setInterval(() => {
      this.sharedResources.reservationManager.purgeExpired();
      for (const sym of strat.symbols) {
        this.task.onTick(sym).catch((e) => console.error('[tick]', sym, e.message));
      }
    }, 200);

    console.log(
      `[TaskManager] started symbols=${strat.symbols.join(',')} trading=${this.tradingEnabled}`
      + ` windowSeconds=${strat.windowSeconds} minDataPoints=${strat.minDataPoints}`
      + ` enforceLatency=${this.sharedResources.enforceLatency}`
    );
  }

  async stop() {
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.sharedResources?.shutdown();
  }
}

export default TaskManager;
