/**
 * Binance Portfolio Margin 适配器（对齐 ArbiTrade-1 接口 + ArbiTradeCex 批量订阅）
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { cryptoUtils } from '../utils.js';

export class BinanceAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Binance',
      wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/ws',
      restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
      papiRestUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com',
      apiUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com',
      ...config
    });

    this.id = 'binance';
    this.accountType = 'PORTFOLIO_MARGIN';
    this.activeSubscriptions = new Set();
    this.subscriptionQueue = [];
    this.processing = false;
    this._balanceCache = null;
    this._positionCache = new Map();
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

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    await this.connectWebSocket();
    if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
      this.authenticated = true;
    }
    await super.connect();
  }

  async disconnect() {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await super.disconnect();
  }

  async getAuthHeaders() {
    return { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY || '' };
  }

  async loadSymbols() {
    const response = await axios.get(`${this.config.restUrl}/fapi/v1/exchangeInfo`, {
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
    if (this._shuttingDown) return;
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.wsUrl);
      this.ws.on('open', async () => {
        if (this.activeSubscriptions.size > 0) {
          this.subscriptionQueue = [...this.activeSubscriptions];
          await this.processQueue();
        }
        resolve();
      });
      this.ws.on('message', (raw) => this.handleMessage(raw));
      this.ws.on('close', () => {
        if (this._shuttingDown) return;
        this.connected = false;
        setTimeout(() => {
          this.connectWebSocket().catch(() => {});
        }, 1000);
      });
      this.ws.on('error', reject);
    });
  }

  handleWebSocketMessage(raw) {
    this.handleMessage(raw);
  }

  /** 支持单 symbol 或批量 symbols（ArbiTradeCex task-manager 使用批量） */
  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    for (const symbol of symbols) {
      await super.subscribe(this.normalizeSymbol(symbol), channels);
      const exSymbol = this.toExchangeSymbol(symbol).toLowerCase();
      for (const ch of channels) {
        this.subscriptionQueue.push(`${exSymbol}@${ch}`);
      }
    }
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.processing = true;
    try {
      while (this.subscriptionQueue.length > 0) {
        const batch = this.subscriptionQueue.splice(0, 10);
        this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: Date.now() }));
        for (const stream of batch) this.activeSubscriptions.add(stream);
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      this.processing = false;
      if (this.subscriptionQueue.length > 0) {
        await this.processQueue();
      }
    }
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      const payload = msg?.data && (msg.stream || msg.data?.s) ? msg.data : msg;
      if (!(payload?.s && payload.b != null && payload.a != null)) return;

      const bid = Number(payload.b);
      const ask = Number(payload.a);
      if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) return;

      const serverTimestamp = payload.E || null;
      const ticker = {
        symbol: this.normalizeSymbol(payload.s),
        bid,
        ask,
        timestamp: serverTimestamp || Date.now(),
        serverTimestamp,
        localTimestamp: Date.now(),
        source: 'binance'
      };
      this.emit(EventTypes.TICKER, ticker);
      this.emit('ticker', ticker);
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v1/premiumIndex`, {
      params: { symbol: this.toExchangeSymbol(symbol) },
      timeout: this.config.timeout
    });
    return Number(data.lastFundingRate);
  }

  #signQuery(params) {
    const p = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' });
    const sig = cryptoUtils.hmacSha256(p.toString(), process.env.BINANCE_API_SECRET);
    return `${p}&signature=${sig}`;
  }

  async #signedRequest(method, path, params = {}) {
    const query = this.#signQuery(params);
    const url = `${this.config.papiRestUrl}${path}?${query}`;
    const { data } = await axios({
      method,
      url,
      headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY },
      timeout: 15000
    });
    return data;
  }

  async getBalance(options = {}) {
    const rows = await this.#signedRequest('GET', '/papi/v1/balance');
    const balances = (rows || [])
      .map((row) => {
        const total = Number(row.totalWalletBalance || 0);
        if (total <= 0) return null;
        const available = Number(row.umWalletBalance || 0) + Number(row.crossMarginFree || 0);
        return new Balance({
          currency: row.asset,
          exchange: this.config.name,
          total,
          available,
          frozen: Number(row.crossMarginLocked || 0),
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
    const rows = await this.#signedRequest('GET', '/papi/v1/um/positionRisk');
    const positions = (rows || [])
      .filter((r) => Math.abs(Number(r.positionAmt)) > 0)
      .map((r) => {
        const qty = Number(r.positionAmt);
        const pos = new Position({
          symbol: this.toCompactSymbol(r.symbol),
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(r.entryPrice || 0),
          markPrice: Number(r.markPrice || 0),
          unrealizedPnl: Number(r.unRealizedProfit || 0),
          leverage: Number(r.leverage || 1),
          timestamp: Date.now()
        });
        return pos;
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
    const response = await this.#signedRequest('POST', '/papi/v1/um/order', params);
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
    return this.#signedRequest('DELETE', '/papi/v1/um/order', {
      symbol: this.toExchangeSymbol(symbol),
      orderId
    });
  }

  async getOrderStatus(orderId, symbol) {
    const response = await this.#signedRequest('GET', '/papi/v1/um/order', {
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
    const response = await this.#signedRequest('GET', '/papi/v1/um/allOrders', {
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

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    if (Number(orderData.amount) <= 0) {
      throw new Error('Order amount must be greater than 0');
    }
    return true;
  }
}

export default BinanceAdapter;
