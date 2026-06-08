/**
 * TaskManager（对标 arbitrage/task-manager/index.js）
 */
import path from 'node:path';
import { loadConfig, getRootDir } from '../../config/global-config.js';
import { EventTypes } from '../../cex/types.js';
import { SharedResources } from './shared-resources.js';
import { CexCexTask } from './cex-cex-task.js';
import { PrecisionChecker } from '../risk/risk-manager.js';

function compactSymbol(symbol) {
  return String(symbol).replace(/-/g, '').toUpperCase();
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
      minOrderLotQtySymbols: strat.minOrderLotQtySymbols
    });
    this.task = new CexCexTask(this.sharedResources, strat, precision);
    this._symbolSet = new Set(strat.symbols.map(compactSymbol));

    const cexManager = this.sharedResources.cexManager;
    const adapterSymbols = strat.symbols.map((s) => cexManager.normalizeSymbol('binance', s));

    const binance = cexManager.getAdapter('binance');
    const gate = cexManager.getAdapter('gate');

    // 对齐 ArbiTrade-1 priceUpdateMode=any：任意腿 WS 来价 → 更新缓存 → 触发该 symbol 策略计算
    const onPriceTicker = (source, ticker) => {
      this.sharedResources.quoteAggregator.onTicker(source, ticker);
      this.#schedulePriceTick(ticker.symbol);
    };
    binance.on(EventTypes.TICKER, (t) => onPriceTicker('binance', t));
    gate.on(EventTypes.TICKER, (t) => onPriceTicker('gate', t));
    const onBinanceMarketRefresh = (payload = {}) => {
      this.sharedResources.quoteAggregator.clearSource('binance');
      for (const sym of strat.symbols) {
        this.#schedulePriceTick(sym);
      }
      if (payload.reason) {
        console.log(`[TaskManager] Binance market cache cleared (${payload.reason})`);
      }
    };
    binance.on('PUBLIC_WS_RECONNECTED', onBinanceMarketRefresh);

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
      + ` priceMode=ws-driven(any-leg) windowSeconds=${strat.windowSeconds}`
      + ` minDataPoints=${strat.minDataPoints} enforceLatency=${this.sharedResources.enforceLatency}`
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
}

export default TaskManager;
