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
import { describeAsterApiError } from '../utils/aster-api-error.js';
import { axiosKeepAliveOptions, withKeepAlive } from '../utils/http-agents.js';
import { tuneWebSocket } from '../utils/ws-tune.js';

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
    this._publicWsReconnectAt = 0;
    this._reconnectingPublicWs = false;
    this._publicWsGen = 0;
    this._publicWsOpenedAt = 0;
    this._publicWsEverOpened = false;
    this._lastPongTime = 0;
    this._lastWsRawMessageAt = 0;
    this._pongCheckTimer = null;
    this._wsIdleCheckTimer = null;
    this._publicWs24hTimer = null;
    this._wsIdleReconnectMs = Number(config.wsIdleReconnectMs) || (5 * 60 * 1000);
    this.pongTimeout = Number(config.pongTimeoutMs) || (10 * 60 * 1000);
    this._wsDelayReconnectMs = Number(config.wsDelayReconnectMs ?? config.maxWsLatencyMs) || 400;
    this._wsDelayReconnectHits = Number(config.wsDelayReconnectHits) || 3;
    this._wsDelayReconnectWindowMs = Number(config.wsDelayReconnectWindowMs) || 30_000;
    this._wsDelayHighSamples = [];
    /** 23h50m 主动重连，降低长连接老化造成的延迟抖升 */
    this._WS_PROACTIVE_RECONNECT_MS = (23 * 60 + 50) * 60 * 1000;
    this._balanceCache = null;
    this._positionCache = new Map();
    this._lastNonce = 0n;
    this.listenKey = null;
    this.privateWs = null;
    this.privateWsConnected = false;
    this.listenKeyKeepaliveMin = Number(config.listenKeyKeepaliveMin) || 30;
    this._listenKeyTimer = null;
    this._privateWsReconnecting = false;
    this._privateWsReconnectAt = 0;
    this._privateWsGen = 0;
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
    await this.#forcePublicWsReconnect('manual');
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
    await this.stopPrivateAccountStream();
    this.#stopPublicWsTimers();
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
    const url = `${this.config.restUrl}/fapi/v3/exchangeInfo`;
    const response = await axios.get(url, {
      ...axiosKeepAliveOptions(url),
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
    const gen = ++this._publicWsGen;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;
      ws.on('open', async () => {
        tuneWebSocket(ws);
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this.connected = true;
        this._publicWsOpenedAt = Date.now();
        this._lastPongTime = this._publicWsOpenedAt;
        this._lastWsRawMessageAt = this._publicWsOpenedAt;
        this._wsDelayHighSamples = [];
        if (this.subscribedSymbols.length > 0) {
          await this.#flushSubscriptions({ forceResubscribe: true });
        }
        // flushSubscriptions 期间连接可能已被替换，避免旧连接继续启动定时器
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this.#startFeedWatchdog();
        this.#startPublicHeartbeat();
        this.#startWsIdleMonitor();
        this.#startPublicWs24hTimer();
        const clearCache = this._publicWsEverOpened;
        this._publicWsEverOpened = true;
        this.emit('PUBLIC_WS_RECONNECTED', {
          exchange: 'aster',
          reason: 'public-ws-open',
          clearCache
        });
        resolve();
      });
      ws.on('ping', (data) => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong(data);
          this._lastPongTime = Date.now();
        }
      });
      ws.on('pong', () => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this._lastPongTime = Date.now();
      });
      ws.on('message', (raw) => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this._lastWsRawMessageAt = Date.now();
        this.handleMessage(raw);
      });
      ws.on('close', () => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this.connected = false;
        this.#stopPublicWsTimers();
        if (this._shuttingDown) return;
        this.#schedulePublicWsReconnect('close');
      });
      ws.on('error', (err) => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
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

  #emitBookTicker(ticker, { viaRest = false, restReason = null, receiveLocalTs = null } = {}) {
    const localTs = receiveLocalTs ?? Date.now();
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

  #startPublicHeartbeat() {
    this.#stopPublicHeartbeat();
    this._lastPongTime = Date.now();
    this._pongCheckTimer = setInterval(() => {
      if (this._shuttingDown || this._reconnectingPublicWs) return;
      if (Date.now() - this._lastPongTime > this.pongTimeout) {
        console.warn('[Aster] public WS pong timeout, reconnecting...');
        this.#schedulePublicWsReconnect('pong-timeout');
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
      }
    }, 30_000);
    if (typeof this._pongCheckTimer.unref === 'function') {
      this._pongCheckTimer.unref();
    }
  }

  #stopPublicHeartbeat() {
    if (this._pongCheckTimer) {
      clearInterval(this._pongCheckTimer);
      this._pongCheckTimer = null;
    }
  }

  #startWsIdleMonitor() {
    this.#stopWsIdleMonitor();
    this._wsIdleCheckTimer = setInterval(() => {
      if (this._shuttingDown || this._reconnectingPublicWs || !this.ws) return;
      const last = Math.max(this._lastWsRawMessageAt || 0, this._lastPongTime || 0);
      if (last > 0 && Date.now() - last > this._wsIdleReconnectMs) {
        console.warn(`[Aster] public WS idle ${((Date.now() - last) / 1000).toFixed(0)}s, reconnecting...`);
        this.#schedulePublicWsReconnect('ws-idle');
      }
    }, 30_000);
    if (typeof this._wsIdleCheckTimer.unref === 'function') {
      this._wsIdleCheckTimer.unref();
    }
  }

  #stopWsIdleMonitor() {
    if (this._wsIdleCheckTimer) {
      clearInterval(this._wsIdleCheckTimer);
      this._wsIdleCheckTimer = null;
    }
  }

  #startPublicWs24hTimer() {
    this.#stopPublicWs24hTimer();
    this._publicWs24hTimer = setTimeout(() => {
      if (this._shuttingDown || this._reconnectingPublicWs) return;
      console.log('[Aster] public WS approaching 24h limit, proactive reconnect...');
      this.#schedulePublicWsReconnect('24h-limit');
    }, this._WS_PROACTIVE_RECONNECT_MS);
    if (typeof this._publicWs24hTimer.unref === 'function') {
      this._publicWs24hTimer.unref();
    }
  }

  #stopPublicWs24hTimer() {
    if (this._publicWs24hTimer) {
      clearTimeout(this._publicWs24hTimer);
      this._publicWs24hTimer = null;
    }
  }

  #stopPublicWsTimers() {
    this.#stopFeedWatchdog();
    this.#stopPublicHeartbeat();
    this.#stopWsIdleMonitor();
    this.#stopPublicWs24hTimer();
  }

  #schedulePublicWsReconnect(reason = 'unknown') {
    if (this._shuttingDown) return;
    if (this._reconnectingPublicWs) return;
    const now = Date.now();
    if (now - this._publicWsReconnectAt < 1000) return;
    this._publicWsReconnectAt = now;
    setTimeout(() => {
      this.#forcePublicWsReconnect(reason).catch((err) => {
        console.warn(`[Aster] public WS reconnect (${reason}) failed:`, err.message);
      });
    }, 1000);
  }

  async #forcePublicWsReconnect(reason = 'unknown') {
    if (this._reconnectingPublicWs || this._shuttingDown) return;
    this._reconnectingPublicWs = true;
    try {
      this._wsDelayHighSamples = [];
      this.#stopPublicWsTimers();
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.terminate();
        this.ws = null;
      }
      await this.connectWebSocket();
      console.log(`[Aster] public WS reconnected (${reason})`);
    } finally {
      this._reconnectingPublicWs = false;
    }
  }

  #recordWsDelaySample(wsDelayMs, localTs) {
    if (!Number.isFinite(wsDelayMs) || !Number.isFinite(this._wsDelayReconnectMs)) return;
    if (this._wsDelayReconnectMs <= 0 || wsDelayMs <= this._wsDelayReconnectMs) return;
    if (this._reconnectingPublicWs || this._shuttingDown) return;

    const cutoff = localTs - this._wsDelayReconnectWindowMs;
    this._wsDelayHighSamples = this._wsDelayHighSamples
      .filter((ts) => ts >= cutoff)
      .concat(localTs);

    if (this._wsDelayHighSamples.length >= this._wsDelayReconnectHits) {
      console.warn(
        `[Aster] public WS delay ${Math.round(wsDelayMs)}ms > ${this._wsDelayReconnectMs}ms `
        + `(${this._wsDelayHighSamples.length}/${this._wsDelayReconnectHits}), reconnecting...`
      );
      this._wsDelayHighSamples = [];
      this.#schedulePublicWsReconnect('ws-delay');
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
      let wsDelayMs = exchangeMsRaw != null ? Math.max(0, localTs - exchangeMsRaw) : null;
      let exchangeMs = exchangeMsRaw ?? localTs;
      // 交易所时间字段偶发异常时不触发误判重连：降级为本地时间并忽略该样本延迟
      const MAX_SANE_WS_DELAY_MS = 30_000;
      if (exchangeMsRaw != null && wsDelayMs > MAX_SANE_WS_DELAY_MS) {
        exchangeMs = localTs;
        wsDelayMs = null;
      }
      this.#recordWsDelaySample(wsDelayMs, localTs);
      const ticker = {
        symbol: this.normalizeSymbol(payload.s),
        bid,
        ask,
        timestamp: exchangeMs,
        serverTimestamp: rawEventTs,
        wsDelayMs
      };
      this.#emitBookTicker(ticker, { receiveLocalTs: localTs });
    } catch {
      // ignore
    }
  }

  async getFundingRate(symbol) {
    const url = `${this.config.restUrl}/fapi/v3/premiumIndex`;
    const { data } = await axios.get(url, {
      ...axiosKeepAliveOptions(url),
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
    try {
      const { data } = await axios(withKeepAlive({
        ...requestConfig
      }));
      return data;
    } catch (err) {
      throw new Error(describeAsterApiError(err));
    }
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
      legRole: 'B',
      ...params,
      futuresMode: true
    });
  }

  async getBookTicker(symbol, options = {}) {
    const exSymbol = this.toExchangeSymbol(symbol);
    const timeout = Number(options.timeoutMs) || this.config.timeout || 5000;
    const url = `${this.config.restUrl}/fapi/v3/ticker/bookTicker`;
    const { data } = await axios.get(url, {
      ...axiosKeepAliveOptions(url),
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
    const url = `${this.config.restUrl}/fapi/v3/depth`;
    const { data } = await axios.get(url, {
      ...axiosKeepAliveOptions(url),
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
    let response;
    try {
      response = await this.#signedRequest('POST', '/fapi/v3/order', params);
    } catch (err) {
      throw new Error(
        `${err.message} | order(symbol=${params.symbol}, side=${side}, type=${type}, qty=${params.quantity}`
        + `, reduceOnly=${Boolean(orderData.reduceOnly)})`
      );
    }
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

  async #createListenKey() {
    const data = await this.#signedRequest('POST', '/fapi/v3/listenKey', {});
    const key = data?.listenKey;
    if (!key) throw new Error('Aster listenKey missing in response');
    return key;
  }

  async #keepaliveListenKey() {
    if (!this.listenKey || !this.privateWsConnected || this._privateWsReconnecting) return;
    await this.#signedRequest('PUT', '/fapi/v3/listenKey', {});
  }

  async #deleteListenKeySafely({ expectMissing = false } = {}) {
    if (!this.listenKey) return;
    const key = this.listenKey;
    this.listenKey = null;
    try {
      await this.#signedRequest('DELETE', '/fapi/v3/listenKey', {});
    } catch (err) {
      if (!expectMissing) {
        console.warn('[Aster] delete listenKey failed:', err.message);
      }
    }
  }

  #stopPrivateWsTimers() {
    if (this._listenKeyTimer) {
      clearInterval(this._listenKeyTimer);
      this._listenKeyTimer = null;
    }
  }

  #startListenKeyTimer() {
    this.#stopPrivateWsTimers();
    const ms = Math.max(1, this.listenKeyKeepaliveMin) * 60 * 1000;
    this.#keepaliveListenKey().catch((err) => {
      console.warn('[Aster] listenKey keepalive failed (immediate):', err.message);
    });
    this._listenKeyTimer = setInterval(() => {
      this.#keepaliveListenKey().catch((err) => {
        console.warn('[Aster] listenKey keepalive failed:', err.message);
      });
    }, ms);
    if (typeof this._listenKeyTimer.unref === 'function') {
      this._listenKeyTimer.unref();
    }
  }

  #scheduleBalanceRestSync() {
    this.getBalance({ silent: true }).catch((err) => {
      console.warn('[Aster] balance REST sync after ACCOUNT_UPDATE failed:', err.message);
    });
  }

  #handlePrivateMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.e === 'listenKeyExpired') {
        console.warn('[Aster] listenKey expired, reconnecting private WS...');
        this.listenKey = null;
        this.#schedulePrivateWsReconnect('listenKeyExpired');
        return;
      }
      if (msg.e !== 'ACCOUNT_UPDATE' || !msg.a) return;

      const eventReason = String(msg.a.m || '');

      if ((msg.a.B || []).length > 0) {
        this.#scheduleBalanceRestSync();
      }

      // Aster 平仓后 pa=0 的 symbol 不会出现在 P 里，ORDER 事件需 REST 全量刷新持仓
      if (eventReason === 'ORDER' || (msg.a.P || []).length > 0) {
        this.getPositions({ silent: true }).catch((err) => {
          console.warn('[Aster] position REST sync after ACCOUNT_UPDATE failed:', err.message);
        });
        return;
      }
    } catch {
      // ignore parse errors
    }
  }

  #schedulePrivateWsReconnect(reason = 'unknown') {
    if (this._shuttingDown) return;
    const now = Date.now();
    if (this._privateWsReconnecting) return;
    if (now - this._privateWsReconnectAt < 5000) return;
    this._privateWsReconnectAt = now;
    this.#reconnectPrivateWs(reason).catch((err) => {
      console.warn(`[Aster] private WS reconnect (${reason}) failed:`, err.message);
    });
  }

  async #reconnectPrivateWs(reason = 'unknown') {
    if (this._privateWsReconnecting || this._shuttingDown) return;
    this._privateWsReconnecting = true;
    try {
      console.log(`[Aster] Reconnecting private WS (${reason})...`);
      this.#stopPrivateWsTimers();
      if (this.privateWs) {
        this.privateWs.removeAllListeners();
        this.privateWs.terminate();
        this.privateWs = null;
      }
      this.privateWsConnected = false;
      this._privateWsGen += 1;
      const expectMissing = reason === 'listenKeyExpired' || reason === 'keepalive';
      await this.#deleteListenKeySafely({ expectMissing });
      await new Promise((r) => setTimeout(r, 500));
      await this.#connectPrivateWs();
      console.log(`[Aster] private WS reconnected (${reason})`);
    } finally {
      this._privateWsReconnecting = false;
    }
  }

  async #teardownPrivateWs({ deleteListenKey = true } = {}) {
    this.#stopPrivateWsTimers();
    if (this.privateWs) {
      this.privateWs.removeAllListeners();
      this.privateWs.close();
      this.privateWs = null;
    }
    this.privateWsConnected = false;
    this._privateWsGen += 1;
    if (deleteListenKey) {
      await this.#deleteListenKeySafely();
    } else {
      this.listenKey = null;
    }
    this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'aster' });
  }

  async #connectPrivateWs() {
    this.listenKey = await this.#createListenKey();
    const url = `${this.config.wsUrl}/${this.listenKey}`;
    const gen = this._privateWsGen;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.privateWs = ws;

      ws.on('open', async () => {
        tuneWebSocket(ws);
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        this.privateWsConnected = true;
        try {
          await this.syncAccountSnapshot({ silent: true });
          if (gen !== this._privateWsGen || this.privateWs !== ws) return;
          this.emit('PRIVATE_WS_CONNECTED', { exchange: 'aster', positionsReady: true });
          console.log('[Aster] private WS connected, account snapshot synced');
          this.#startListenKeyTimer();
          resolve();
        } catch (err) {
          console.error('[Aster] private WS onOpen sync failed:', err.message);
          this.privateWsConnected = false;
          this.#stopPrivateWsTimers();
          this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'aster' });
          this._privateWsGen += 1;
          ws.removeAllListeners();
          ws.terminate();
          if (this.privateWs === ws) this.privateWs = null;
          setTimeout(() => {
            this.#schedulePrivateWsReconnect('sync-failed');
          }, 2000);
          reject(err);
        }
      });
      ws.on('ping', (data) => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        if (ws.readyState === WebSocket.OPEN) ws.pong(data);
      });
      ws.on('message', (raw) => this.#handlePrivateMessage(raw));
      ws.on('close', () => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        this.privateWsConnected = false;
        this.#stopPrivateWsTimers();
        this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'aster' });
        if (this._shuttingDown || this._privateWsReconnecting) return;
        setTimeout(() => {
          this.#schedulePrivateWsReconnect('close');
        }, 2000);
      });
      ws.on('error', (err) => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        console.error('[Aster] private WS error:', err.message);
        if (ws.readyState === WebSocket.CONNECTING) reject(err);
      });
    });
  }

  async startPrivateAccountStream() {
    if (!this.authenticated) return;
    if (this._privateWsReconnecting) return;
    await this.#teardownPrivateWs({ deleteListenKey: false });
    await this.#connectPrivateWs();
  }

  async stopPrivateAccountStream() {
    await this.#teardownPrivateWs({ deleteListenKey: true });
  }

  async syncAccountSnapshot(options = {}) {
    await this.getBalance({ silent: true, ...options });
    await this.getPositions({ silent: true, ...options });
  }
}

export default AsterAdapter;
