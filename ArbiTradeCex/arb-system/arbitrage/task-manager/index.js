/**
 * TaskManager（对标 arbitrage/task-manager/index.js）
 */
import path from 'node:path';
import { loadConfig, reloadConfig, getRootDir } from '../../config/global-config.js';
import { SharedResources } from './shared-resources.js';
import { CexCexTask } from './cex-cex-task.js';
import { PrecisionChecker } from '../risk/risk-manager.js';

function compactSymbol(symbol) {
  return String(symbol).replace(/[-_]/g, '').toUpperCase();
}

export class TaskManager {
  constructor(options = {}) {
    this.config = options.config || loadConfig();
    this.tradingEnabled = options.tradingEnabled ?? false;
    this.sharedResources = null;
    this.task = null;
    this.fundingTimer = null;
    this.maintenanceTimer = null;
    this.positionReconcileTimer = null;
    /** 同 symbol 同一事件循环内合并为一次 onTick（来价驱动，非定频） */
    this._priceTickCoalesce = new Set();
    this._symbolSet = new Set();
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
      qtyFromConfigOnly: strat.qtyFromConfigOnly === true,
      minOrderLotQtySymbols: strat.minOrderLotQtySymbols
    });
    this.task = new CexCexTask(this.sharedResources, strat, precision);
    this.sharedResources.dashboardBridge?.setConfigReloader(() => this.forceReloadConfigNow());
    this.sharedResources.dashboardBridge?.setManualSyncPositionHandler(
      async (symbol) => this.task.manualSyncSymbolPosition(symbol)
    );
    this._symbolSet = new Set(strat.symbols.map(compactSymbol));

    const cexManager = this.sharedResources.cexManager;
    const adapterSymbols = strat.symbols.map((s) => cexManager.normalizeSymbol('binance', s));

    const priceUpdateMode = strat.priceUpdateMode ?? 'any';
    const onPriceTicker = (source, ticker) => {
      this.sharedResources.quoteAggregator.onTicker(source, ticker);
      const sym = compactSymbol(ticker.symbol);
      if (!this._symbolSet.has(sym)) return;
      if (priceUpdateMode !== 'any') {
        console.warn(`[TaskManager] 未知 priceUpdateMode=${priceUpdateMode}，按 any 处理`);
      }
      this.#schedulePriceTick(sym);
    };
    const onMarketRefresh = (payload = {}) => {
      const source = payload.exchange === 'gate' ? 'gate' : 'binance';
      if (payload.clearCache) {
        this.sharedResources.quoteAggregator.clearSource(source);
      }
      for (const sym of strat.symbols) {
        this.#schedulePriceTick(sym);
      }
      if (payload.reason) {
        console.log(`[TaskManager] ${source} public WS event (${payload.reason})`);
      }
    };

    await this.sharedResources.cexPriceHub.start({
      adapterSymbols,
      onTicker: onPriceTicker,
      onMarketRefresh
    });

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

    this.maintenanceTimer = setInterval(() => {
      this.sharedResources.reservationManager.purgeExpired();
    }, 1000);

    this.task.reconcileAllStalePositions().catch((e) => {
      console.warn('[TaskManager] startup position reconcile:', e.message);
    });

    this.positionReconcileTimer = setInterval(() => {
      this.task.reconcileAllStalePositions().catch((e) => {
        console.warn('[TaskManager] position reconcile:', e.message);
      });
    }, 45000);
    if (typeof this.positionReconcileTimer.unref === 'function') {
      this.positionReconcileTimer.unref();
    }

    console.log(
      `[TaskManager] started symbols=${strat.symbols.join(',')} trading=${this.tradingEnabled}`
      + ` priceMode=ws-driven(${priceUpdateMode}) market=${this.sharedResources.cexMarketWorkerClient ? 'worker(binance+gate)' : 'adapter'}`
      + ` windowSeconds=${strat.windowSeconds}`
      + ` minDataPoints=${strat.minDataPoints} enforceLatency=${this.sharedResources.enforceLatency}`
      + ` restBeforeOrder=${strat.restRefreshBeforeOrder === true}`
    );
  }

  /** WS 来价驱动 onTick；同 symbol 同批 WS 合并为一次，避免无意义重入 */
  #schedulePriceTick(symbol) {
    const sym = compactSymbol(symbol);
    if (!this._symbolSet.has(sym)) return;
    if (this._priceTickCoalesce.has(sym)) return;
    this._priceTickCoalesce.add(sym);
    setImmediate(() => {
      this._priceTickCoalesce.delete(sym);
      this.task.onTick(sym).catch((e) => console.error('[tick]', sym, e.message));
    });
  }

  async stop() {
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.positionReconcileTimer) clearInterval(this.positionReconcileTimer);
    await this.sharedResources?.shutdown();
  }

  forceReloadConfigNow() {
    const nextCfg = reloadConfig();
    const prevStrategy = this.task?.getStrategyConfig?.() ?? this.config.strategy;
    const nextStrategy = nextCfg?.strategy ?? {};
    const nextSymbols = Array.isArray(nextStrategy.symbols) ? nextStrategy.symbols : [];
    const prevSymbols = Array.isArray(prevStrategy.symbols) ? prevStrategy.symbols : [];
    const sameSymbols = nextSymbols.length === prevSymbols.length
      && nextSymbols.every((s, i) => compactSymbol(s) === compactSymbol(prevSymbols[i]));
    if (!sameSymbols) {
      throw new Error('symbols changed; restart strategy process required');
    }
    this.config = nextCfg;
    this.task.updateStrategyConfig(nextStrategy);
    this.sharedResources.enforceLatency = this.task.enforceLatency;
    console.log(
      `[TaskManager] config reloaded by API: slippage bn=${nextStrategy.binanceSlippageBps ?? '-'} `
      + `gt=${nextStrategy.gateSlippageBps ?? '-'}`
    );
    return {
      ok: true,
      at: Date.now(),
      strategy: {
        binanceSlippageBps: nextStrategy.binanceSlippageBps ?? null,
        gateSlippageBps: nextStrategy.gateSlippageBps ?? null
      }
    };
  }
}

export default TaskManager;
