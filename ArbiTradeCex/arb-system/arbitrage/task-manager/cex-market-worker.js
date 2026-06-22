/**
 * CEX 公共行情子进程：按 provider 隔离公共 bookTicker WS，单次 IPC flush。
 */
import { BinanceAdapter } from '../../cex/adapters/binance-adapter.js';
import { GateAdapter } from '../../cex/adapters/gate-adapter.js';
import { AsterAdapter } from '../../cex/adapters/aster-adapter.js';
import { OkxAdapter } from '../../cex/adapters/okx-adapter.js';
import { EventTypes } from '../../cex/types.js';

const MSG_READY = 'ready';
const MSG_TICKER_FLUSH = 'tickerFlush';
const MSG_WS_DISCONNECTED = 'wsDisconnected';
const MSG_WS_RECONNECTED = 'wsReconnected';
const MSG_DIAG = 'diag';

const CMD_INIT = 'init';
const CMD_SUBSCRIBE = 'subscribeTicker';
const CMD_UNSUBSCRIBE = 'unsubscribeTicker';
const CMD_RECONNECT = 'reconnectPublicWs';
const CMD_GET_STATE = 'getStateSnapshot';
const CMD_SHUTDOWN = 'shutdown';

function flushKey(source, symbol) {
  return `${source}:${symbol}`;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function channelForProvider(provider) {
  return provider === 'gate' ? 'book_ticker' : 'bookTicker';
}

function createAdapter(provider, config = {}) {
  if (provider === 'binance') {
    return new BinanceAdapter({
      ...config,
      enablePublicStream: true
    });
  }
  if (provider === 'gate') {
    return new GateAdapter({
      ...config,
      enablePublicStream: true
    });
  }
  if (provider === 'aster') {
    return new AsterAdapter({
      ...config,
      enablePublicStream: true
    });
  }
  if (provider === 'okx') {
    return new OkxAdapter({
      ...config,
      enablePublicStream: true
    });
  }
  throw new Error(`Unsupported market worker provider: ${provider}`);
}

function resolveProviders(config = {}) {
  const explicit = Array.isArray(config.providers)
    ? config.providers.map(normalizeProvider).filter(Boolean)
    : [];
  if (explicit.length > 0) return [...new Set(explicit)];

  const providers = ['binance'];
  if (config.enableGate !== false && config.gate != null) {
    providers.push('gate');
  }
  if (config.enableAster !== false && config.aster != null) {
    providers.push('aster');
  }
  if (config.enableOkx !== false && config.okx != null) {
    providers.push('okx');
  }
  return providers;
}

class CexMarketWorkerRuntime {
  constructor() {
    this.adapters = new Map();
    this.ready = false;
    this.subscribedSymbols = new Set();
    this.latestTickerByKey = new Map();
    this.pendingFlushKeys = new Set();
    this.flushScheduled = false;
    this.flushSeq = 0;
    this.initPromise = null;
    this.stopped = false;
    this.diag = {
      tickCount: 0,
      flushCount: 0,
      maxFlushSize: 0,
      lastFlushSentAt: 0,
      providerTicks: {}
    };
    this._diagInterval = null;
  }

  async initialize(config = {}) {
    if (this.initPromise) return await this.initPromise;
    this.initPromise = this._initializeInternal(config);
    return await this.initPromise;
  }

  async _initializeInternal(config = {}) {
    const providers = resolveProviders(config);
    if (providers.length === 0) {
      throw new Error('CEX market worker requires at least one provider');
    }

    for (const provider of providers) {
      const adapter = createAdapter(provider, config[provider] || {});
      this.adapters.set(provider, adapter);
      this.diag.providerTicks[provider] = 0;
      adapter.on(EventTypes.TICKER, (ticker) => this._onTicker(provider, ticker));
      adapter.on('PUBLIC_WS_RECONNECTED', (payload) => {
        this._send({
          type: MSG_WS_RECONNECTED,
          payload: { exchange: provider, provider, ...payload }
        });
      });
      adapter.on(EventTypes.DISCONNECTED, (payload) => {
        this._send({
          type: MSG_WS_DISCONNECTED,
          payload: { exchange: provider, provider, ...(payload || {}) }
        });
      });
      adapter.on(EventTypes.ERROR, (error) => {
        this._send({
          type: MSG_DIAG,
          payload: {
            kind: 'adapter_error',
            exchange: provider,
            provider,
            error: error?.message || String(error || 'UNKNOWN')
          }
        });
      });
    }

    await Promise.all([...this.adapters.values()].map((adapter) => adapter.connect()));
    this.ready = true;
    this._startDiagTimer();
    this._send({
      type: MSG_READY,
      payload: this.#connectionPayload()
    });
  }

  #connectionPayload() {
    const providers = [...this.adapters.keys()];
    const connected = {};
    for (const [provider, adapter] of this.adapters) {
      connected[provider] = adapter.publicConnected === true;
    }
    return {
      providers,
      connected,
      binanceConnected: connected.binance === true,
      gateConnected: connected.gate === true,
      asterConnected: connected.aster === true,
      gateEnabled: this.adapters.has('gate')
    };
  }

  async subscribe(symbols = []) {
    if (this.stopped || !symbols.length) return;
    const normalizer = this.adapters.values().next().value;
    const list = symbols.map((s) => normalizer.normalizeSymbol(s));
    const newSymbols = list.filter((s) => !this.subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;

    await Promise.all([...this.adapters].map(([provider, adapter]) => (
      adapter.subscribe(newSymbols, [channelForProvider(provider)])
    )));
    for (const symbol of newSymbols) {
      this.subscribedSymbols.add(symbol);
    }
  }

  async unsubscribe(symbols = []) {
    if (!symbols.length) return;
    for (const symbol of symbols) {
      const normalizer = this.adapters.values().next().value;
      const normalized = normalizer.normalizeSymbol(symbol);
      try {
        await Promise.all([...this.adapters].map(([provider, adapter]) => (
          adapter.unsubscribe(normalized, [channelForProvider(provider)])
        )));
      } finally {
        this.subscribedSymbols.delete(normalized);
        for (const provider of this.adapters.keys()) {
          this.latestTickerByKey.delete(flushKey(provider, normalized));
          this.pendingFlushKeys.delete(flushKey(provider, normalized));
        }
      }
    }
  }

  async reconnect(provider = 'all') {
    if (provider === 'all') {
      await Promise.all([...this.adapters.values()].map((adapter) => adapter.reconnectWebSocket()));
      return;
    }
    const adapter = this.adapters.get(normalizeProvider(provider));
    if (adapter) {
      await adapter.reconnectWebSocket();
    }
  }

  async shutdown() {
    this.stopped = true;
    this._stopDiagTimer();
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.disconnect().catch(() => {})));
    this.adapters.clear();
  }

  _onTicker(source, ticker) {
    if (this.stopped || !ticker?.symbol) return;
    const now = Date.now();
    const symbol = String(ticker.symbol);
    const key = flushKey(source, symbol);
    const latest = {
      source,
      symbol,
      bid: ticker.bid,
      ask: ticker.ask,
      bidQty: ticker.bidQty,
      askQty: ticker.askQty,
      timestamp: ticker.timestamp || now,
      serverTimestamp: ticker.serverTimestamp ?? null,
      exchangeTs: ticker.timestamp || now,
      receiveTs: ticker.localTimestamp || now,
      wsDelayMs: ticker.wsDelayMs ?? null,
      valid: true
    };

    this.diag.tickCount += 1;
    this.diag.providerTicks[source] = (this.diag.providerTicks[source] || 0) + 1;
    this.latestTickerByKey.set(key, latest);
    this.pendingFlushKeys.add(key);

    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this._flushTickers());
    }
  }

  _flushTickers() {
    this.flushScheduled = false;
    if (this.pendingFlushKeys.size === 0 || this.stopped) return;

    const updates = [];
    for (const key of this.pendingFlushKeys) {
      const ticker = this.latestTickerByKey.get(key);
      if (ticker) updates.push(ticker);
    }
    this.pendingFlushKeys.clear();
    if (updates.length === 0) return;

    this.flushSeq += 1;
    this.diag.flushCount += 1;
    this.diag.lastFlushSentAt = Date.now();
    if (updates.length > this.diag.maxFlushSize) {
      this.diag.maxFlushSize = updates.length;
    }

    this._send({
      type: MSG_TICKER_FLUSH,
      payload: {
        seq: this.flushSeq,
        sentAt: Date.now(),
        updates
      }
    });
  }

  getStateSnapshot() {
    return {
      ...this.#connectionPayload(),
      subscribedSymbols: Array.from(this.subscribedSymbols),
      latestTickerCount: this.latestTickerByKey.size,
      flushSeq: this.flushSeq,
      diag: { ...this.diag }
    };
  }

  _startDiagTimer() {
    this._stopDiagTimer();
    this._diagInterval = setInterval(() => {
      this._send({
        type: MSG_DIAG,
        payload: {
          kind: 'worker_stats',
          ...this.#connectionPayload(),
          subscribedSymbols: this.subscribedSymbols.size,
          latestTickerCount: this.latestTickerByKey.size,
          ...this.diag
        }
      });
    }, 30000);
    this._diagInterval.unref?.();
  }

  _stopDiagTimer() {
    if (this._diagInterval) {
      clearInterval(this._diagInterval);
      this._diagInterval = null;
    }
  }

  _send(message) {
    if (typeof process.send === 'function') {
      process.send(message);
    }
  }
}

const runtime = new CexMarketWorkerRuntime();

process.on('message', async (message = {}) => {
  try {
    switch (message.type) {
      case CMD_INIT:
        await runtime.initialize(message.config || {});
        break;
      case CMD_SUBSCRIBE:
        await runtime.subscribe(message.symbols || (message.symbol ? [message.symbol] : []));
        break;
      case CMD_UNSUBSCRIBE:
        await runtime.unsubscribe(message.symbols || (message.symbol ? [message.symbol] : []));
        break;
      case CMD_RECONNECT:
        await runtime.reconnect(message.provider || 'all');
        break;
      case CMD_GET_STATE:
        if (typeof process.send === 'function') {
          process.send({
            type: MSG_DIAG,
            payload: {
              kind: 'state_snapshot',
              snapshot: runtime.getStateSnapshot()
            }
          });
        }
        break;
      case CMD_SHUTDOWN:
        await runtime.shutdown();
        process.exit(0);
        break;
      default:
        break;
    }
  } catch (error) {
    if (typeof process.send === 'function') {
      process.send({
        type: MSG_DIAG,
        payload: {
          kind: 'worker_command_error',
          command: message.type,
          error: error?.message || String(error || 'UNKNOWN')
        }
      });
    }
  }
});

process.on('SIGTERM', async () => {
  await runtime.shutdown();
  process.exit(0);
});
