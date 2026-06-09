/**
 * CEX 公共行情子进程客户端（Binance + Gate 对称，单次 tickerFlush IPC）
 */
import { EventEmitter } from 'events';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventTypes } from '../../cex/types.js';

const MSG_READY = 'ready';
const MSG_TICKER_FLUSH = 'tickerFlush';
const MSG_WS_DISCONNECTED = 'wsDisconnected';
const MSG_WS_RECONNECTED = 'wsReconnected';
const MSG_DIAG = 'diag';

export const MARKET_TICKER_FLUSH = 'marketTickerFlush';

const CMD_INIT = 'init';
const CMD_SUBSCRIBE = 'subscribeTicker';
const CMD_UNSUBSCRIBE = 'unsubscribeTicker';
const CMD_RECONNECT = 'reconnectPublicWs';
const CMD_GET_STATE = 'getStateSnapshot';
const CMD_SHUTDOWN = 'shutdown';

function buildWorkerScriptPath() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(__dirname, 'cex-market-worker.js');
}

export class CexMarketWorkerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workerScript = options.workerScript || buildWorkerScriptPath();
    this.configProvider = options.configProvider || (() => ({}));
    this.debug = Boolean(options.debug);
    this.child = null;
    this.ready = false;
    this.initialized = false;
    this.binanceConnected = false;
    this.gateConnected = false;
    this.latestTickerByKey = new Map();
    this._lastFlushSeq = 0;
    this._spawnPromise = null;
    this._subscribedSymbols = new Set();
    this._closing = false;
  }

  async initialize() {
    if (this.initialized) return;
    if (this._spawnPromise) {
      await this._spawnPromise;
      return;
    }
    this._spawnPromise = this._initializeInternal();
    await this._spawnPromise;
    this._spawnPromise = null;
  }

  async _initializeInternal() {
    this._closing = false;
    const child = fork(this.workerScript, [], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env }
    });

    this.child = child;
    child.on('message', (message) => this._handleMessage(message || {}));
    child.on('exit', (code, signal) => {
      this.ready = false;
      this.initialized = false;
      this.binanceConnected = false;
      this.gateConnected = false;
      this.child = null;
      this._lastFlushSeq = 0;
      if (this.debug) {
        console.warn(`[CexMarketWorkerClient] worker exited code=${code} signal=${signal}`);
      }
      if (!this._closing) {
        setTimeout(() => {
          this.initialize()
            .then(() => this._restoreSubscriptions())
            .catch((error) => {
              console.error('[CexMarketWorkerClient] worker respawn failed:', error.message);
            });
        }, 500);
      }
    });
    child.on('error', (error) => {
      console.error('[CexMarketWorkerClient] worker error:', error.message);
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('CEX market worker ready timeout')), 20000);

      const onReady = () => {
        clearTimeout(timeout);
        this.off(MSG_READY, onReady);
        resolve();
      };

      this.on(MSG_READY, onReady);
      child.once('exit', () => {
        clearTimeout(timeout);
        this.off(MSG_READY, onReady);
        reject(new Error('CEX market worker exited before ready'));
      });

      child.send({
        type: CMD_INIT,
        config: this.configProvider()
      });
    });

    this.initialized = true;
  }

  async subscribe(symbolsOrSymbol) {
    await this.initialize();
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    const newSymbols = symbols.filter((s) => !this._subscribedSymbols.has(s));
    if (newSymbols.length === 0) return;
    for (const symbol of newSymbols) {
      this._subscribedSymbols.add(symbol);
    }
    this.child?.send({ type: CMD_SUBSCRIBE, symbols: newSymbols });
  }

  async unsubscribe(symbolsOrSymbol) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    const removed = symbols.filter((s) => this._subscribedSymbols.has(s));
    if (removed.length === 0) return;
    for (const symbol of removed) {
      this._subscribedSymbols.delete(symbol);
    }
    this.child?.send({ type: CMD_UNSUBSCRIBE, symbols: removed });
  }

  async reconnectWebSocket(provider = 'all') {
    await this.initialize();
    this.child?.send({ type: CMD_RECONNECT, provider });
  }

  isWorkerAvailable() {
    return Boolean(this.child?.connected && this.ready && this.initialized);
  }

  requestStateSnapshot() {
    this.child?.send({ type: CMD_GET_STATE });
  }

  async cleanup() {
    if (!this.child) return;
    this._closing = true;
    this.child.send({ type: CMD_SHUTDOWN });
    this.child = null;
    this.ready = false;
    this.initialized = false;
    this.binanceConnected = false;
    this.gateConnected = false;
    this.latestTickerByKey.clear();
    this._subscribedSymbols.clear();
    this.removeAllListeners();
  }

  async _restoreSubscriptions() {
    if (!this.child || this._subscribedSymbols.size === 0) return;
    this.child.send({
      type: CMD_SUBSCRIBE,
      symbols: Array.from(this._subscribedSymbols)
    });
  }

  _handleMessage(message) {
    switch (message.type) {
      case MSG_READY:
        this.ready = true;
        this.binanceConnected = Boolean(message.payload?.binanceConnected);
        this.gateConnected = Boolean(message.payload?.gateConnected);
        this.emit(MSG_READY, message.payload || {});
        break;
      case MSG_TICKER_FLUSH:
        this._handleTickerFlush(message.payload || {});
        break;
      case MSG_WS_DISCONNECTED:
        if (message.payload?.exchange === 'gate') {
          this.gateConnected = false;
        } else {
          this.binanceConnected = false;
        }
        this.emit(EventTypes.DISCONNECTED, message.payload || {});
        break;
      case MSG_WS_RECONNECTED:
        if (message.payload?.exchange === 'gate') {
          this.gateConnected = true;
        } else {
          this.binanceConnected = true;
        }
        this.emit(EventTypes.RECONNECTED, message.payload || {});
        this.emit('PUBLIC_WS_RECONNECTED', message.payload || {});
        break;
      case MSG_DIAG:
        this.emit('diag', message.payload || {});
        break;
      default:
        break;
    }
  }

  _handleTickerFlush(payload) {
    const seq = Number(payload.seq || 0);
    if (seq <= this._lastFlushSeq) return;
    this._lastFlushSeq = seq;
    const now = Date.now();
    const updates = Array.isArray(payload.updates) ? payload.updates : [];
    const tickers = [];

    for (const item of updates) {
      const source = item.source === 'gate' ? 'gate' : 'binance';
      const symbol = item.symbol;
      if (!symbol) continue;

      if (source === 'binance') this.binanceConnected = true;
      if (source === 'gate') this.gateConnected = true;

      const receiveMs = item.receiveTs || now;
      const ticker = {
        source,
        symbol,
        bid: item.bid,
        ask: item.ask,
        bidQty: item.bidQty,
        askQty: item.askQty,
        timestamp: item.timestamp || item.exchangeTs || now,
        serverTimestamp: item.serverTimestamp ?? null,
        receiveMs,
        localTimestamp: receiveMs,
        wsDelayMs: item.wsDelayMs ?? null
      };

      this.latestTickerByKey.set(`${source}:${symbol}`, ticker);
      tickers.push(ticker);
    }

    if (tickers.length === 0) return;
    this.emit(MARKET_TICKER_FLUSH, {
      seq,
      sentAt: payload.sentAt || now,
      tickers
    });
  }
}

export default CexMarketWorkerClient;
