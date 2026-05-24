/**
 * TaskManager（对标 arbitrage/task-manager/index.js）
 */
import path from 'node:path';
import { loadConfig, getRootDir } from '../../config/global-config.js';
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

    const precision = await PrecisionChecker.loadFromJson(minQtyPath, strat.symbols);
    this.task = new CexCexTask(this.sharedResources, strat, precision);

    const binance = this.sharedResources.getBinance();
    const gate = this.sharedResources.getGate();
    const adapterSymbols = strat.symbols.map((s) => binance.toAdapterSymbol(s));

    binance.on('ticker', (t) => {
      this.sharedResources.quoteAggregator.onTicker('binance', {
        ...t,
        symbol: t.symbol.replace('-', '')
      });
    });
    gate.on('ticker', (t) => {
      this.sharedResources.quoteAggregator.onTicker('gate', t);
    });

    await Promise.all([
      binance.subscribe(adapterSymbols, ['bookTicker']),
      gate.subscribe(strat.symbols)
    ]);

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

    console.log(`[TaskManager] started symbols=${strat.symbols.join(',')} trading=${this.tradingEnabled}`);
  }

  async stop() {
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.sharedResources?.shutdown();
  }
}

export default TaskManager;
