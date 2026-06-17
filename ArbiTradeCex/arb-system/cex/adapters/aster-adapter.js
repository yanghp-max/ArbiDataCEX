/**
 * Aster Futures 适配器（接口风格对齐 BinanceAdapter）
 * 说明：当前实现已切换到 v3 REST 路径；签名暂沿用现有实现。
 */
import WebSocket from 'ws';
import axios from 'axios';
import { Wallet } from 'ethers';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { cryptoUtils } from '../utils.js';
import {
  checkOrderPreconditions as runCheckOrderPreconditions
} from '../utils/check-order-preconditions.js';

export class AsterAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Aster',
      wsUrl: process.env.ASTER_WS_URL || 'wss://fstream.asterdex.com/ws',
      restUrl: process.env.ASTER_REST_URL || 'https://fapi.asterdex.com',
      apiUrl: process.env.ASTER_REST_URL || 'https://fapi.asterdex.com',
      ...config
    });

    this.id = 'aster';
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
    this._balanceCache = null;
    this._positionCache = new Map();
    this._lastNonce = 0n;
  }

  toCompactSymbol(symbol) {
    return String(symbol).replace(/[-_]/g, '');
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

  async reconnectWebSocket() {
    if (!this.enablePublicStream || this._shuttingDown) return;
    await this.connectWebSocket();
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    if (this.enablePublicStream) {
      await this.connectWebSocket();
    }
    if (process.env.ASTER_USER && process.env.ASTER_SIGNER && process.env.ASTER_PRIVATE_KEY) {
      this.authenticated = true;
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

  async getAuthHeaders() {
    return {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'ARB-System/1.0'
    };
  }

  async loadSymbols() {
    const response = await axios.get(`${this.config.restUrl}/fapi/v3/exchangeInfo`, {
      timeout: this.config.timeout
    });
    const set = new Set();
    for (const s of response.data.symbols || []) {
      if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
        set.add(String(s.symbol));
      }
    }
    return set;
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
          exchange: 'aster',
          reason: 'public-ws-open',
          clearCache: false
        });
        resolve();
      });
      ws.on('message', (raw) => this.handleMessage(raw));
      ws.on('close', () => {
        this.connected = false;
        this.#stopFeedWatchdog();
        if (this._shuttingDown) return;
        setTimeout(() => {
          this.connectWebSocket().catch(() => {});
        }, 1000);
      });
      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribedSymbols = symbols.map((symbol) => this.normalizeSymbol(symbol));
    this.subscribedChannels = [...channels];
    const subscribedAt = Date.now();
    for (const symbol of symbols) {
      const normalized = this.normalizeSymbol(symbol);
      await super.subscribe(normalized, channels);
      // 首条 WS 迟迟不来时，watchdog 也能识别 stale 并触发 REST 补价。
      if (!this._lastSymbolMessageAt.has(normalized)) {
        this._lastSymbolMessageAt.set(normalized, subscribedAt);
      }
      const exSymbol = this.toExchangeSymbol(symbol).toLowerCase();
      for (const ch of channels) {
        this.subscriptionQueue.push(`${exSymbol}@${ch}`);
      }
    }
    await this.#flushSubscriptions();
  }

  async #flushSubscriptions({ forceResubscribe = false } = {}) {
    const streams = new Set(this.subscriptionQueue);
    if (forceResubscribe || streams.size === 0) {
      for (const symbol of this.subscribedSymbols) {
        const exSymbol = this.toExchangeSymbol(symbol).toLowerCase();
        for (const ch of this.subscribedChannels) {
          streams.add(`${exSymbol}@${ch}`);
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
        const batch = this.subscriptionQueue.splice(0, 20);
        this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: Date.now() }));
        for (const stream of batch) this.activeSubscriptions.add(stream);
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.processing = false;
    }
  }

  #emitBookTicker(ticker, { viaRest = false, restReason = null } = {}) {
    const localTs = Date.now();
    const sym = this.normalizeSymbol(ticker.symbol);
    this._lastSymbolMessageAt.set(sym, localTs);
    this.emit(EventTypes.TICKER, {
      ...ticker,
      symbol: sym,
      localTimestamp: localTs,
      wsDelayMs: viaRest ? null : ticker.wsDelayMs,
      source: 'aster',
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
        console.warn(`[Aster] REST bookTicker refresh ${symbol} (${reason}):`, err.message);
      }
    }));
  }

  #startFeedWatchdog() {
    this.#stopFeedWatchdog();
    this._feedWatchdog = setInterval(() => {
      if (this._shuttingDown || this.subscribedSymbols.length === 0) return;
      const staleSymbols = this.subscribedSymbols.filter((sym) => {
        const key = this.normalizeSymbol(sym);
        const last = this._lastSymbolMessageAt.get(key);
        if (last == null) return false;
        return Date.now() - last > this._symbolStaleMs;
      });
      if (staleSymbols.length > 0 && !this._restRefreshPending) {
        this._restRefreshPending = true;
        this.#refreshBookTickerViaRest('watchdog-per-symbol', staleSymbols).finally(() => {
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
      const payload = msg?.data && (msg.stream || msg.data?.s) ? msg.data : msg;
      if (payload?.e && payload.e !== 'bookTicker') return;
      if (!(payload?.s && payload.b != null && payload.a != null)) return;

      const bid = Number(payload.b);
      const ask = Number(payload.a);
      if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) return;

      const localTs = Date.now();
      const rawEventTs = payload.E ?? payload.T ?? null;
      const exchangeMsRaw = rawEventTs != null && Number.isFinite(Number(rawEventTs))
        ? (Number(rawEventTs) > 1e12 ? Number(rawEventTs) : Number(rawEventTs) * 1000)
        : null;
      const wsDelayMs = exchangeMsRaw != null ? Math.max(0, localTs - exchangeMsRaw) : null;
      const ticker = {
        symbol: this.normalizeSymbol(payload.s),
        bid,
        ask,
        timestamp: exchangeMsRaw ?? localTs,
        serverTimestamp: rawEventTs,
        wsDelayMs
      };
      this.#emitBookTicker(ticker);
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v3/premiumIndex`, {
      params: { symbol: this.toExchangeSymbol(symbol) },
      timeout: this.config.timeout
    });
    return Number(data.lastFundingRate);
  }

  async setSymbolLeverage(symbol, leverage = 1) {
    const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
    const response = await this.#signedRequest('POST', '/fapi/v3/leverage', {
      symbol: this.toExchangeSymbol(symbol),
      leverage: String(lev)
    });
    return {
      symbol: this.toCompactSymbol(symbol),
      leverage: Number(response?.leverage ?? lev),
      maxNotionalValue: response?.maxNotionalValue != null ? Number(response.maxNotionalValue) : null
    };
  }

  #nextNonceMicros() {
    const now = BigInt(Date.now()) * 1000n;
    if (now <= this._lastNonce) {
      this._lastNonce += 1n;
    } else {
      this._lastNonce = now;
    }
    return this._lastNonce.toString();
  }

  async #buildV3SignedPayload(params = {}) {
    const user = String(process.env.ASTER_USER || '').trim();
    const signer = String(process.env.ASTER_SIGNER || '').trim();
    const privateKey = String(process.env.ASTER_PRIVATE_KEY || '').trim();
    if (!user || !signer || !privateKey) {
      throw new Error('Aster v3 auth missing: ASTER_USER / ASTER_SIGNER / ASTER_PRIVATE_KEY');
    }

    const normalizedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new Wallet(normalizedPrivateKey);
    const payload = {
      ...params,
      user,
      signer,
      nonce: this.#nextNonceMicros()
    };
    const encoded = new URLSearchParams(
      Object.entries(payload).reduce((acc, [k, v]) => {
        if (v == null) return acc;
        acc[k] = String(v);
        return acc;
      }, {})
    ).toString();

    const signature = await wallet.signTypedData(
      {
        name: 'AsterSignTransaction',
        version: '1',
        chainId: 1666,
        verifyingContract: '0x0000000000000000000000000000000000000000'
      },
      {
        Message: [{ name: 'msg', type: 'string' }]
      },
      {
        msg: encoded
      }
    );

    return { encoded, signature };
  }

  async #signedRequest(method, path, params = {}) {
    const { encoded, signature } = await this.#buildV3SignedPayload(params);
    const upperMethod = String(method || 'GET').toUpperCase();
    const headers = await this.getAuthHeaders();
    const url = `${this.config.restUrl}${path}`;
    const signedBody = `${encoded}&signature=${signature}`;
    const requestConfig = {
      method: upperMethod,
      headers,
      timeout: 15000
    };
    if (upperMethod === 'GET') {
      requestConfig.url = `${url}?${signedBody}`;
    } else {
      requestConfig.url = url;
      requestConfig.data = signedBody;
    }
    const { data } = await axios({
      ...requestConfig
    });
    return data;
  }

  #mapOrderStatus(status) {
    const map = {
      NEW: OrderStatus.OPEN,
      PARTIALLY_FILLED: OrderStatus.PARTIALLY_FILLED,
      FILLED: OrderStatus.FILLED,
      CANCELED: OrderStatus.CANCELLED,
      REJECTED: OrderStatus.REJECTED,
      EXPIRED: OrderStatus.CANCELLED
    };
    return map[status] || OrderStatus.PENDING;
  }

  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, {
      ...params,
      futuresMode: true
    });
  }

  async getBookTicker(symbol, options = {}) {
    const exSymbol = this.toExchangeSymbol(symbol);
    const timeout = Number(options.timeoutMs) || this.config.timeout || 5000;
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v3/ticker/bookTicker`, {
      params: { symbol: exSymbol },
      timeout
    });
    const bid = Number(data.bidPrice);
    const ask = Number(data.askPrice);
    if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) {
      throw new Error(`Invalid bookTicker ${exSymbol}`);
    }
    const localTs = Date.now();
    return {
      symbol: this.normalizeSymbol(data.symbol || exSymbol),
      bid,
      ask,
      timestamp: localTs,
      serverTimestamp: null,
      restReason: options.reason ?? 'rest'
    };
  }

  async getOrderBook(symbol, limit = 20, options = {}) {
    const sym = this.toExchangeSymbol(symbol);
    const depthLimit = Math.min(Math.max(Number(limit) || 20, 5), 1000);
    const timeout = Number(options.timeoutMs) || 5000;
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v3/depth`, {
      params: { symbol: sym, limit: depthLimit },
      timeout
    });
    const parse = (rows) => (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        price: Number(Array.isArray(row) ? row[0] : row.price),
        size: Number(Array.isArray(row) ? row[1] : row.size)
      }))
      .filter((x) => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.size) && x.size > 0);
    return {
      bids: parse(data.bids).sort((a, b) => b.price - a.price),
      asks: parse(data.asks).sort((a, b) => a.price - b.price),
      timestamp: Date.now()
    };
  }

  async getBalance(options = {}) {
    const rows = await this.#signedRequest('GET', '/fapi/v3/balance');
    const balances = (rows || [])
      .map((row) => {
        const asset = String(row.asset || '').toUpperCase();
        if (!asset) return null;
        const total = Number(row.balance || 0);
        const available = Number(row.availableBalance || 0);
        if (total <= 1e-12 && available <= 1e-12) return null;
        return new Balance({
          currency: asset,
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
    if (!options.silent) {
      this.emitBalanceUpdate(balances);
    }
    return balances;
  }

  async getUsdtBalance() {
    const balances = await this.getBalance();
    const usdt = balances.find((b) => b.currency === 'USDT');
    const total = usdt?.available ?? 0;
    return { total, available: total, updatedAtMs: Date.now() };
  }

  async getPositions(options = {}) {
    const rows = await this.#signedRequest('GET', '/fapi/v3/positionRisk');
    const positions = (rows || [])
      .filter((r) => Math.abs(Number(r.positionAmt)) > 0)
      .map((r) => {
        const qty = Number(r.positionAmt);
        return new Position({
          symbol: this.toCompactSymbol(r.symbol),
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(r.entryPrice || 0),
          markPrice: Number(r.markPrice || 0),
          unrealizedPnl: Number(r.unRealizedProfit || 0),
          leverage: Number(r.leverage || 1),
          initialMargin: Number(r.initialMargin || 0),
          maintMargin: Number(r.maintMargin || 0),
          timestamp: Date.now()
        });
      });
    this._positionCache.clear();
    for (const p of positions) {
      this._positionCache.set(p.symbol, p);
    }
    if (!options.silent) {
      this.emitPositionUpdate(positions);
    }
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
    const side = String(orderData.side).toUpperCase();
    const type = String(orderData.type).toUpperCase();
    const params = {
      symbol: this.toExchangeSymbol(orderData.symbol),
      side,
      type,
      quantity: String(orderData.amount),
      newClientOrderId: orderData.clientOrderId || this.generateClientOrderId()
    };
    if (type === 'LIMIT' && orderData.price) {
      params.price = String(orderData.price);
      params.timeInForce = orderData.timeInForce || 'GTC';
    }
    if (orderData.reduceOnly) {
      params.reduceOnly = 'true';
    }
    const response = await this.#signedRequest('POST', '/fapi/v3/order', params);
    return new Order({
      orderId: String(response.orderId),
      clientOrderId: response.clientOrderId,
      symbol: this.normalizeSymbol(response.symbol),
      exchange: this.config.name,
      side: side.toLowerCase(),
      type: type.toLowerCase(),
      amount: Number(response.origQty || orderData.amount),
      price: Number(response.price || orderData.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled: Number(response.executedQty || 0),
      timestamp: response.transactTime || Date.now(),
      avgPrice: Number(response.avgPrice || 0),
      cumQuote: Number(response.cumQuote || 0)
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
    return this.#signedRequest('DELETE', '/fapi/v3/order', {
      symbol: this.toExchangeSymbol(symbol),
      orderId
    });
  }

  async getOrderStatus(orderId, symbol) {
    const response = await this.#signedRequest('GET', '/fapi/v3/order', {
      symbol: this.toExchangeSymbol(symbol),
      orderId
    });
    return new Order({
      orderId: String(response.orderId),
      clientOrderId: response.clientOrderId,
      symbol: this.normalizeSymbol(response.symbol),
      exchange: this.config.name,
      side: String(response.side).toLowerCase(),
      type: String(response.type).toLowerCase(),
      amount: Number(response.origQty),
      price: Number(response.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled: Number(response.executedQty || 0),
      timestamp: response.time,
      updateTime: response.updateTime,
      avgPrice: Number(response.avgPrice || 0),
      cumQuote: Number(response.cumQuote || 0)
    });
  }

  async getOrderHistory(symbol, limit = 100) {
    const response = await this.#signedRequest('GET', '/fapi/v3/allOrders', {
      symbol: this.toExchangeSymbol(symbol),
      limit
    });
    return (response || []).map((row) => new Order({
      orderId: String(row.orderId),
      clientOrderId: row.clientOrderId,
      symbol: this.normalizeSymbol(row.symbol),
      exchange: this.config.name,
      side: String(row.side).toLowerCase(),
      type: String(row.type).toLowerCase(),
      amount: Number(row.origQty),
      price: Number(row.price || 0),
      status: this.#mapOrderStatus(row.status),
      filled: Number(row.executedQty || 0),
      timestamp: row.time,
      updateTime: row.updateTime,
      avgPrice: Number(row.avgPrice || 0),
      cumQuote: Number(row.cumQuote || 0)
    }));
  }

  async getOrderTrades(orderId, symbol) {
    const rows = await this.#signedRequest('GET', '/fapi/v3/userTrades', {
      symbol: this.toExchangeSymbol(symbol),
      orderId
    });
    return (rows || []).map((row) => ({
      qty: Math.abs(Number(row.qty || 0)),
      price: Number(row.price || 0),
      quoteQty: Math.abs(Number(row.quoteQty || 0)),
      fee: Math.abs(Number(row.commission || 0)),
      feeAsset: String(row.commissionAsset || 'USDT').toUpperCase()
    }));
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

  async syncAccountSnapshot(options = {}) {
    await this.getBalance({ silent: true, ...options });
    await this.getPositions({ silent: true, ...options });
  }
}

export default AsterAdapter;
