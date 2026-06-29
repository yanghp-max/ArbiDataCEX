/**
 * Bitget USDT-M futures adapter (UTA v3 API).
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
const CATEGORY = 'USDT-FUTURES';
const MARGIN_COIN = 'USDT';
/** place-order 超时/未知错误：需用 clientOid 反查最终结果 */
const AMBIGUOUS_SUBMIT_ERROR_CODES = new Set(['40010', '40725', '45001']);

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_/]/g, '').toUpperCase();
}

function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export class BitgetAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Bitget',
      wsUrl: process.env.BITGET_WS_URL || 'wss://ws.bitget.com/v2/ws/public',
      restUrl: process.env.BITGET_REST_URL || 'https://api.bitget.com',
      apiUrl: process.env.BITGET_REST_URL || 'https://api.bitget.com',
      ...config
    });
    this.id = 'bitget';
    this.enablePublicStream = config.enablePublicStream !== false;
    this.subscribedSymbols = [];
    this._instrumentBySymbol = new Map();
    this._balanceCache = null;
    this._positionCache = new Map();
    this._lastSymbolMessageAt = new Map();
    this._feedWatchdog = null;
    this._restRefreshPending = false;
    this._shuttingDown = false;
    this._symbolStaleMs = Number(config.symbolStaleMs) || 900;
    this._wsPingTimer = null;
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
    if (process.env.BITGET_API_KEY && process.env.BITGET_API_SECRET && process.env.BITGET_API_PASSPHRASE) {
      this.authenticated = true;
      await this.#loadInstruments().catch((err) => {
        console.warn('[Bitget] preload instruments failed:', err.message);
      });
    }
    await super.connect();
  }

  async disconnect() {
    this._shuttingDown = true;
    this.#stopFeedWatchdog();
    this.#stopWsPing();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await super.disconnect();
  }

  async getAuthHeaders(method = 'GET', requestPath = '', bodyText = '') {
    const apiKey = String(process.env.BITGET_API_KEY || '').trim();
    const apiSecret = String(process.env.BITGET_API_SECRET || '').trim();
    const passphrase = String(process.env.BITGET_API_PASSPHRASE || '').trim();
    if (!apiKey || !apiSecret || !passphrase) {
      throw new Error('Bitget auth missing: BITGET_API_KEY / BITGET_API_SECRET / BITGET_API_PASSPHRASE');
    }
    const ts = String(Date.now());
    const prehash = `${ts}${String(method || 'GET').toUpperCase()}${requestPath}${bodyText}`;
    const sign = crypto.createHmac('sha256', apiSecret).update(prehash).digest('base64');
    return {
      'Content-Type': 'application/json',
      'ACCESS-KEY': apiKey,
      'ACCESS-SIGN': sign,
      'ACCESS-TIMESTAMP': ts,
      'ACCESS-PASSPHRASE': passphrase,
      locale: 'en-US'
    };
  }

  #asArray(data, listKey = 'list') {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data[listKey])) return data[listKey];
    return data ? [data] : [];
  }

  #pickRow(data) {
    if (Array.isArray(data)) return data[0] ?? null;
    return data ?? null;
  }

  #extractErrorCode(err) {
    const match = String(err?.message || '').match(/\(code=(\d+)\)/);
    return match ? match[1] : null;
  }

  #isAmbiguousSubmitError(err) {
    const code = this.#extractErrorCode(err);
    if (code && AMBIGUOUS_SUBMIT_ERROR_CODES.has(code)) return true;
    const msg = String(err?.message || '');
    return /request timed out|service return an error|unknown error/i.test(msg);
  }

  #isOrderNotFoundError(err) {
    const msg = String(err?.message || '');
    return /not found|43001|40768|40017|does not exist/i.test(msg);
  }

  async #fetchOrderInfo({ orderId = null, clientOid = null } = {}) {
    const params = {};
    if (orderId) params.orderId = String(orderId);
    else if (clientOid) params.clientOid = String(clientOid);
    else return null;
    try {
      const row = await this.#request('GET', '/api/v3/trade/order-info', { params, auth: true });
      if (!row || (!row.orderId && !row.clientOid)) return null;
      return row;
    } catch (err) {
      if (this.#isOrderNotFoundError(err)) return null;
      throw err;
    }
  }

  async #resolvePlacedOrder(row, { clientOid, sym, side, type, qty, orderData }) {
    let resolved = row;
    if (!String(resolved?.orderId || '')) {
      const looked = await this.#fetchOrderInfo({ clientOid });
      if (looked) resolved = looked;
    }
    const orderId = String(resolved?.orderId || '');
    if (!orderId) {
      throw new Error(`Bitget placeOrder missing orderId after clientOid lookup: ${clientOid} ${sym}`);
    }
    if (resolved.orderStatus != null || resolved.cumExecQty != null) {
      return this.#mapOrderRow(resolved, orderId, sym);
    }
    return new Order({
      orderId,
      clientOrderId: resolved.clientOid || clientOid,
      symbol: this.normalizeSymbol(sym),
      exchange: this.config.name,
      side,
      type,
      amount: qty,
      price: Number(orderData.price || 0),
      status: OrderStatus.PENDING,
      filled: 0,
      timestamp: Date.now()
    });
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
    const requestPath = `${path}${query}`;
    const bodyText = data ? JSON.stringify(data) : '';
    const headers = auth ? await this.getAuthHeaders(upper, requestPath, bodyText) : {};
    const response = await axios(withKeepAlive({
      method: upper,
      url: `${this.config.restUrl}${requestPath}`,
      headers,
      data: data || undefined,
      timeout
    }));
    const payload = response?.data || {};
    if (String(payload.code) !== '00000') {
      throw new Error(`Bitget ${path} failed: ${payload.msg || 'unknown'} (code=${payload.code ?? 'n/a'})`);
    }
    return payload.data ?? payload;
  }

  async #loadInstruments() {
    const rows = await this.#request('GET', '/api/v3/market/instruments', {
      params: { category: CATEGORY }
    });
    const list = Array.isArray(rows) ? rows : [];
    this._instrumentBySymbol.clear();
    for (const row of list) {
      const status = String(row.status || row.symbolStatus || '').toLowerCase();
      if (status !== 'online' && status !== 'normal') continue;
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
        if (this.subscribedSymbols.length > 0) this.#subscribeTopics(this.subscribedSymbols);
        this.#startWsPing();
        this.#startFeedWatchdog();
        this.emit('PUBLIC_WS_RECONNECTED', { exchange: 'bitget', reason: 'public-ws-open', clearCache: false });
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', () => {
        this.connected = false;
        this.#stopFeedWatchdog();
        this.#stopWsPing();
        if (!this._shuttingDown) {
          setTimeout(() => this.connectWebSocket().catch(() => {}), 1000);
        }
      });
      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) reject(err);
      });
    });
  }

  #startWsPing() {
    this.#stopWsPing();
    this._wsPingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, 25000);
    if (typeof this._wsPingTimer.unref === 'function') this._wsPingTimer.unref();
  }

  #stopWsPing() {
    if (this._wsPingTimer) {
      clearInterval(this._wsPingTimer);
      this._wsPingTimer = null;
    }
  }

  #subscribeTopics(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const args = symbols.map((s) => ({
      instType: CATEGORY,
      channel: 'books1',
      instId: this.toExchangeSymbol(s)
    }));
    for (let i = 0; i < args.length; i += 50) {
      this.ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 50) }));
    }
  }

  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribedSymbols = symbols.map((s) => this.normalizeSymbol(s));
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
      source: 'bitget',
      viaRest
    });
  }

  handleMessage(raw) {
    const text = raw.toString();
    if (text === 'pong') return;
    try {
      const msg = JSON.parse(text);
      if (msg?.event === 'subscribe' || msg?.event === 'error') return;
      const row = Array.isArray(msg?.data) ? msg.data[0] : msg?.data;
      const instId = String(row?.instId || msg?.arg?.instId || '');
      if (!instId || !row) return;
      const bid = Number(Array.isArray(row.bids) ? row.bids[0]?.[0] : row.bestBid);
      const ask = Number(Array.isArray(row.asks) ? row.asks[0]?.[0] : row.bestAsk);
      if (!isFinitePositive(bid) || !isFinitePositive(ask)) return;
      const localTs = Date.now();
      const exchangeTs = Number(row.ts ?? msg.ts);
      let wsDelayMs = Number.isFinite(exchangeTs) ? Math.max(0, localTs - exchangeTs) : null;
      let timestamp = Number.isFinite(exchangeTs) ? exchangeTs : localTs;
      if (Number.isFinite(exchangeTs) && wsDelayMs > MAX_SANE_WS_DELAY_MS) {
        timestamp = localTs;
        wsDelayMs = null;
      }
      this.#emitBookTicker({
        symbol: instId,
        bid,
        ask,
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
    const rows = await this.#request('GET', '/api/v3/market/tickers', {
      params: { category: CATEGORY, symbol: sym },
      timeout: Number(options.timeoutMs) || 5000
    });
    const row = this.#pickRow(rows);
    const bid = Number(row?.bid1Price ?? row?.bidPr ?? row?.bestBid);
    const ask = Number(row?.ask1Price ?? row?.askPr ?? row?.bestAsk);
    if (!isFinitePositive(bid) || !isFinitePositive(ask)) {
      throw new Error(`Invalid Bitget ticker ${sym}`);
    }
    return {
      symbol: this.normalizeSymbol(sym),
      bid,
      ask,
      timestamp: Number(row?.ts) || Date.now(),
      serverTimestamp: Number(row?.ts) || null,
      restReason: options.reason ?? 'rest'
    };
  }

  async getFundingRate(symbol) {
    const sym = this.toExchangeSymbol(symbol);
    const rows = await this.#request('GET', '/api/v3/market/current-fund-rate', {
      params: { category: CATEGORY, symbol: sym }
    });
    const row = this.#pickRow(rows);
    return Number(row?.fundingRate);
  }

  async setSymbolLeverage(symbol, leverage = 1) {
    const sym = this.toExchangeSymbol(symbol);
    const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
    await this.#request('POST', '/api/v3/account/set-leverage', {
      data: {
        category: CATEGORY,
        symbol: sym,
        leverage: String(lev),
        marginMode: 'crossed'
      },
      auth: true
    });
    return { symbol: sym, leverage: lev, maxNotionalValue: null };
  }

  async getBalance(options = {}) {
    const data = await this.#request('GET', '/api/v3/account/assets', { auth: true });
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    const usdtRow = assets.find((row) => String(row.coin || '').toUpperCase() === MARGIN_COIN);
    const total = Number(usdtRow?.equity ?? data?.usdtEquity ?? data?.accountEquity ?? 0);
    const available = Number(usdtRow?.available ?? total);
    const balances = total > 0 || available > 0
      ? [new Balance({
        currency: MARGIN_COIN,
        exchange: this.config.name,
        total,
        available,
        marginUsed: Math.max(0, total - available),
        frozen: Math.max(0, total - available),
        timestamp: Date.now()
      })]
      : [];
    this._balanceCache = balances;
    if (!options.silent) this.emitBalanceUpdate(balances);
    return balances;
  }

  async getPositions(options = {}) {
    const data = await this.#request('GET', '/api/v3/position/current-position', {
      params: { category: CATEGORY },
      auth: true
    });
    const list = this.#asArray(data, 'list');
    const positions = list
      .filter((r) => Math.abs(Number(r.total)) > 0)
      .map((r) => {
        const sym = String(r.symbol || '').toUpperCase();
        const posSide = String(r.posSide || r.holdSide || '').toLowerCase();
        const qtyRaw = Number(r.total || 0);
        const qty = posSide === 'short' ? -qtyRaw : qtyRaw;
        return new Position({
          symbol: this.toCompactSymbol(sym),
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(r.avgPrice || r.openPriceAvg || 0),
          markPrice: Number(r.markPrice || 0),
          unrealizedPnl: Number(r.unrealisedPnl || r.unrealizedPL || 0),
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
    if (s === 'live' || s === 'new') return OrderStatus.OPEN;
    if (s === 'partially_filled') return OrderStatus.PARTIALLY_FILLED;
    if (s === 'filled') return OrderStatus.FILLED;
    if (s === 'cancelled' || s === 'canceled') return OrderStatus.CANCELLED;
    return OrderStatus.PENDING;
  }

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const sym = this.toExchangeSymbol(orderData.symbol);
    const side = String(orderData.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
    const type = String(orderData.type || '').toLowerCase() === 'limit' ? 'limit' : 'market';
    const qty = Number(orderData.amount);
    if (!(qty > 0)) throw new Error('Bitget order size must be > 0');
    const payload = {
      category: CATEGORY,
      symbol: sym,
      marginMode: 'crossed',
      side,
      orderType: type,
      qty: String(qty),
      clientOid: orderData.clientOrderId || this.generateClientOrderId(),
      timeInForce: type === 'market' ? 'ioc' : 'gtc'
    };
    if (type === 'limit' && orderData.price) payload.price = String(orderData.price);
    if (orderData.reduceOnly) payload.reduceOnly = 'yes';
    const clientOid = payload.clientOid;
    let row;
    try {
      row = await this.#request('POST', '/api/v3/trade/place-order', { data: payload, auth: true });
    } catch (err) {
      if (!this.#isAmbiguousSubmitError(err)) throw err;
      row = await this.#fetchOrderInfo({ clientOid });
      if (!row) throw err;
    }
    return this.#resolvePlacedOrder(row, {
      clientOid,
      sym,
      side,
      type,
      qty,
      orderData
    });
  }

  async cancelOrder(orderId, symbol) {
    return this.#request('POST', '/api/v3/trade/cancel-order', {
      data: {
        category: CATEGORY,
        orderId: String(orderId)
      },
      auth: true
    });
  }

  #mapOrderRow(row, orderId, sym) {
    const filled = Number(row.cumExecQty ?? row.baseVolume ?? row.filledQty ?? 0);
    const avg = Number(row.avgPrice ?? row.priceAvg ?? row.averagePrice ?? 0);
    return new Order({
      orderId: String(row.orderId || orderId),
      clientOrderId: row.clientOid || null,
      symbol: this.normalizeSymbol(row.symbol || sym),
      exchange: this.config.name,
      side: String(row.side || '').toLowerCase(),
      type: String(row.orderType || '').toLowerCase(),
      amount: Number(row.qty ?? row.size ?? 0),
      price: Number(row.price ?? 0),
      status: this.#mapOrderStatus(row.orderStatus ?? row.state ?? row.status),
      filled,
      timestamp: Number(row.createdTime || row.cTime || Date.now()),
      updateTime: Number(row.updatedTime || row.uTime || row.createdTime || Date.now()),
      avgPrice: avg,
      cumQuote: Number(row.cumExecValue ?? row.quoteVolume ?? (filled > 0 && avg > 0 ? filled * avg : 0))
    });
  }

  async getOrderStatus(orderId, symbol, options = {}) {
    const sym = this.toExchangeSymbol(symbol);
    const oid = String(orderId);
    let row = await this.#fetchOrderInfo({ orderId: oid });
    if (!row && options.clientOid) {
      row = await this.#fetchOrderInfo({ clientOid: options.clientOid });
    }
    if (row) return this.#mapOrderRow(row, oid, sym);

    const history = await this.#request('GET', '/api/v3/trade/history-orders', {
      params: {
        category: CATEGORY,
        symbol: sym,
        limit: '100'
      },
      auth: true
    });
    const list = this.#asArray(history, 'list');
    const histRow = list.find((item) => String(item.orderId) === oid);
    if (histRow) return this.#mapOrderRow(histRow, oid, sym);

    const unfilled = await this.#request('GET', '/api/v3/trade/unfilled-orders', {
      params: {
        category: CATEGORY,
        symbol: sym,
        limit: '100'
      },
      auth: true
    });
    const openList = this.#asArray(unfilled, 'list');
    const openRow = openList.find((item) => String(item.orderId) === oid);
    if (openRow) return this.#mapOrderRow(openRow, oid, sym);

    throw new Error(`Bitget order not found: ${oid} ${sym}`);
  }

  async getOrderHistory(symbol, limit = 100) {
    const sym = this.toExchangeSymbol(symbol);
    const data = await this.#request('GET', '/api/v3/trade/history-orders', {
      params: {
        category: CATEGORY,
        symbol: sym,
        limit: String(Math.min(Math.max(Number(limit) || 100, 1), 100))
      },
      auth: true
    });
    const list = this.#asArray(data, 'list');
    return list.map((row) => this.#mapOrderRow(row, row.orderId, sym));
  }

  async getOrderTrades(orderId, symbol) {
    const sym = this.toExchangeSymbol(symbol);
    const data = await this.#request('GET', '/api/v3/trade/fills', {
      params: {
        category: CATEGORY,
        symbol: sym,
        orderId: String(orderId),
        limit: '100'
      },
      auth: true
    });
    const list = this.#asArray(data, 'list');
    return list.map((row) => {
      const qty = Math.abs(Number(row.execQty ?? row.baseVolume ?? row.size ?? 0));
      const price = Number(row.execPrice ?? row.priceAvg ?? row.price ?? 0);
      const feeRows = Array.isArray(row.feeDetail) ? row.feeDetail : [];
      const feeRow = feeRows[0] || {};
      return {
        contracts: qty,
        size: qty,
        qty,
        price,
        quoteQty: Number(row.execValue ?? row.quoteVolume ?? qty * price),
        fee: Math.abs(Number(feeRow.fee ?? row.fee ?? 0)),
        feeAsset: String(feeRow.feeCoin || row.feeCoin || 'USDT').toUpperCase()
      };
    });
  }

  async getOrderCommission(orderId, symbol) {
    const trades = await this.getOrderTrades(orderId, symbol);
    return trades.reduce((fee, row) => fee + (row.feeAsset === 'USDT' ? row.fee : 0), 0);
  }

  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, {
      ...params,
      legRole: params?.legRole ?? 'B',
      futuresMode: true
    });
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    return true;
  }

  handleWebSocketMessage(message) {
    this.handleMessage(message);
  }
}

export default BitgetAdapter;
