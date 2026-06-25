/**
 * Bybit USDT linear perpetual adapter (v5 API).
 */
import crypto from 'node:crypto';
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { checkOrderPreconditions as runCheckOrderPreconditions } from '../utils/check-order-preconditions.js';
import { withKeepAlive } from '../utils/http-agents.js';
import { tuneWebSocket } from '../utils/ws-tune.js';

const MAX_SANE_WS_DELAY_MS = 30_000;
const CATEGORY = 'linear';

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_/]/g, '').toUpperCase();
}

function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export class BybitAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Bybit',
      wsUrl: process.env.BYBIT_WS_URL || 'wss://stream.bybit.com/v5/public/linear',
      restUrl: process.env.BYBIT_REST_URL || 'https://api.bybit.com',
      apiUrl: process.env.BYBIT_REST_URL || 'https://api.bybit.com',
      recvWindow: 5000,
      ...config
    });
    this.id = 'bybit';
    this.enablePublicStream = config.enablePublicStream !== false;
    this.subscribedSymbols = [];
    this.subscribedChannels = ['bookTicker'];
    this._instrumentBySymbol = new Map();
    this._balanceCache = null;
    this._positionCache = new Map();
    this._lastSymbolMessageAt = new Map();
    this._feedWatchdog = null;
    this._restRefreshPending = false;
    this._shuttingDown = false;
    this._symbolStaleMs = Number(config.symbolStaleMs) || 900;
  }

  toCompactSymbol(symbol) {
    return compactSymbol(symbol);
  }

  toExchangeSymbol(symbol) {
    return this.toCompactSymbol(symbol);
  }

  normalizeSymbol(symbol) {
    const s = this.toCompactSymbol(symbol);
    if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USDT`;
    return super.normalizeSymbol(symbol);
  }

  get publicConnected() {
    return Boolean(this.enablePublicStream && this.ws?.readyState === WebSocket.OPEN);
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    if (this.enablePublicStream) await this.connectWebSocket();
    if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
      this.authenticated = true;
      await this.#loadInstruments().catch((err) => {
        console.warn('[Bybit] preload instruments failed:', err.message);
      });
    }
    await super.connect();
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
    const apiKey = String(process.env.BYBIT_API_KEY || '').trim();
    const apiSecret = String(process.env.BYBIT_API_SECRET || '').trim();
    if (!apiKey || !apiSecret) {
      throw new Error('Bybit auth missing: BYBIT_API_KEY / BYBIT_API_SECRET');
    }
    const ts = String(Date.now());
    const recv = String(this.config.recvWindow || 5000);
    const upper = String(method || 'GET').toUpperCase();
    const queryString = pathWithQuery.includes('?') ? pathWithQuery.split('?').slice(1).join('?') : '';
    const payload = `${ts}${apiKey}${recv}${upper === 'GET' ? queryString : bodyText}`;
    const sign = crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': sign,
      'X-BAPI-TIMESTAMP': ts,
      'X-BAPI-RECV-WINDOW': recv
    };
  }

  async #request(method, path, { params = null, data = null, auth = false, timeout = 15000 } = {}) {
    const upper = String(method || 'GET').toUpperCase();
    const query = params ? `?${new URLSearchParams(
      Object.entries(params).reduce((acc, [k, v]) => {
        if (v == null) return acc;
        acc[k] = String(v);
        return acc;
      }, {})
    ).toString()}` : '';
    const pathWithQuery = `${path}${query}`;
    const bodyText = data ? JSON.stringify(data) : '';
    const headers = auth ? await this.getAuthHeaders(upper, pathWithQuery, bodyText) : {};
    const response = await axios(withKeepAlive({
      method: upper,
      url: `${this.config.restUrl}${pathWithQuery}`,
      headers,
      data: data || undefined,
      timeout
    }));
    const payload = response?.data || {};
    if (Number(payload.retCode) !== 0) {
      throw new Error(`Bybit ${path} failed: ${payload.retMsg || 'unknown'} (code=${payload.retCode ?? 'n/a'})`);
    }
    return payload.result ?? payload;
  }

  async #loadInstruments() {
    const rows = await this.#request('GET', '/v5/market/instruments-info', {
      params: { category: CATEGORY, limit: 1000 }
    });
    const list = Array.isArray(rows?.list) ? rows.list : [];
    this._instrumentBySymbol.clear();
    for (const row of list) {
      if (String(row.status || '').toLowerCase() !== 'trading') continue;
      if (String(row.quoteCoin || '').toUpperCase() !== 'USDT') continue;
      const sym = String(row.symbol || '').toUpperCase();
      if (sym) this._instrumentBySymbol.set(sym, row);
    }
  }

  async getSymbols() {
    if (this._instrumentBySymbol.size === 0) await this.#loadInstruments();
    return [...this._instrumentBySymbol.keys()].map((s) => this.normalizeSymbol(s));
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
      ws.on('open', () => {
        tuneWebSocket(ws);
        this.connected = true;
        if (this.subscribedSymbols.length > 0) {
          this.#subscribeTopics(this.subscribedSymbols);
        }
        this.#startFeedWatchdog();
        this.emit('PUBLIC_WS_RECONNECTED', { exchange: 'bybit', reason: 'public-ws-open', clearCache: false });
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', () => {
        this.connected = false;
        this.#stopFeedWatchdog();
        if (!this._shuttingDown) {
          setTimeout(() => this.connectWebSocket().catch(() => {}), 1000);
        }
      });
      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) reject(err);
      });
    });
  }

  #subscribeTopics(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const args = symbols.map((s) => `orderbook.1.${this.toExchangeSymbol(s)}`);
    for (let i = 0; i < args.length; i += 10) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 10) }));
    }
  }

  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribedSymbols = symbols.map((s) => this.normalizeSymbol(s));
    this.subscribedChannels = [...channels];
    const now = Date.now();
    for (const symbol of this.subscribedSymbols) {
      await super.subscribe(symbol, channels);
      if (!this._lastSymbolMessageAt.has(symbol)) this._lastSymbolMessageAt.set(symbol, now);
    }
    this.#subscribeTopics(this.subscribedSymbols);
  }

  #emitBookTicker(ticker, { viaRest = false, receiveLocalTs = null } = {}) {
    const localTs = receiveLocalTs ?? Date.now();
    const sym = this.normalizeSymbol(ticker.symbol);
    this._lastSymbolMessageAt.set(sym, localTs);
    this.emit(EventTypes.TICKER, {
      ...ticker,
      symbol: sym,
      localTimestamp: localTs,
      wsDelayMs: viaRest ? null : ticker.wsDelayMs,
      source: 'bybit',
      viaRest
    });
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.op === 'subscribe' || msg?.success === false) return;
      const topic = String(msg?.topic || '');
      if (!topic.startsWith('orderbook.1.')) return;
      const data = msg?.data;
      if (!data?.s) return;
      const bid = Number(data.b?.[0]?.[0]);
      const ask = Number(data.a?.[0]?.[0]);
      if (!isFinitePositive(bid) || !isFinitePositive(ask)) return;
      const localTs = Date.now();
      const exchangeTs = Number(data.ts ?? msg.ts);
      let wsDelayMs = Number.isFinite(exchangeTs) ? Math.max(0, localTs - exchangeTs) : null;
      let timestamp = Number.isFinite(exchangeTs) ? exchangeTs : localTs;
      if (Number.isFinite(exchangeTs) && wsDelayMs > MAX_SANE_WS_DELAY_MS) {
        timestamp = localTs;
        wsDelayMs = null;
      }
      this.#emitBookTicker({
        symbol: data.s,
        bid,
        ask,
        bidQty: Number(data.b?.[0]?.[1]) || null,
        askQty: Number(data.a?.[0]?.[1]) || null,
        timestamp,
        serverTimestamp: exchangeTs,
        wsDelayMs
      }, { receiveLocalTs: localTs });
    } catch {
      // ignore
    }
  }

  #startFeedWatchdog() {
    this.#stopFeedWatchdog();
    this._feedWatchdog = setInterval(() => {
      if (this._shuttingDown || this.subscribedSymbols.length === 0) return;
      const stale = this.subscribedSymbols.filter((sym) => {
        const last = this._lastSymbolMessageAt.get(sym);
        return last != null && Date.now() - last > this._symbolStaleMs;
      });
      if (stale.length > 0 && !this._restRefreshPending) {
        this._restRefreshPending = true;
        Promise.all(stale.map((s) => this.getBookTicker(s, { reason: 'watchdog' })
          .then((row) => this.#emitBookTicker(row, { viaRest: true }))
          .catch(() => {}))).finally(() => { this._restRefreshPending = false; });
      }
    }, 3000);
    if (typeof this._feedWatchdog.unref === 'function') this._feedWatchdog.unref();
  }

  #stopFeedWatchdog() {
    if (this._feedWatchdog) {
      clearInterval(this._feedWatchdog);
      this._feedWatchdog = null;
    }
  }

  async getBookTicker(symbol, options = {}) {
    const sym = this.toExchangeSymbol(symbol);
    const result = await this.#request('GET', '/v5/market/tickers', {
      params: { category: CATEGORY, symbol: sym },
      timeout: Number(options.timeoutMs) || 5000
    });
    const row = (result?.list || [])[0] || {};
    const bid = Number(row.bid1Price);
    const ask = Number(row.ask1Price);
    if (!isFinitePositive(bid) || !isFinitePositive(ask)) {
      throw new Error(`Invalid Bybit ticker ${sym}`);
    }
    return {
      symbol: this.normalizeSymbol(sym),
      bid,
      ask,
      timestamp: Number(row.ts) || Date.now(),
      serverTimestamp: Number(row.ts) || null,
      restReason: options.reason ?? 'rest'
    };
  }

  async getFundingRate(symbol) {
    const sym = this.toExchangeSymbol(symbol);
    const result = await this.#request('GET', '/v5/market/tickers', {
      params: { category: CATEGORY, symbol: sym }
    });
    const row = (result?.list || [])[0] || {};
    return Number(row.fundingRate);
  }

  async setSymbolLeverage(symbol, leverage = 1) {
    const sym = this.toExchangeSymbol(symbol);
    const lev = String(Math.max(1, Math.min(100, Math.floor(Number(leverage) || 1))));
    await this.#request('POST', '/v5/position/set-leverage', {
      data: { category: CATEGORY, symbol: sym, buyLeverage: lev, sellLeverage: lev },
      auth: true
    });
    return { symbol: sym, leverage: Number(lev), maxNotionalValue: null };
  }

  async getBalance(options = {}) {
    const result = await this.#request('GET', '/v5/account/wallet-balance', {
      params: { accountType: 'UNIFIED', coin: 'USDT' },
      auth: true
    });
    const list = Array.isArray(result?.list) ? result.list : [];
    const coins = Array.isArray(list[0]?.coin) ? list[0].coin : [];
    const balances = coins
      .map((row) => {
        const currency = String(row.coin || '').toUpperCase();
        if (!currency) return null;
        const total = Number(row.equity ?? row.walletBalance ?? 0);
        const available = Number(row.availableToWithdraw ?? row.availableBalance ?? total);
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

  async getPositions(options = {}) {
    const result = await this.#request('GET', '/v5/position/list', {
      params: { category: CATEGORY, settleCoin: 'USDT', limit: 200 },
      auth: true
    });
    const positions = (result?.list || [])
      .filter((r) => Math.abs(Number(r.size)) > 0)
      .map((r) => {
        const sym = String(r.symbol || '').toUpperCase();
        const qty = Number(r.size) * (String(r.side).toLowerCase() === 'sell' ? -1 : 1);
        return new Position({
          symbol: this.toCompactSymbol(sym),
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(r.avgPrice || 0),
          markPrice: Number(r.markPrice || 0),
          unrealizedPnl: Number(r.unrealisedPnl || 0),
          leverage: Number(r.leverage || 1),
          timestamp: Date.now()
        });
      });
    this._positionCache.clear();
    for (const p of positions) this._positionCache.set(p.symbol, p);
    if (!options.silent) this.emitPositionUpdate(positions);
    return positions;
  }

  getPosition(asset) {
    return this._positionCache.get(this.toCompactSymbol(asset)) || null;
  }

  getAvailable(asset) {
    const cur = String(asset || 'USDT').toUpperCase();
    const row = (this._balanceCache || []).find((b) => b.currency === cur);
    return row?.available ?? 0;
  }

  #mapOrderStatus(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'new' || s === 'created') return OrderStatus.OPEN;
    if (s === 'partiallyfilled') return OrderStatus.PARTIALLY_FILLED;
    if (s === 'filled') return OrderStatus.FILLED;
    if (s === 'cancelled' || s === 'canceled') return OrderStatus.CANCELLED;
    return OrderStatus.PENDING;
  }

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const sym = this.toExchangeSymbol(orderData.symbol);
    const side = String(orderData.side || '').toLowerCase() === 'sell' ? 'Sell' : 'Buy';
    const type = String(orderData.type || '').toLowerCase() === 'limit' ? 'Limit' : 'Market';
    const qty = Number(orderData.amount);
    if (!(qty > 0)) throw new Error('Bybit order qty must be > 0');
    const payload = {
      category: CATEGORY,
      symbol: sym,
      side,
      orderType: type,
      qty: String(qty),
      orderLinkId: orderData.clientOrderId || this.generateClientOrderId(),
      positionIdx: 0
    };
    if (type === 'Limit' && orderData.price) payload.price = String(orderData.price);
    if (orderData.reduceOnly) payload.reduceOnly = true;
    const result = await this.#request('POST', '/v5/order/create', { data: payload, auth: true });
    const orderId = String(result?.orderId || '');
    if (!orderId) throw new Error('Bybit placeOrder missing orderId');
    return new Order({
      orderId,
      clientOrderId: result?.orderLinkId || payload.orderLinkId,
      symbol: this.normalizeSymbol(sym),
      exchange: this.config.name,
      side: side.toLowerCase(),
      type: type.toLowerCase(),
      amount: qty,
      price: Number(orderData.price || 0),
      status: OrderStatus.PENDING,
      filled: 0,
      timestamp: Date.now()
    });
  }

  async cancelOrder(orderId, symbol) {
    const sym = this.toExchangeSymbol(symbol);
    return this.#request('POST', '/v5/order/cancel', {
      data: { category: CATEGORY, symbol: sym, orderId: String(orderId) },
      auth: true
    });
  }

  #mapOrderRow(row, orderId, sym) {
    const filled = Number(row.cumExecQty || 0);
    const avg = Number(row.avgPrice || 0);
    return new Order({
      orderId: String(row.orderId || orderId),
      clientOrderId: row.orderLinkId || null,
      symbol: this.normalizeSymbol(row.symbol || sym),
      exchange: this.config.name,
      side: String(row.side || '').toLowerCase(),
      type: String(row.orderType || '').toLowerCase(),
      amount: Number(row.qty || 0),
      price: Number(row.price || 0),
      status: this.#mapOrderStatus(row.orderStatus),
      filled,
      timestamp: Number(row.createdTime || Date.now()),
      updateTime: Number(row.updatedTime || row.createdTime || Date.now()),
      avgPrice: avg,
      cumQuote: Number(row.cumExecValue || (filled > 0 && avg > 0 ? filled * avg : 0))
    });
  }

  async getOrderStatus(orderId, symbol) {
    const sym = this.toExchangeSymbol(symbol);
    const result = await this.#request('GET', '/v5/order/realtime', {
      params: { category: CATEGORY, symbol: sym, orderId: String(orderId) },
      auth: true
    });
    const row = (result?.list || [])[0];
    if (row) return this.#mapOrderRow(row, orderId, sym);
    const hist = await this.#request('GET', '/v5/order/history', {
      params: { category: CATEGORY, symbol: sym, orderId: String(orderId), limit: 1 },
      auth: true
    });
    const histRow = (hist?.list || [])[0];
    if (!histRow) throw new Error(`Bybit order not found: ${orderId} ${sym}`);
    return this.#mapOrderRow(histRow, orderId, sym);
  }

  async getOrderHistory(symbol, limit = 100) {
    const sym = this.toExchangeSymbol(symbol);
    const result = await this.#request('GET', '/v5/order/history', {
      params: { category: CATEGORY, symbol: sym, limit: Math.min(Math.max(Number(limit) || 100, 1), 100) },
      auth: true
    });
    return (result?.list || []).map((row) => this.#mapOrderRow(row, row.orderId, sym));
  }

  async getOrderTrades(orderId, symbol) {
    const sym = this.toExchangeSymbol(symbol);
    const result = await this.#request('GET', '/v5/execution/list', {
      params: { category: CATEGORY, symbol: sym, orderId: String(orderId), limit: 100 },
      auth: true
    });
    return (result?.list || []).map((row) => {
      const qty = Math.abs(Number(row.execQty || 0));
      const price = Number(row.execPrice || 0);
      return {
        contracts: qty,
        size: qty,
        qty,
        price,
        quoteQty: Number(row.execValue || qty * price),
        fee: Math.abs(Number(row.execFee || 0)),
        feeAsset: String(row.feeCurrency || 'USDT').toUpperCase()
      };
    });
  }

  async getOrderCommission(orderId, symbol) {
    const trades = await this.getOrderTrades(orderId, symbol);
    return trades.reduce((fee, row) => fee + (row.feeAsset === 'USDT' ? row.fee : 0), 0);
  }

  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, { legRole: params?.legRole || 'B', ...params, futuresMode: true });
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    return true;
  }

  handleWebSocketMessage(message) {
    this.handleMessage(message);
  }
}

export default BybitAdapter;
