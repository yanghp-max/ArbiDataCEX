/**
 * Hyperliquid perpetual adapter.
 * Public: WS bbo + REST info. Trading: signed L1 actions via wallet private key.
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { checkOrderPreconditions as runCheckOrderPreconditions } from '../utils/check-order-preconditions.js';
import { signL1Action, splitHyperliquidSignature } from '../utils/hyperliquid-sign.js';

const MAX_SANE_WS_DELAY_MS = 30_000;

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_/]/g, '').toUpperCase();
}

function isFinitePositive(n) {
  return Number.isFinite(Number(n)) && Number(n) > 0;
}

export class HyperliquidAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Hyperliquid',
      wsUrl: process.env.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws',
      restUrl: process.env.HYPERLIQUID_REST_URL || 'https://api.hyperliquid.xyz',
      apiUrl: process.env.HYPERLIQUID_REST_URL || 'https://api.hyperliquid.xyz',
      isMainnet: config.isMainnet !== false && process.env.HYPERLIQUID_TESTNET !== '1',
      ...config
    });
    this.id = 'hyperliquid';
    this.enablePublicStream = config.enablePublicStream !== false;
    this.subscribedSymbols = [];
    this._coinBySymbol = new Map();
    this._assetIndexByCoin = new Map();
    this._szDecimalsByCoin = new Map();
    this._balanceCache = null;
    this._positionCache = new Map();
    this._lastSymbolMessageAt = new Map();
    this._feedWatchdog = null;
    this._restRefreshPending = false;
    this._shuttingDown = false;
    this._symbolStaleMs = Number(config.symbolStaleMs) || 900;
    this._walletAddress = null;
  }

  toCompactSymbol(symbol) {
    return compactSymbol(symbol);
  }

  /** BTC-USDT / BTCUSDT → coin BTC */
  toCoin(symbol) {
    const s = this.toCompactSymbol(symbol);
    return s.endsWith('USDT') ? s.slice(0, -4) : s;
  }

  toExchangeSymbol(symbol) {
    return this.toCoin(symbol);
  }

  normalizeSymbol(symbol) {
    const coin = this.toCoin(symbol);
    return `${coin}-USDT`;
  }

  get publicConnected() {
    return Boolean(this.enablePublicStream && this.ws?.readyState === WebSocket.OPEN);
  }

  #privateKey() {
    return String(process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HYPERLIQUID_API_PRIVATE_KEY || '').trim();
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    if (this.enablePublicStream) await this.connectWebSocket();
    await this.#loadMeta().catch((err) => {
      console.warn('[Hyperliquid] preload meta failed:', err.message);
    });
    const pk = this.#privateKey();
    if (pk) {
      this.authenticated = true;
      const { ethers } = await import('ethers');
      this._walletAddress = new ethers.Wallet(pk).address;
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

  async #info(body, timeout = 15000) {
    const { data } = await axios.post(`${this.config.restUrl}/info`, body, { timeout });
    return data;
  }

  async #exchange(payload, timeout = 15000) {
    const { data } = await axios.post(`${this.config.restUrl}/exchange`, payload, { timeout });
    if (data?.status === 'err') {
      throw new Error(`Hyperliquid exchange failed: ${data.response || JSON.stringify(data)}`);
    }
    return data;
  }

  async #loadMeta() {
    const meta = await this.#info({ type: 'meta' });
    const universe = Array.isArray(meta?.universe) ? meta.universe : [];
    this._coinBySymbol.clear();
    this._assetIndexByCoin.clear();
    this._szDecimalsByCoin.clear();
    universe.forEach((row, index) => {
      const coin = String(row.name || '').toUpperCase();
      if (!coin) return;
      const symbolId = `${coin}USDT`;
      this._coinBySymbol.set(symbolId, coin);
      this._assetIndexByCoin.set(coin, index);
      this._szDecimalsByCoin.set(coin, Number(row.szDecimals ?? 0));
    });
  }

  async getSymbols() {
    if (this._coinBySymbol.size === 0) await this.#loadMeta();
    return [...this._coinBySymbol.keys()].map((s) => this.normalizeSymbol(s));
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
        this.connected = true;
        if (this.subscribedSymbols.length > 0) this.#subscribeTopics(this.subscribedSymbols);
        this.#startFeedWatchdog();
        this.emit('PUBLIC_WS_RECONNECTED', { exchange: 'hyperliquid', reason: 'public-ws-open', clearCache: false });
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
    for (const symbol of symbols) {
      const coin = this.toCoin(symbol);
      this.ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'bbo', coin }
      }));
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
      source: 'hyperliquid',
      viaRest
    });
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.channel !== 'bbo') return;
      const data = msg?.data;
      const coin = String(data?.coin || '');
      if (!coin) return;
      const bidLevel = data?.bbo?.[0];
      const askLevel = data?.bbo?.[1];
      const bid = Number(bidLevel?.px);
      const ask = Number(askLevel?.px);
      if (!isFinitePositive(bid) || !isFinitePositive(ask)) return;
      const localTs = Date.now();
      const exchangeTs = Number(data.time);
      let wsDelayMs = Number.isFinite(exchangeTs) ? Math.max(0, localTs - exchangeTs) : null;
      let timestamp = Number.isFinite(exchangeTs) ? exchangeTs : localTs;
      if (Number.isFinite(exchangeTs) && wsDelayMs > MAX_SANE_WS_DELAY_MS) {
        timestamp = localTs;
        wsDelayMs = null;
      }
      this.#emitBookTicker({
        symbol: coin,
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
    const coin = this.toCoin(symbol);
    const row = await this.#info({ type: 'l2Book', coin });
    const levels = row?.levels;
    const bid = Number(levels?.[0]?.[0]?.px);
    const ask = Number(levels?.[1]?.[0]?.px);
    if (!isFinitePositive(bid) || !isFinitePositive(ask)) {
      throw new Error(`Invalid Hyperliquid book ${coin}`);
    }
    return {
      symbol: this.normalizeSymbol(coin),
      bid,
      ask,
      timestamp: Number(row.time) || Date.now(),
      serverTimestamp: Number(row.time) || null,
      restReason: options.reason ?? 'rest'
    };
  }

  async getFundingRate(symbol) {
    const coin = this.toCoin(symbol);
    const rows = await this.#info({ type: 'metaAndAssetCtxs' });
    const meta = rows?.[0];
    const ctxs = rows?.[1];
    const idx = this._assetIndexByCoin.get(coin) ?? (meta?.universe || []).findIndex((u) => u.name === coin);
    if (idx < 0 || !Array.isArray(ctxs)) return null;
    return Number(ctxs[idx]?.funding);
  }

  async setSymbolLeverage(symbol, leverage = 1) {
    const coin = this.toCoin(symbol);
    const lev = Math.max(1, Math.min(100, Math.floor(Number(leverage) || 1)));
    const pk = this.#privateKey();
    if (!pk) throw new Error('Hyperliquid private key required for setSymbolLeverage');
    const action = {
      type: 'updateLeverage',
      asset: this.#assetIndex(coin),
      isCross: true,
      leverage: lev
    };
    await this.#signedExchange(action);
    return { symbol: `${coin}USDT`, leverage: lev, maxNotionalValue: null };
  }

  #assetIndex(coin) {
    const c = String(coin || '').toUpperCase();
    if (this._assetIndexByCoin.has(c)) return this._assetIndexByCoin.get(c);
    throw new Error(`Hyperliquid unknown coin: ${c}`);
  }

  async #signedExchange(action) {
    const pk = this.#privateKey();
    if (!pk) throw new Error('Hyperliquid private key required');
    const nonce = Date.now();
    const { signature } = await signL1Action(pk, action, {
      nonce,
      isMainnet: this.config.isMainnet !== false
    });
    const { r, s, v } = splitHyperliquidSignature(signature);
    return this.#exchange({
      action,
      nonce,
      signature: { r, s, v },
      vaultAddress: null
    });
  }

  async getBalance(options = {}) {
    const user = this._walletAddress;
    if (!user) throw new Error('Hyperliquid wallet address missing');
    const state = await this.#info({ type: 'clearinghouseState', user });
    const summary = state?.crossMarginSummary || state?.marginSummary || {};
    const total = Number(summary.accountValue ?? 0);
    const available = Number(summary.withdrawable ?? summary.totalRawUsd ?? total);
    const balances = total <= 1e-12 && available <= 1e-12 ? [] : [
      new Balance({
        currency: 'USDT',
        exchange: this.config.name,
        total,
        available,
        marginUsed: Math.max(0, total - available),
        frozen: Math.max(0, total - available),
        timestamp: Date.now()
      })
    ];
    this._balanceCache = balances;
    if (!options.silent) this.emitBalanceUpdate(balances);
    return balances;
  }

  async getPositions(options = {}) {
    const user = this._walletAddress;
    if (!user) throw new Error('Hyperliquid wallet address missing');
    const state = await this.#info({ type: 'clearinghouseState', user });
    const positions = (state?.assetPositions || [])
      .map((row) => row?.position)
      .filter((p) => p && Math.abs(Number(p.szi)) > 0)
      .map((p) => {
        const coin = String(p.coin || '').toUpperCase();
        const qty = Number(p.szi);
        return new Position({
          symbol: `${coin}USDT`,
          exchange: this.config.name,
          side: qty >= 0 ? 'long' : 'short',
          size: Math.abs(qty),
          qty,
          entryPrice: Number(p.entryPx || 0),
          markPrice: Number(p.positionValue || 0) / Math.abs(qty || 1),
          unrealizedPnl: Number(p.unrealizedPnl || 0),
          leverage: Number(p.leverage?.value || 1),
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

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const coin = this.toCoin(orderData.symbol);
    const asset = this.#assetIndex(coin);
    const isBuy = String(orderData.side || '').toLowerCase() !== 'sell';
    const sz = Number(orderData.amount);
    if (!(sz > 0)) throw new Error('Hyperliquid order size must be > 0');
    const type = String(orderData.type || 'market').toLowerCase();
    let limitPx = orderData.price != null ? String(orderData.price) : null;
    if (type === 'market' || !limitPx) {
      const book = await this.getBookTicker(orderData.symbol);
      const slip = 1.01;
      limitPx = isBuy
        ? String(book.ask * slip)
        : String(book.bid / slip);
    }
    const action = {
      type: 'order',
      orders: [{
        a: asset,
        b: isBuy,
        p: limitPx,
        s: String(sz),
        r: Boolean(orderData.reduceOnly),
        t: { limit: { tif: 'Ioc' } }
      }],
      grouping: 'na'
    };
    const result = await this.#signedExchange(action);
    const statuses = result?.response?.data?.statuses || [];
    const status = statuses[0] || {};
    if (status.error) throw new Error(`Hyperliquid placeOrder failed: ${status.error}`);
    const filled = status.filled;
    const resting = status.resting;
    const oid = filled?.oid ?? resting?.oid;
    if (oid == null) throw new Error('Hyperliquid placeOrder missing oid');
    return new Order({
      orderId: String(oid),
      clientOrderId: orderData.clientOrderId || null,
      symbol: this.normalizeSymbol(coin),
      exchange: this.config.name,
      side: isBuy ? 'buy' : 'sell',
      type: String(orderData.type || 'market').toLowerCase(),
      amount: sz,
      price: Number(filled?.avgPx ?? orderData.price ?? 0),
      status: filled ? OrderStatus.FILLED : OrderStatus.OPEN,
      filled: filled ? Number(filled.totalSz || sz) : 0,
      timestamp: Date.now(),
      avgPrice: Number(filled?.avgPx || 0)
    });
  }

  async cancelOrder(orderId, symbol) {
    const coin = this.toCoin(symbol);
    const action = {
      type: 'cancel',
      cancels: [{ a: this.#assetIndex(coin), o: Number(orderId) }]
    };
    return this.#signedExchange(action);
  }

  async getOrderStatus(orderId, symbol) {
    const user = this._walletAddress;
    if (!user) throw new Error('Hyperliquid wallet address missing');
    const coin = this.toCoin(symbol);
    const resp = await this.#info({ type: 'orderStatus', user, oid: Number(orderId) });
    if (String(resp?.status || '').toLowerCase() === 'unknownoid') {
      throw new Error(`Hyperliquid order not found: ${orderId}`);
    }
    const wrap = resp?.order;
    const inner = wrap?.order || wrap;
    if (!inner) throw new Error(`Hyperliquid order not found: ${orderId}`);
    const origSz = Number(inner.origSz ?? inner.sz ?? 0);
    const remaining = Number(inner.sz ?? 0);
    const filled = Math.max(0, origSz - remaining);
    const statusRaw = String(wrap?.status || resp?.status || '').toLowerCase();
    let status = OrderStatus.PENDING;
    if (statusRaw.includes('filled')) status = OrderStatus.FILLED;
    else if (statusRaw.includes('open') || statusRaw.includes('triggered')) status = OrderStatus.OPEN;
    else if (statusRaw.includes('cancel')) status = OrderStatus.CANCELLED;
    const sideRaw = String(inner.side || '').toUpperCase();
    return new Order({
      orderId: String(orderId),
      symbol: this.normalizeSymbol(coin),
      exchange: this.config.name,
      side: sideRaw === 'B' || sideRaw === 'BUY' ? 'buy' : 'sell',
      type: 'market',
      amount: origSz,
      price: Number(inner.limitPx || 0),
      status,
      filled,
      timestamp: Number(inner.timestamp || Date.now()),
      avgPrice: Number(inner.avgPx || inner.limitPx || 0),
      cumQuote: filled > 0 ? filled * Number(inner.avgPx || inner.limitPx || 0) : 0
    });
  }

  async getOrderHistory(symbol, limit = 100) {
    const user = this._walletAddress;
    if (!user) throw new Error('Hyperliquid wallet address missing');
    const rows = await this.#info({ type: 'historicalOrders', user });
    const coin = this.toCoin(symbol);
    return (rows || [])
      .filter((row) => String(row.order?.coin || '').toUpperCase() === coin)
      .slice(0, Math.min(Math.max(Number(limit) || 100, 1), 100))
      .map((row) => {
        const o = row.order || row;
        return new Order({
          orderId: String(o.oid),
          symbol: this.normalizeSymbol(coin),
          exchange: this.config.name,
          side: o.side === 'B' ? 'buy' : 'sell',
          type: 'market',
          amount: Number(o.origSz || 0),
          price: Number(o.limitPx || 0),
          status: OrderStatus.FILLED,
          filled: Number(o.origSz || 0) - Number(o.sz || 0),
          timestamp: Number(o.timestamp || Date.now())
        });
      });
  }

  async getOrderTrades(orderId, symbol) {
    const user = this._walletAddress;
    if (!user) throw new Error('Hyperliquid wallet address missing');
    const rows = await this.#info({ type: 'userFills', user });
    const coin = this.toCoin(symbol);
    return (rows || [])
      .filter((row) => String(row.coin || '').toUpperCase() === coin && String(row.oid) === String(orderId))
      .map((row) => {
        const qty = Math.abs(Number(row.sz || 0));
        const price = Number(row.px || 0);
        return {
          contracts: qty,
          size: qty,
          qty,
          price,
          quoteQty: qty * price,
          fee: Math.abs(Number(row.fee || 0)),
          feeAsset: 'USDT'
        };
      });
  }

  async getOrderCommission(orderId, symbol) {
    const trades = await this.getOrderTrades(orderId, symbol);
    return trades.reduce((fee, row) => fee + row.fee, 0);
  }

  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, { legRole: params?.legRole || 'B', ...params, futuresMode: true });
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    return true;
  }

  async getAuthHeaders() {
    throw new Error('Hyperliquid uses wallet signing, not HTTP auth headers');
  }

  handleWebSocketMessage(message) {
    this.handleMessage(message);
  }
}

export default HyperliquidAdapter;
