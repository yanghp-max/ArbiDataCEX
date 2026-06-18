/**
 * CEX 行情汇聚：worker 模式（Binance+Gate 单子进程）或 fallback 双 adapter，setImmediate 批处理
 */
import { EventEmitter } from 'events';
import { EventTypes } from '../../cex/types.js';
import { MARKET_TICKER_FLUSH, WORKER_EXIT } from './cex-market-worker-client.js';

export class CexPriceHub extends EventEmitter {
  constructor({ marketWorker = null, providers = [] } = {}) {
    super();
    this.marketWorker = marketWorker;
    this.providers = providers.filter((item) => item?.provider && item?.adapter);
    this._useWorker = Boolean(marketWorker);
    this._queue = new Map();
    this._flushScheduled = false;
    this._handlers = new Map();
    this._started = false;
    this._onTicker = null;
    this._onMarketRefresh = null;
    this._reconnectHandler = null;
    this._workerFlushHandler = null;
    this._workerExitHandler = null;
    this._workerDisconnectHandler = null;
  }

  async start({
    adapterSymbols,
    onTicker,
    onMarketRefresh
  }) {
    if (this._started) return;
    this._onTicker = onTicker;
    this._onMarketRefresh = onMarketRefresh;

    this._reconnectHandler = (payload = {}) => {
      this._onMarketRefresh?.({
        exchange: payload.exchange || payload.provider || null,
        reason: payload.reason || 'reconnected',
        clearCache: Boolean(payload.clearCache)
      });
    };

    this._workerExitHandler = () => {
      for (const { provider } of this.providers) {
        this._onMarketRefresh?.({
          exchange: provider,
          reason: 'worker-exit',
          clearCache: true
        });
      }
    };

    this._workerDisconnectHandler = (payload = {}) => {
      this._onMarketRefresh?.({
        exchange: payload.exchange || payload.provider || null,
        reason: 'ws-disconnected',
        clearCache: true
      });
    };

    if (this._useWorker) {
      if (!this.marketWorker?.isWorkerAvailable?.()) {
        throw new Error('CEX market worker configured but unavailable (main adapters have no public WS)');
      }
      this._workerFlushHandler = (payload = {}) => {
        for (const ticker of payload.tickers || []) {
          this._enqueue(ticker.source, ticker);
        }
      };
      this.marketWorker.on(MARKET_TICKER_FLUSH, this._workerFlushHandler);
      this.marketWorker.on('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
      this.marketWorker.on(WORKER_EXIT, this._workerExitHandler);
      this.marketWorker.on(EventTypes.DISCONNECTED, this._workerDisconnectHandler);
      await this.marketWorker.subscribe(adapterSymbols);
    }

    const mainProviders = this.providers.filter(
      ({ adapter }) => adapter?.enablePublicStream !== false
    );
    if (mainProviders.length > 0) {
      await Promise.all(mainProviders.map(async ({ provider, adapter }) => {
        this._setupProvider(provider, adapter);
        adapter?.on('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
        adapter?.on(EventTypes.RECONNECTED, this._reconnectHandler);
        const channels = provider === 'gate' ? ['book_ticker'] : ['bookTicker'];
        await adapter.subscribe(adapterSymbols, channels);
      }));
    }

    this._started = true;
    const mode = this._useWorker
      ? (mainProviders.length > 0 ? 'hybrid' : 'worker')
      : 'fallback';
    const mainLegs = mainProviders.map((p) => p.provider).join('+') || '-';
    console.log(
      `[CexPriceHub] started mode=${mode} worker=${this._useWorker ? 'yes' : 'no'} `
      + `mainLegs=${mainLegs} symbols=${adapterSymbols.length}`
    );
  }

  _setupProvider(provider, adapter) {
    if (!adapter || this._handlers.has(provider)) return;
    const handler = (ticker) => this._enqueue(provider, ticker);
    adapter.on(EventTypes.TICKER, handler);
    this._handlers.set(provider, { adapter, handler });
  }

  _enqueue(source, ticker) {
    if (!ticker?.symbol) return;
    const provider = source;
    const key = `${provider}:${ticker.symbol}`;
    this._queue.set(key, { provider, ticker });
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => {
      this._flushScheduled = false;
      if (this._queue.size === 0) return;
      const batch = new Map(this._queue);
      this._queue.clear();
      for (const { provider, ticker } of batch.values()) {
        this._onTicker?.(provider, ticker);
      }
    });
  }

  async stop() {
    if (!this._started) return;

    if (this._workerFlushHandler) {
      this.marketWorker?.off(MARKET_TICKER_FLUSH, this._workerFlushHandler);
      this.marketWorker?.off('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
      this.marketWorker?.off(WORKER_EXIT, this._workerExitHandler);
      this.marketWorker?.off(EventTypes.DISCONNECTED, this._workerDisconnectHandler);
      this._workerFlushHandler = null;
      this._workerExitHandler = null;
      this._workerDisconnectHandler = null;
    }

    for (const [, { adapter, handler }] of this._handlers) {
      adapter.off(EventTypes.TICKER, handler);
    }
    for (const { adapter } of this.providers) {
      adapter?.off('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
      adapter?.off(EventTypes.RECONNECTED, this._reconnectHandler);
    }

    this._handlers.clear();
    this._queue.clear();
    this._flushScheduled = false;
    this._started = false;
    this._onTicker = null;
    this._onMarketRefresh = null;
    this._reconnectHandler = null;
  }
}

export default CexPriceHub;
