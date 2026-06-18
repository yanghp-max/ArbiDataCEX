/**
 * CEX 公共行情子进程：Binance + Gate bookTicker，单次 IPC flush（上百 symbol 对称扩展）
 */
import { BinanceAdapter } from '../../cex/adapters/binance-adapter.js';
import { GateAdapter } from '../../cex/adapters/gate-adapter.js';
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

class CexMarketWorkerRuntime {
  constructor() {
    this.binance = null;
    this.gate = null;
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
      binanceTicks: 0,
      gateTicks: 0
    };
    this._diagInterval = null;
  }

  async initialize(config = {}) {
    if (this.initPromise) return await this.initPromise;
    this.initPromise = this._initializeInternal(config);
    return await this.initPromise;
  }

  async _initializeInternal(config = {}) {
    const binanceCfg = config.binance || {};
    const gateCfg = config.gate || {};
    const enableGate = config.enableGate !== false && gateCfg != null;

    this.binance = new BinanceAdapter({
      ...binanceCfg,
      enablePublicStream: true
    });
    this.gate = enableGate
      ? new GateAdapter({
        ...gateCfg,
        enablePublicStream: true
      })
      : null;

    this.binance.on(EventTypes.TICKER, (ticker) => this._onTicker('binance', ticker));
    if (this.gate) {
      this.gate.on(EventTypes.TICKER, (ticker) => this._onTicker('gate', ticker));
    }

    for (const [source, adapter] of [['binance', this.binance], ['gate', this.gate]]) {
      if (!adapter) continue;
      adapter.on('PUBLIC_WS_RECONNECTED', (payload) => {
        this._send({
          type: MSG_WS_RECONNECTED,
          payload: { exchange: source, ...payload }
        });
      });
      adapter.on(EventTypes.ERROR, (error) => {
        this._send({
          type: MSG_DIAG,
          payload: {
            kind: 'adapter_error',
            exchange: source,
            error: error?.message || String(error || 'UNKNOWN')
          }
        });
      });
    }

    await Promise.all([
      this.binance.connect(),
      this.gate ? this.gate.connect() : Promise.resolve()
    ]);
    this.ready = true;
    this._startDiagTimer();
    this._send({
      type: MSG_READY,
      payload: {
        binanceConnected: this.binance.publicConnected === true,
        gateConnected: this.gate?.publicConnected === true,
        gateEnabled: enableGate
      }
    });
  }

  async subscribe(symbols = []) {
    if (this.stopped || !symbols.length) return;
    const list = symbols.map((s) => this.binance.normalizeSymbol(s));
    const newSymbols = list.filter((s) => !this.subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;

    await this.binance.subscribe(newSymbols, ['bookTicker']);
    if (this.gate) {
      await this.gate.subscribe(newSymbols, ['book_ticker']);
    }
    for (const symbol of newSymbols) {
      this.subscribedSymbols.add(symbol);
    }
  }

  async unsubscribe(symbols = []) {
    if (!symbols.length) return;
    for (const symbol of symbols) {
      const normalized = this.binance.normalizeSymbol(symbol);
      try {
        await this.binance.unsubscribe(normalized, ['bookTicker']);
        if (this.gate) {
          await this.gate.unsubscribe(normalized, ['book_ticker']);
        }
      } finally {
        this.subscribedSymbols.delete(normalized);
        this.latestTickerByKey.delete(flushKey('binance', normalized));
        this.latestTickerByKey.delete(flushKey('gate', normalized));
        this.pendingFlushKeys.delete(flushKey('binance', normalized));
        this.pendingFlushKeys.delete(flushKey('gate', normalized));
      }
    }
  }

  async reconnect(provider = 'all') {
    if (provider === 'binance' || provider === 'all') {
      await this.binance?.reconnectWebSocket();
    }
    if (this.gate && (provider === 'gate' || provider === 'all')) {
      await this.gate?.reconnectWebSocket();
    }
  }

  async shutdown() {
    this.stopped = true;
    this._stopDiagTimer();
    await Promise.all([
      this.binance?.disconnect().catch(() => {}),
      this.gate?.disconnect().catch(() => {})
    ]);
    this.binance = null;
    this.gate = null;
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
    if (source === 'binance') this.diag.binanceTicks += 1;
    if (source === 'gate') this.diag.gateTicks += 1;
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
      binanceConnected: this.binance?.publicConnected === true,
      gateConnected: this.gate?.publicConnected === true,
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
          binanceConnected: this.binance?.publicConnected === true,
          gateConnected: this.gate?.publicConnected === true,
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
