/**
 * CEX 行情汇聚：worker 模式（Binance+Gate 单子进程）或 fallback 双 adapter，setImmediate 批处理
 */
import { EventEmitter } from 'events';
import { EventTypes } from '../../cex/types.js';
import { MARKET_TICKER_FLUSH, WORKER_EXIT } from './cex-market-worker-client.js';

export class CexPriceHub extends EventEmitter {
  constructor({ marketWorker = null, binanceSource = null, gateAdapter = null } = {}) {
    super();
    this.marketWorker = marketWorker;
    this.binanceSource = binanceSource;
    this.gateAdapter = gateAdapter;
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
        exchange: payload.exchange === 'gate' ? 'gate' : 'binance',
        reason: payload.reason || 'reconnected',
        clearCache: Boolean(payload.clearCache)
      });
    };

    this._workerExitHandler = () => {
      for (const exchange of ['binance', 'gate']) {
        this._onMarketRefresh?.({
          exchange,
          reason: 'worker-exit',
          clearCache: true
        });
      }
    };

    this._workerDisconnectHandler = (payload = {}) => {
      this._onMarketRefresh?.({
        exchange: payload.exchange === 'gate' ? 'gate' : 'binance',
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
      this._started = true;
      console.log(`[CexPriceHub] started mode=worker symbols=${adapterSymbols.length}`);
      return;
    }

    this._setupProvider('binance', this.binanceSource);
    this._setupProvider('gate', this.gateAdapter);
    this.binanceSource?.on('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
    this.binanceSource?.on(EventTypes.RECONNECTED, this._reconnectHandler);
    this.gateAdapter?.on('PUBLIC_WS_RECONNECTED', this._reconnectHandler);

    await Promise.all([
      this.binanceSource.subscribe(adapterSymbols, ['bookTicker']),
      this.gateAdapter.subscribe(adapterSymbols, ['book_ticker'])
    ]);

    this._started = true;
    console.log(`[CexPriceHub] started mode=fallback symbols=${adapterSymbols.length}`);
  }

  _setupProvider(provider, adapter) {
    if (!adapter || this._handlers.has(provider)) return;
    const handler = (ticker) => this._enqueue(provider, ticker);
    adapter.on(EventTypes.TICKER, handler);
    this._handlers.set(provider, { adapter, handler });
  }

  _enqueue(source, ticker) {
    if (!ticker?.symbol) return;
    const provider = source === 'gate' ? 'gate' : 'binance';
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
    this.binanceSource?.off('PUBLIC_WS_RECONNECTED', this._reconnectHandler);
    this.binanceSource?.off(EventTypes.RECONNECTED, this._reconnectHandler);
    this.gateAdapter?.off('PUBLIC_WS_RECONNECTED', this._reconnectHandler);

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
