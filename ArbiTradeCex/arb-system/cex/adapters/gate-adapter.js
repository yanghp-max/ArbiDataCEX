/**
 * Gate 统一账户 + USDT 永续适配器
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { cryptoUtils } from '../utils.js';

export class GateAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Gate',
      wsUrl: process.env.GATE_FX_WS_URL
        || process.env.GATE_WS_URL
        || 'wss://fx-ws.gateio.ws/v4/ws/usdt',
      restUrl: process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4',
      apiUrl: process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4',
      ...config
    });

    this.id = 'gate';
    this.subscribed = [];
    this.subscribedChannels = ['book_ticker'];
    this._balanceCache = null;
    this._positionCache = new Map();
  }

  toCompactSymbol(symbol) {
    return String(symbol).replace(/[-_]/g, '');
  }

  toExchangeSymbol(symbol) {
    return this.toCompactSymbol(symbol);
  }

  toGateContract(symbol) {
    const s = this.toExchangeSymbol(symbol);
    if (!s.endsWith('USDT')) {
      return String(symbol).replace('-', '_');
    }
    return `${s.slice(0, -4)}_USDT`;
  }

  normalizeSymbol(symbol) {
    const s = this.toCompactSymbol(symbol);
    if (s.endsWith('USDT')) return `${s.slice(0, -4)}-USDT`;
    return super.normalizeSymbol(symbol);
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    await this.connectWebSocket();
    if (process.env.GATE_API_KEY && process.env.GATE_API_SECRET) {
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

  #signV4({ method, path, queryString, body, timestamp }) {
    const payload = `${method}\n${path}\n${queryString}\n${cryptoUtils.sha512Hex(body)}\n${timestamp}`;
    return cryptoUtils.hmacSha512(payload, process.env.GATE_API_SECRET || '');
  }

  async #signedRequest(method, path, options = null, extraHeaders = {}) {
    let bodyObj = null;
    let queryString = '';
    let urlPath = path;

    if (options) {
      if (method === 'GET' || method === 'DELETE') {
        queryString = new URLSearchParams(
          Object.entries(options).reduce((acc, [k, v]) => {
            if (v != null) acc[k] = String(v);
            return acc;
          }, {})
        ).toString();
        if (queryString) urlPath = `${path}?${queryString}`;
      } else {
        bodyObj = options;
      }
    }

    const pathWithPrefix = `/api/v4${path}`;
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = this.#signV4({
      method,
      path: pathWithPrefix,
      queryString,
      body,
      timestamp
    });
    const url = `${this.config.restUrl}${urlPath}`;
    const config = {
      method,
      url,
      headers: {
        KEY: process.env.GATE_API_KEY || '',
        Timestamp: timestamp,
        SIGN: sign,
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      timeout: 15000
    };
    if (bodyObj) config.data = bodyObj;
    const { data } = await axios(config);
    return data;
  }

  async loadSymbols() {
    const response = await axios.get(`${this.config.restUrl}/futures/usdt/contracts`, {
      timeout: this.config.timeout
    });
    const set = new Set();
    for (const c of response.data || []) {
      const name = c.name || c.contract;
      if (!name || !String(name).endsWith('_USDT')) continue;
      if (c.in_delisting === true) continue;
      set.add(String(name));
    }
    return set;
  }

  async getSymbols() {
    const set = await this.loadSymbols();
    return Array.from(set).map((c) => this.normalizeSymbol(this.toCompactSymbol(c)));
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
        if (this.subscribed.length > 0) {
          await this.subscribe(this.subscribed, this.subscribedChannels);
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

  async subscribe(symbolsOrSymbol, channels = ['book_ticker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribed = [...symbols];
    this.subscribedChannels = [...channels];
    for (const symbol of symbols) {
      await super.subscribe(this.normalizeSymbol(symbol), channels);
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const gateSymbols = symbols.map((s) => this.toGateContract(s));
    for (const ch of channels) {
      this.ws.send(JSON.stringify({
        time: Math.floor(Date.now() / 1000),
        channel: `futures.${ch}`,
        event: 'subscribe',
        payload: gateSymbols
      }));
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== 'futures.book_ticker' || msg.event !== 'update') return;

      const r = msg.result || {};
      const contract = String(r.s || r.contract || '');
      if (!contract) return;

      const bid = Number(r.b);
      const ask = Number(r.a);
      if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) return;

      const serverTimestamp = r.t ?? null;
      const timestamp = serverTimestamp != null
        ? (Number(serverTimestamp) > 1e12 ? Number(serverTimestamp) : Number(serverTimestamp) * 1000)
        : Date.now();

      this.emit(EventTypes.TICKER, {
        symbol: this.normalizeSymbol(this.toCompactSymbol(contract)),
        bid,
        ask,
        timestamp,
        serverTimestamp,
        localTimestamp: Date.now(),
        source: 'gate'
      });
      this.emit('ticker', {
        symbol: this.normalizeSymbol(this.toCompactSymbol(contract)),
        bid,
        ask,
        timestamp,
        serverTimestamp,
        localTimestamp: Date.now(),
        source: 'gate'
      });
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const contract = this.toGateContract(symbol);
    const { data } = await axios.get(`${this.config.restUrl}/futures/usdt/funding_rate`, {
      params: { contract, limit: 1 },
      timeout: this.config.timeout
    });
    const item = Array.isArray(data) ? data[data.length - 1] : data;
    return Number(item?.r ?? item?.funding_rate ?? item?.rate ?? NaN);
  }

  async getAuthHeaders(method, path, bodyObj = null) {
    const pathWithPrefix = `/api/v4${path}`;
    const body = bodyObj ? JSON.stringify(bodyObj) : '';
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      KEY: process.env.GATE_API_KEY || '',
      Timestamp: timestamp,
      SIGN: this.#signV4({ method, path: pathWithPrefix, queryString: '', body, timestamp }),
      'Content-Type': 'application/json'
    };
  }

  async getBalance(options = {}) {
    const data = await this.#signedRequest('GET', '/unified/accounts');
    const balances = [];
    const map = data?.balances || data?.details || {};
    for (const [currency, row] of Object.entries(map)) {
      const available = Number(row.available ?? row.available_margin ?? row.equity ?? 0);
      const total = Number(row.total ?? row.equity ?? available);
      if (total <= 0 && available <= 0) continue;
      balances.push(new Balance({
        currency,
        exchange: this.config.name,
        total,
        available,
        frozen: Math.max(0, total - available),
        timestamp: Date.now()
      }));
    }
    this._balanceCache = balances;
    if (!options.silent) {
      this.emitBalanceUpdate(balances);
    }
    return balances;
  }

  async getUsdtBalance() {
    const balances = await this.getBalance();
    const usdt = balances.find((b) => b.currency === 'USDT');
    const available = usdt?.available ?? 0;
    return { total: available, available, updatedAtMs: Date.now() };
  }

  async getPositions(options = {}) {
    const rows = await this.#signedRequest('GET', '/futures/usdt/positions');
    const positions = (rows || [])
      .filter((r) => Math.abs(Number(r.size)) > 0)
      .map((r) => {
        const size = Number(r.size);
        const multiplier = Number(r.quanto_multiplier || 1);
        const baseQty = size * multiplier;
        const pos = new Position({
          symbol: this.toCompactSymbol(r.contract || ''),
          exchange: this.config.name,
          side: size >= 0 ? 'long' : 'short',
          size: Math.abs(baseQty),
          qty: baseQty,
          entryPrice: Number(r.entry_price || 0),
          markPrice: Number(r.mark_price || 0),
          unrealizedPnl: Number(r.unrealised_pnl || 0),
          leverage: Number(r.leverage || 1),
          timestamp: Date.now()
        });
        pos.contracts = size;
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
      open: OrderStatus.OPEN,
      finished: OrderStatus.FILLED,
      cancelled: OrderStatus.CANCELLED
    };
    return map[status] || OrderStatus.PENDING;
  }

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const contract = this.toGateContract(orderData.symbol);
    const side = String(orderData.side).toLowerCase();
    const type = String(orderData.type).toLowerCase();
    const signedSize = side === 'sell' ? -Math.abs(Number(orderData.amount)) : Math.abs(Number(orderData.amount));
    const body = {
      contract,
      size: orderData.decimalSize ? String(signedSize) : signedSize,
      price: type === 'limit' ? String(orderData.price) : '0',
      tif: type === 'limit' ? (orderData.timeInForce || 'gtc') : 'ioc'
    };
    const headers = orderData.decimalSize ? { 'X-Gate-Size-Decimal': '1' } : {};
    const response = await this.#signedRequest('POST', '/futures/usdt/orders', body, headers);
    return new Order({
      orderId: String(response.id),
      clientOrderId: response.text,
      symbol: this.normalizeSymbol(orderData.symbol),
      exchange: this.config.name,
      side,
      type,
      amount: Math.abs(Number(orderData.amount)),
      price: Number(response.price || orderData.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled: Math.abs(Number(response.size || 0)),
      timestamp: Date.now(),
      avgPrice: Number(response.fill_price || 0)
    });
  }

  async placeMarketOrder({ contract, size, decimalSize = false, symbol }) {
    const resolvedSymbol = symbol || contract.replace('_', '').replace('USDT', '-USDT');
    const side = Number(size) >= 0 ? 'buy' : 'sell';
    return this.placeOrder({
      symbol: resolvedSymbol,
      side,
      type: 'market',
      amount: Math.abs(Number(size)),
      decimalSize
    });
  }

  async cancelOrder(orderId, symbol) {
    const contract = this.toGateContract(symbol);
    return this.#signedRequest('DELETE', `/futures/usdt/orders/${orderId}`, { contract });
  }

  async getOrderStatus(orderId, symbol) {
    const contract = this.toGateContract(symbol);
    const response = await this.#signedRequest('GET', `/futures/usdt/orders/${orderId}`, { contract });
    if (response?.contract && response.contract !== contract) {
      throw new Error(`Order ${orderId} contract mismatch`);
    }
    return new Order({
      orderId: String(response.id),
      clientOrderId: response.text,
      symbol: this.normalizeSymbol(symbol),
      exchange: this.config.name,
      side: Number(response.size) >= 0 ? 'buy' : 'sell',
      type: Number(response.price) > 0 ? 'limit' : 'market',
      amount: Math.abs(Number(response.size || 0)),
      price: Number(response.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled: Math.abs(Number(response.size || 0)),
      timestamp: Number(response.create_time || Date.now()) * 1000,
      avgPrice: Number(response.fill_price || 0)
    });
  }

  async getOrderHistory(symbol, limit = 100) {
    const contract = this.toGateContract(symbol);
    const response = await this.#signedRequest('GET', '/futures/usdt/orders', { contract, limit });
    return (response || []).map((row) => new Order({
      orderId: String(row.id),
      clientOrderId: row.text,
      symbol: this.normalizeSymbol(symbol),
      exchange: this.config.name,
      side: Number(row.size) >= 0 ? 'buy' : 'sell',
      type: Number(row.price) > 0 ? 'limit' : 'market',
      amount: Math.abs(Number(row.size || 0)),
      price: Number(row.price || 0),
      status: this.#mapOrderStatus(row.status),
      filled: Math.abs(Number(row.size || 0)),
      timestamp: Number(row.create_time || Date.now()) * 1000,
      avgPrice: Number(row.fill_price || 0)
    }));
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    return true;
  }
}

export default GateAdapter;
