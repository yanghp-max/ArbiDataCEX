/**
 * OKX USDT-SWAP adapter.
 * Public market data: WS tickers + REST fallback.
 * Trading/account: REST (private WS not required by current strategy flow).
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import {
  checkOrderPreconditions as runCheckOrderPreconditions
} from '../utils/check-order-preconditions.js';

function okxTimestamp() {
  return new Date().toISOString();
}

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_]/g, '').replace(/SWAP$/i, '').toUpperCase();
}

function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export class OkxAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'OKX',
      wsUrl: process.env.OKX_WS_URL || 'wss://ws.okx.com:8443/ws/v5/public',
      privateWsUrl: process.env.OKX_PRIVATE_WS_URL || 'wss://ws.okx.com:8443/ws/v5/private',
      restUrl: process.env.OKX_REST_URL || 'https://www.okx.com',
      apiUrl: process.env.OKX_REST_URL || 'https://www.okx.com',
      ...config
    });

    this.id = 'okx';
    this.enablePublicStream = config.enablePublicStream !== false;
    this.activeSubscriptions = new Set();
    this.subscriptionQueue = [];
    this.subscribedSymbols = [];
    this.subscribedChannels = ['bookTicker'];
    this.processing = false;
    this._lastSymbolMessageAt = new Map();
    this._feedWatchdog = null;
    this._restRefreshPending = false;
    this._shuttingDown = false;
    this._symbolStaleMs = Number(config.symbolStaleMs) || 900;
    this._instrumentByInstId = new Map();
    this._instrumentByCompact = new Map();
    this._balanceCache = null;
    this._positionCache = new Map();
  }

  toCompactSymbol(symbol) {
    return compactSymbol(symbol);
  }

  toExchangeSymbol(symbol) {
    const raw = String(symbol || '').toUpperCase();
    if (raw.includes('-') && raw.endsWith('-SWAP')) {
      return raw;
    }
    const s = this.toCompactSymbol(symbol);
    if (s.endsWith('USDT')) {
      return `${s.slice(0, -4)}-USDT-SWAP`;
    }
    return raw;
  }

  normalizeSymbol(symbol) {
    const s = this.toCompactSymbol(symbol);
    if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USDT`;
    return super.normalizeSymbol(symbol);
  }

  get publicConnected() {
    return Boolean(this.enablePublicStream && this.ws?.readyState === WebSocket.OPEN);
  }

  async reconnectWebSocket() {
    if (!this.enablePublicStream || this._shuttingDown) return;
    await this.connectWebSocket();
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    if (this.enablePublicStream) {
      await this.connectWebSocket();
    }
    if (process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE) {
      this.authenticated = true;
      await this.#loadInstruments().catch((err) => {
        console.warn('[OKX] preload instruments failed:', err.message);
      });
    }
    await super.connect();
  }

  /** OKX clOrdId: alphanumeric only, max 32 chars (no underscores). */
  generateClientOrderId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `arb${ts}${rand}`.slice(0, 32);
  }

  async disconnect() {
    this._shuttingDown = true;
    this.#stopFeedWatchdog();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await super.disconnect();
  }

  async getAuthHeaders(method = 'GET', pathWithQuery = '', bodyText = '') {
    const apiKey = String(process.env.OKX_API_KEY || '').trim();
    const apiSecret = String(process.env.OKX_API_SECRET || '').trim();
    const passphrase = String(process.env.OKX_API_PASSPHRASE || '').trim();
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('OKX auth missing: OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE');
    }
    const ts = okxTimestamp();
    const prehash = `${ts}${String(method || 'GET').toUpperCase()}${pathWithQuery}${bodyText}`;
    const sign = crypto.createHmac('sha256', apiSecret).update(prehash).digest('base64');
    return {
      'Content-Type': 'application/json',
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': passphrase
    };
  }

  async #request(method, path, { params = null, data = null, auth = false, timeout = 15000 } = {}) {
    const upperMethod = String(method || 'GET').toUpperCase();
    const query = params ? `?${new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => {
        if (v == null) return acc;
        acc[k] = String(v);
        return acc;
      }, {})
    ).toString()}` : '';
    const pathWithQuery = `${path}${query}`;
    const bodyText = data ? JSON.stringify(data) : '';
    const headers = auth ? await this.getAuthHeaders(upperMethod, pathWithQuery, bodyText) : {};
    const response = await axios({
      method: upperMethod,
      url: `${this.config.restUrl}${pathWithQuery}`,
      headers,
      data: data || undefined,
      timeout
    });
    const payload = response?.data || {};
    if (String(payload.code) !== '0') {
      throw new Error(`OKX ${path} failed: ${payload.msg || 'unknown'} (code=${payload.code ?? 'n/a'})`);
    }
    return payload.data || [];
  }

  async #loadInstruments() {
    const rows = await this.#request('GET', '/api/v5/public/instruments', {
      params: { instType: 'SWAP' },
      timeout: this.config.timeout || 15000
    });
    this._instrumentByInstId.clear();
    this._instrumentByCompact.clear();
    for (const row of rows) {
      if (String(row.state || '').toLowerCase() !== 'live') continue;
      if (String(row.settleCcy || '').toUpperCase() !== 'USDT') continue;
      const instId = String(row.instId || '').toUpperCase();
      if (!instId.endsWith('-SWAP')) continue;
      this._instrumentByInstId.set(instId, row);
      this._instrumentByCompact.set(this.toCompactSymbol(instId), row);
    }
  }

  async #ensureInstrument(symbol) {
    const instId = this.toExchangeSymbol(symbol);
    if (this._instrumentByInstId.has(instId)) return this._instrumentByInstId.get(instId);
    if (this._instrumentByInstId.size === 0) {
      await this.#loadInstruments();
      if (this._instrumentByInstId.has(instId)) return this._instrumentByInstId.get(instId);
    }
    const rows = await this.#request('GET', '/api/v5/public/instruments', {
      params: { instType: 'SWAP', instId },
      timeout: this.config.timeout || 15000
    });
    const row = (rows || [])[0];
    if (!row) {
      throw new Error(`OKX instrument missing: ${instId}`);
    }
    this._instrumentByInstId.set(instId, row);
    this._instrumentByCompact.set(this.toCompactSymbol(instId), row);
    return row;
  }

  #ctVal(instIdOrSymbol) {
    const instId = String(instIdOrSymbol || '').toUpperCase();
    const row = this._instrumentByInstId.get(instId) || this._instrumentByCompact.get(this.toCompactSymbol(instId));
    const v = Number(row?.ctVal);
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  async loadSymbols() {
    await this.#loadInstruments();
    return new Set(this._instrumentByInstId.keys());
  }

  async getSymbols() {
    const set = await this.loadSymbols();
    return Array.from(set).map((s) => this.normalizeSymbol(s));
  }

  async connectWebSocket() {
    if (!this.enablePublicStream || this._shuttingDown) return;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;
      ws.on('open', async () => {
        this.connected = true;
        if (this.subscribedSymbols.length > 0) {
          await this.#flushSubscriptions({ forceResubscribe: true });
        }
        this.#startFeedWatchdog();
        this.emit('PUBLIC_WS_RECONNECTED', {
          exchange: 'okx',
          reason: 'public-ws-open',
          clearCache: false
        });
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', () => {
        this.connected = false;
        this.#stopFeedWatchdog();
        this.emit(EventTypes.DISCONNECTED, {
          exchange: 'okx',
          reason: this._shuttingDown ? 'manual-close' : 'public-ws-close'
        });
        if (this._shuttingDown) return;
        setTimeout(() => {
          this.connectWebSocket().catch(() => {});
        }, 1000);
      });
      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) reject(err);
      });
    });
  }

  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribedSymbols = symbols.map((s) => this.normalizeSymbol(s));
    this.subscribedChannels = [...channels];
    const subscribedAt = Date.now();
    for (const symbol of symbols) {
      const normalized = this.normalizeSymbol(symbol);
      await super.subscribe(normalized, channels);
      if (!this._lastSymbolMessageAt.has(normalized)) {
        this._lastSymbolMessageAt.set(normalized, subscribedAt);
      }
      for (const ch of channels) {
        if (ch !== 'bookTicker') continue;
        this.subscriptionQueue.push(JSON.stringify({
          channel: 'tickers',
          instId: this.toExchangeSymbol(symbol)
        }));
      }
    }
    await this.#flushSubscriptions();
  }

  async #flushSubscriptions({ forceResubscribe = false } = {}) {
    const streams = new Set(this.subscriptionQueue);
    if (forceResubscribe || streams.size === 0) {
      for (const symbol of this.subscribedSymbols) {
        for (const ch of this.subscribedChannels) {
          if (ch !== 'bookTicker') continue;
          streams.add(JSON.stringify({
            channel: 'tickers',
            instId: this.toExchangeSymbol(symbol)
          }));
        }
      }
    } else {
      for (const stream of this.activeSubscriptions) streams.add(stream);
    }
    this.subscriptionQueue = [...streams];
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.processing = true;
    try {
      while (this.subscriptionQueue.length > 0) {
        const batch = this.subscriptionQueue.splice(0, 50).map((s) => JSON.parse(s));
        this.ws.send(JSON.stringify({ op: 'subscribe', args: batch }));
        for (const stream of batch) this.activeSubscriptions.add(JSON.stringify(stream));
        await new Promise((r) => setTimeout(r, 120));
      }
    } finally {
      this.processing = false;
    }
  }

  #emitBookTicker(ticker, { viaRest = false, restReason = null, receiveLocalTs = null } = {}) {
    const localTs = receiveLocalTs ?? Date.now();
    const sym = this.normalizeSymbol(ticker.symbol);
    this._lastSymbolMessageAt.set(sym, localTs);
    this.emit(EventTypes.TICKER, {
      ...ticker,
      symbol: sym,
      localTimestamp: localTs,
      wsDelayMs: viaRest ? null : ticker.wsDelayMs,
      source: 'okx',
      viaRest,
      restReason
    });
  }

  async #refreshBookTickerViaRest(reason = 'rest', symbols = null) {
    const list = symbols?.length ? symbols : this.subscribedSymbols;
    if (!list.length) return;
    await Promise.all(list.map(async (symbol) => {
      try {
        const row = await this.getBookTicker(symbol, { reason });
        this.#emitBookTicker(row, { viaRest: true, restReason: reason });
      } catch (err) {
        console.warn(`[OKX] REST bookTicker refresh ${symbol} (${reason}):`, err.message);
      }
    }));
  }

  #startFeedWatchdog() {
    this.#stopFeedWatchdog();
    this._feedWatchdog = setInterval(() => {
      if (this._shuttingDown || this.subscribedSymbols.length === 0) return;
      const stale = this.subscribedSymbols.filter((sym) => {
        const key = this.normalizeSymbol(sym);
        const last = this._lastSymbolMessageAt.get(key);
        if (last == null) return false;
        return Date.now() - last > this._symbolStaleMs;
      });
      if (stale.length > 0 && !this._restRefreshPending) {
        this._restRefreshPending = true;
        this.#refreshBookTickerViaRest('watchdog-per-symbol', stale).finally(() => {
          this._restRefreshPending = false;
        });
      }
    }, 3000);
    if (typeof this._feedWatchdog.unref === 'function') {
      this._feedWatchdog.unref();
    }
  }

  #stopFeedWatchdog() {
    if (this._feedWatchdog) {
      clearInterval(this._feedWatchdog);
      this._feedWatchdog = null;
    }
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (!Array.isArray(msg?.data) || msg.data.length === 0) return;
      const payload = msg.data[0];
      const instId = String(payload.instId || msg?.arg?.instId || '');
      const bid = Number(payload.bidPx);
      const ask = Number(payload.askPx);
      if (!instId || !isFinitePositive(bid) || !isFinitePositive(ask)) return;

      const localTs = Date.now();
      const exchangeMs = Number(payload.ts);
      const serverTs = Number.isFinite(exchangeMs) ? exchangeMs : null;
      const wsDelayMs = serverTs != null ? Math.max(0, localTs - serverTs) : null;
      const ticker = {
        symbol: this.normalizeSymbol(instId),
        bid,
        ask,
        timestamp: serverTs ?? localTs,
        serverTimestamp: serverTs,
        wsDelayMs
      };
      this.#emitBookTicker(ticker, { receiveLocalTs: localTs });
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const instId = this.toExchangeSymbol(symbol);
    const rows = await this.#request('GET', '/api/v5/public/funding-rate', {
      params: { instId },
      timeout: this.config.timeout || 15000
    });
    return Number((rows || [])[0]?.fundingRate);
  }

  async setSymbolLeverage(symbol, leverage = 1) {
    const instId = this.toExchangeSymbol(symbol);
    const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
    const rows = await this.#request('POST', '/api/v5/account/set-leverage', {
      data: {
        instId,
        lever: String(lev),
        mgnMode: 'cross'
      },
      auth: true
    });
    const row = (rows || [])[0] || {};
    return {
      symbol: this.toCompactSymbol(symbol),
      leverage: Number(row.lever || lev),
      maxNotionalValue: null
    };
  }

  #mapOrderStatus(state) {
    const s = String(state || '').toLowerCase();
    if (s === 'live') return OrderStatus.OPEN;
    if (s === 'partially_filled') return OrderStatus.PARTIALLY_FILLED;
    if (s === 'filled') return OrderStatus.FILLED;
    if (s === 'canceled') return OrderStatus.CANCELLED;
    return OrderStatus.PENDING;
  }

  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, {
      legRole: 'B',
      ...params,
      futuresMode: true
    });
  }

  async getBookTicker(symbol, options = {}) {
    const instId = this.toExchangeSymbol(symbol);
    const timeout = Number(options.timeoutMs) || this.config.timeout || 5000;
    const rows = await this.#request('GET', '/api/v5/market/ticker', {
      params: { instId },
      timeout
    });
    const row = (rows || [])[0] || {};
    const bid = Number(row.bidPx);
    const ask = Number(row.askPx);
    if (!(isFinitePositive(bid) && isFinitePositive(ask))) {
      throw new Error(`Invalid OKX ticker ${instId}`);
    }
    return {
      symbol: this.normalizeSymbol(instId),
      bid,
      ask,
      timestamp: Number(row.ts) || Date.now(),
      serverTimestamp: Number(row.ts) || null,
      restReason: options.reason ?? 'rest'
    };
  }

  async getOrderBook(symbol, limit = 20, options = {}) {
    const instId = this.toExchangeSymbol(symbol);
    const depthLimit = Math.min(Math.max(Number(limit) || 20, 1), 400);
    const timeout = Number(options.timeoutMs) || 5000;
    const rows = await this.#request('GET', '/api/v5/market/books', {
      params: { instId, sz: depthLimit },
      timeout
    });
    const row = (rows || [])[0] || {};
    const parse = (items) => (Array.isArray(items) ? items : [])
      .map((x) => ({
        price: Number(Array.isArray(x) ? x[0] : x.price),
        size: Number(Array.isArray(x) ? x[1] : x.size)
      }))
      .filter((x) => isFinitePositive(x.price) && isFinitePositive(x.size));
    return {
      bids: parse(row.bids).sort((a, b) => b.price - a.price),
      asks: parse(row.asks).sort((a, b) => a.price - b.price),
      timestamp: Number(row.ts) || Date.now()
    };
  }

  async getBalance(options = {}) {
    const rows = await this.#request('GET', '/api/v5/account/balance', {
      params: { ccy: 'USDT' },
      auth: true
    });
    const details = Array.isArray(rows?.[0]?.details) ? rows[0].details : [];
    const balances = details
      .map((row) => {
        const currency = String(row.ccy || '').toUpperCase();
        if (!currency) return null;
        const total = Number(row.eq ?? row.cashBal ?? 0);
        const available = Number(row.availEq ?? row.availBal ?? total);
        if (total <= 1e-12 && available <= 1e-12) return null;
        return new Balance({
          currency,
          exchange: this.config.name,
          total,
          available,
          marginUsed: Math.max(0, total - available),
          frozen: Math.max(0, total - available),
          timestamp: Date.now()
        });
      })
      .filter(Boolean);
    this._balanceCache = balances;
    if (!options.silent) this.emitBalanceUpdate(balances);
    return balances;
  }

  async getUsdtBalance() {
    const balances = await this.getBalance();
    const usdt = balances.find((b) => b.currency === 'USDT');
    const total = usdt?.available ?? 0;
    return { total, available: total, updatedAtMs: Date.now() };
  }

  async getPositions(options = {}) {
    const rows = await this.#request('GET', '/api/v5/account/positions', {
      params: { instType: 'SWAP' },
      auth: true
    });
    const positions = (rows || [])
      .filter((r) => Math.abs(Number(r.pos)) > 0)
      .map((r) => {
        const instId = String(r.instId || '').toUpperCase();
        const contracts = Number(r.pos);
        const ctVal = this.#ctVal(instId);
        const qty = contracts * ctVal;
        return new Position({
          symbol: this.toCompactSymbol(instId),
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(r.avgPx || 0),
          markPrice: Number(r.markPx || 0),
          unrealizedPnl: Number(r.upl || 0),
          leverage: Number(r.lever || 1),
          initialMargin: Number(r.imr || 0),
          maintMargin: Number(r.mmr || 0),
          timestamp: Date.now()
        });
      });
    this._positionCache.clear();
    for (const p of positions) this._positionCache.set(p.symbol, p);
    if (!options.silent) this.emitPositionUpdate(positions);
    return positions;
  }

  getPosition(asset) {
    const compact = this.toCompactSymbol(asset);
    return this._positionCache.get(compact) || null;
  }

  getAvailable(asset) {
    const cur = String(asset || 'USDT').toUpperCase();
    const row = (this._balanceCache || []).find((b) => b.currency === cur);
    return row?.available ?? 0;
  }

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const instId = this.toExchangeSymbol(orderData.symbol);
    await this.#ensureInstrument(instId);
    const side = String(orderData.side || '').toLowerCase();
    const type = String(orderData.type || '').toLowerCase();
    const size = Number(orderData.amount);
    if (!(size > 0)) throw new Error('OKX order size must be > 0');
    const payload = {
      instId,
      tdMode: 'cross',
      side,
      ordType: type,
      sz: String(size),
      clOrdId: orderData.clientOrderId || this.generateClientOrderId()
    };
    if (type === 'limit' && orderData.price) {
      payload.px = String(orderData.price);
    }
    if (orderData.reduceOnly) payload.reduceOnly = true;

    const rows = await this.#request('POST', '/api/v5/trade/order', {
      data: payload,
      auth: true
    });
    const row = (rows || [])[0] || {};
    if (String(row.sCode) !== '0') {
      throw new Error(`OKX placeOrder failed: ${row.sMsg || 'unknown'} (code=${row.sCode ?? 'n/a'})`);
    }
    const ordId = String(row.ordId || '');
    if (!ordId) throw new Error('OKX placeOrder missing ordId');
    return new Order({
      orderId: ordId,
      clientOrderId: row.clOrdId || payload.clOrdId,
      symbol: this.normalizeSymbol(instId),
      exchange: this.config.name,
      side,
      type,
      amount: size,
      price: Number(orderData.price || 0),
      status: OrderStatus.PENDING,
      filled: 0,
      timestamp: Date.now()
    });
  }

  async placeMarketOrder({ symbol, side, quantity }) {
    return this.placeOrder({
      symbol,
      side: String(side).toLowerCase(),
      type: 'market',
      amount: quantity
    });
  }

  async cancelOrder(orderId, symbol) {
    const instId = this.toExchangeSymbol(symbol);
    const rows = await this.#request('POST', '/api/v5/trade/cancel-order', {
      data: { instId, ordId: String(orderId) },
      auth: true
    });
    const row = (rows || [])[0] || {};
    if (String(row.sCode) !== '0') {
      throw new Error(`OKX cancelOrder failed: ${row.sMsg || 'unknown'} (code=${row.sCode ?? 'n/a'})`);
    }
    return row;
  }

  #mapOrderRow(row, orderId, instId) {
    const filled = Number(row.accFillSz || 0);
    const avg = Number(row.avgPx || row.fillPx || 0);
    const resolvedInstId = String(row.instId || instId || '').toUpperCase();
    return new Order({
      orderId: String(row.ordId || orderId),
      clientOrderId: row.clOrdId || null,
      symbol: this.normalizeSymbol(resolvedInstId),
      exchange: this.config.name,
      side: String(row.side || '').toLowerCase(),
      type: String(row.ordType || '').toLowerCase(),
      amount: Number(row.sz || 0),
      price: Number(row.px || 0),
      status: this.#mapOrderStatus(row.state),
      filled,
      timestamp: Number(row.cTime || Date.now()),
      updateTime: Number(row.uTime || row.cTime || Date.now()),
      avgPrice: avg,
      cumQuote: filled > 0 && avg > 0
        ? (filled * this.#ctVal(resolvedInstId) * avg)
        : Number(row.fillNotionalUsd || 0)
    });
  }

  async getOrderStatus(orderId, symbol) {
    const instId = this.toExchangeSymbol(symbol);
    const ordId = String(orderId);
    try {
      const rows = await this.#request('GET', '/api/v5/trade/order', {
        params: { instId, ordId },
        auth: true
      });
      const row = (rows || [])[0];
      if (row) return this.#mapOrderRow(row, ordId, instId);
    } catch (err) {
      const msg = String(err?.message || '');
      if (!/51400|51603|does not exist|order not found/i.test(msg)) {
        throw err;
      }
    }
    const historyRows = await this.#request('GET', '/api/v5/trade/orders-history', {
      params: { instType: 'SWAP', instId, ordId, limit: 1 },
      auth: true
    });
    const historyRow = (historyRows || [])[0];
    if (!historyRow) {
      throw new Error(`OKX order not found: ${ordId} ${instId}`);
    }
    return this.#mapOrderRow(historyRow, ordId, instId);
  }

  async getOrderHistory(symbol, limit = 100) {
    const instId = this.toExchangeSymbol(symbol);
    const rows = await this.#request('GET', '/api/v5/trade/orders-history', {
      params: {
        instType: 'SWAP',
        instId,
        limit: Math.min(Math.max(Number(limit) || 100, 1), 100)
      },
      auth: true
    });
    return (rows || []).map((row) => new Order({
      orderId: String(row.ordId),
      clientOrderId: row.clOrdId,
      symbol: this.normalizeSymbol(row.instId || instId),
      exchange: this.config.name,
      side: String(row.side || '').toLowerCase(),
      type: String(row.ordType || '').toLowerCase(),
      amount: Number(row.sz || 0),
      price: Number(row.px || 0),
      status: this.#mapOrderStatus(row.state),
      filled: Number(row.accFillSz || 0),
      timestamp: Number(row.cTime || Date.now()),
      updateTime: Number(row.uTime || row.cTime || Date.now()),
      avgPrice: Number(row.avgPx || row.fillPx || 0),
      cumQuote: Number(row.fillNotionalUsd || 0)
    }));
  }

  async getOrderTrades(orderId, symbol) {
    const instId = this.toExchangeSymbol(symbol);
    const ctVal = this.#ctVal(instId);
    const rows = await this.#request('GET', '/api/v5/trade/fills', {
      params: { instType: 'SWAP', instId, ordId: String(orderId) },
      auth: true
    });
    return (rows || []).map((row) => {
      const contracts = Math.abs(Number(row.fillSz || 0));
      const price = Number(row.fillPx || 0);
      const quoteQty = Number(row.fillNotionalUsd || 0) || (contracts * ctVal * price);
      return {
        contracts,
        size: contracts,
        qty: contracts,
        price,
        quoteQty,
        fee: Math.abs(Number(row.fee || 0)),
        feeAsset: String(row.feeCcy || 'USDT').toUpperCase()
      };
    });
  }

  async getOrderCommission(orderId, symbol) {
    const trades = await this.getOrderTrades(orderId, symbol);
    let fee = 0;
    for (const row of trades) {
      if (row.feeAsset === 'USDT') fee += row.fee;
    }
    return fee;
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    if (Number(orderData.amount) <= 0) {
      throw new Error('Order amount must be greater than 0');
    }
    return true;
  }
}

export default OkxAdapter;
