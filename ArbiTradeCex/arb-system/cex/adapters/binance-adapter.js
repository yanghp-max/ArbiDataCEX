/**
 * Binance Portfolio Margin 适配器（对齐 ArbiTrade-1 接口 + ArbiTradeCex 批量订阅）
 */
import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { cryptoUtils } from '../utils.js';
import { formatQtyByStep } from '../../common/utils/format-exchange-qty.js';
import { describeBinanceApiError } from '../utils/binance-api-error.js';
import {
  checkOrderPreconditions as runCheckOrderPreconditions
} from '../utils/check-order-preconditions.js';

export class BinanceAdapter extends BaseAdapter {
  constructor(config = {}) {
    super({
      name: 'Binance',
      wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/public/ws',
      restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
      papiRestUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com',
      apiUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com',
      ...config
    });

    this.id = 'binance';
    this.accountType = 'PORTFOLIO_MARGIN';
    this.activeSubscriptions = new Set();
    this.subscriptionQueue = [];
    this.subscribedSymbols = [];
    this.subscribedChannels = ['bookTicker'];
    this.processing = false;
    this._lastPublicMessageAt = 0;
    this._subscribedAt = 0;
    this._publicWsOpenedAt = 0;
    this._publicWsReconnectAt = 0;
    this._stalenessCheckTimer = null;
    this._reconnectingPublicWs = false;
    this._publicWsGen = 0;
    this._publicWs24hTimer = null;
    this._publicReconnectAttempts = 0;
    this._maxPublicReconnectAttempts = 20;
    this._nextReconnectAllowedAt = 0;
    this._reconnectCooldownMs = 60_000;
    this._lastPongTime = 0;
    this._pongCheckTimer = null;
    this._heartbeatCounterResetTimer = null;
    this._pongSentCount = 0;
    this.pongTimeout = 10 * 60 * 1000;
    this._shuttingDown = false;
    this.subscriptionBatchSize = Number(config.subscriptionBatchSize) || 5;
    this.subscriptionDelay = Number(config.subscriptionDelay) || 1200;
    this.subscriptionDelayJitter = Number(config.subscriptionDelayJitter) || 600;
    this.useCombinedStream = config.useCombinedStream !== false;
    this.combinedStreamThreshold = Number(config.combinedStreamThreshold) || 10;
    this.stalenessConfig = config.stalenessConfig || {
      checkIntervalMs: 3000,
      warningMs: 5000,
      criticalMs: 60_000
    };
    this._staleSymbols = new Set();
    this._globalStaleEmitted = false;
    /** 按 symbol 记录最后 WS 消息时刻 */
    this._lastSymbolMessageAt = new Map();
    this._balanceCache = null;
    this._positionCache = new Map();
    this.privateWs = null;
    this.listenKey = null;
    this.privateWsConnected = false;
    this.listenKeyKeepaliveMin = Number(config.listenKeyKeepaliveMin) || 30;
    this._listenKeyTimer = null;
    this._privateWs24hTimer = null;
    this._privateWsGen = 0;
    this._privateWsReconnecting = false;
    this._privateWsReconnectAt = 0;
    this._privateWsOpenedAt = 0;
    this.pmWsUrl = process.env.BINANCE_PM_WS_URL || 'wss://fstream.binance.com/pm/ws';
    this._PRIVATE_WS_KEEPALIVE_GRACE_MS = 90_000;
    /** Binance 单连接约 24h 上限；23h50m 主动重建（对齐 ArbiTrade-1） */
    this._WS_PROACTIVE_RECONNECT_MS = (23 * 60 + 50) * 60 * 1000;
    this._dualSidePosition = null;
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
    this._shuttingDown = true;
    this.#stopPublicWsTimers();
    await this.stopPrivateAccountStream();
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
      this.ws.terminate();
      this.ws = null;
    }
    const gen = ++this._publicWsGen;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;
      ws.on('open', async () => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this.connected = true;
        this._publicWsOpenedAt = Date.now();
        this._lastPublicMessageAt = this._publicWsOpenedAt;
        this._lastPongTime = Date.now();
        this._publicReconnectAttempts = 0;
        this._globalStaleEmitted = false;
        this._staleSymbols.clear();
        await new Promise((r) => setTimeout(r, this.#subscriptionDelayMs()));
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        await this.#flushSubscriptions({ forceResubscribe: true });
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        // bookTicker 盘口未变时重连后可能长时间无推送；重置 WS 接收基准，避免立刻再触发 global freeze
        this.#resetPublicStalenessBaseline();
        this.#startPublicHeartbeat();
        this.#startStalenessMonitor();
        this.#startPublicWs24hTimer();
        this.emit('PUBLIC_WS_RECONNECTED', { exchange: 'binance', reason: 'public-ws-open', clearCache: false });
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
        this.handleMessage(raw);
      });
      ws.on('close', (code, reason) => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        this.#handlePublicWsClose(code, reason);
      });
      ws.on('error', (err) => {
        if (gen !== this._publicWsGen || this.ws !== ws) return;
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  #subscriptionDelayMs() {
    return this.subscriptionDelay + Math.floor(Math.random() * this.subscriptionDelayJitter);
  }

  #handlePublicWsClose(code, reason) {
    this.connected = false;
    this.#stopPublicWsTimers();
    if (this._shuttingDown || this._reconnectingPublicWs) return;

    const reasonText = reason ? reason.toString() : '';
    if (code === 1008 || reasonText.toLowerCase().includes('too many requests')) {
      this._nextReconnectAllowedAt = Math.max(this._nextReconnectAllowedAt, Date.now() + this._reconnectCooldownMs);
      console.warn(`[Binance] public WS rate-limited (code=${code}), cooldown ${this._reconnectCooldownMs}ms`);
    }

    if (this._publicReconnectAttempts >= this._maxPublicReconnectAttempts) {
      console.error(`[Binance] public WS max reconnect attempts reached (${this._maxPublicReconnectAttempts})`);
      return;
    }

    this._publicReconnectAttempts += 1;
    const baseDelay = Math.min(1000 * (2 ** (this._publicReconnectAttempts - 1)), 30_000);
    const cooldownDelay = Math.max(0, this._nextReconnectAllowedAt - Date.now());
    const delay = Math.max(baseDelay, cooldownDelay);
    console.warn(`[Binance] public WS closed (code=${code}), reconnect in ${delay}ms (${this._publicReconnectAttempts}/${this._maxPublicReconnectAttempts})`);

    setTimeout(() => {
      this.#schedulePublicWsReconnect('close').catch(() => {});
    }, delay);
  }

  #schedulePublicWsReconnect(reason = 'unknown') {
    if (this._shuttingDown) return;
    if (this._reconnectingPublicWs) return;
    const now = Date.now();
    if (now - this._publicWsReconnectAt < 1000) return;
    this._publicWsReconnectAt = now;
    this.#forcePublicWsReconnect(reason).catch((err) => {
      console.warn(`[Binance] public WS reconnect (${reason}) failed:`, err.message);
    });
  }

  handleWebSocketMessage(raw) {
    this.handleMessage(raw);
  }

  /** 支持单 symbol 或批量 symbols（ArbiTradeCex task-manager 使用批量） */
  async subscribe(symbolsOrSymbol, channels = ['bookTicker']) {
    const symbols = Array.isArray(symbolsOrSymbol) ? symbolsOrSymbol : [symbolsOrSymbol];
    this.subscribedSymbols = symbols.map((symbol) => this.normalizeSymbol(symbol));
    this.subscribedChannels = [...channels];
    this._subscribedAt = Date.now();
    for (const symbol of symbols) {
      await super.subscribe(this.normalizeSymbol(symbol), channels);
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

  #startPublicHeartbeat() {
    this.#stopPublicHeartbeat();
    this._lastPongTime = Date.now();
    this._pongSentCount = 0;
    this._heartbeatCounterResetTimer = setInterval(() => {
      this._pongSentCount = 0;
    }, 1000);
    this._pongCheckTimer = setInterval(() => {
      if (this._shuttingDown || this._reconnectingPublicWs) return;
      if (Date.now() - this._lastPongTime > this.pongTimeout) {
        console.warn('[Binance] public WS pong timeout, reconnecting...');
        this.#schedulePublicWsReconnect('pong-timeout');
        return;
      }
      if (this._pongSentCount < 5 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.pong();
        this._pongSentCount += 1;
      }
    }, 30_000);
    for (const timer of [this._heartbeatCounterResetTimer, this._pongCheckTimer]) {
      if (typeof timer?.unref === 'function') timer.unref();
    }
  }

  #stopPublicHeartbeat() {
    if (this._pongCheckTimer) {
      clearInterval(this._pongCheckTimer);
      this._pongCheckTimer = null;
    }
    if (this._heartbeatCounterResetTimer) {
      clearInterval(this._heartbeatCounterResetTimer);
      this._heartbeatCounterResetTimer = null;
    }
  }

  #startStalenessMonitor() {
    this.#stopStalenessMonitor();
    const cfg = this.stalenessConfig;
    this._stalenessCheckTimer = setInterval(() => {
      if (this._shuttingDown || this.subscribedSymbols.length === 0) return;
      if (this._lastSymbolMessageAt.size === 0 && !this._subscribedAt) return;

      const now = Date.now();
      let worstAge = 0;
      let worstSymbol = '';

      for (const sym of this.subscribedSymbols) {
        const key = this.normalizeSymbol(sym);
        const last = this._lastSymbolMessageAt.get(key) ?? this._subscribedAt;
        if (!last) continue;
        const age = now - last;
        if (age > cfg.warningMs && age <= cfg.criticalMs && !this._staleSymbols.has(key)) {
          console.warn(`[Binance] price stale: ${key} ${(age / 1000).toFixed(1)}s`);
        }
        if (age > cfg.criticalMs && !this._staleSymbols.has(key)) {
          this._staleSymbols.add(key);
          console.error(`[Binance] price frozen: ${key} ${(age / 1000).toFixed(1)}s`);
        }
        if (age > worstAge) {
          worstAge = age;
          worstSymbol = key;
        }
      }

      const totalCount = this.subscribedSymbols.length;
      if (!this._globalStaleEmitted && this._staleSymbols.size >= Math.ceil(totalCount * 0.2)) {
        this._globalStaleEmitted = true;
        console.error(`[Binance] global price freeze: ${this._staleSymbols.size}/${totalCount}, worst=${worstSymbol} ${(worstAge / 1000).toFixed(1)}s`);
        this.#schedulePublicWsReconnect('staleness-global');
      }
    }, cfg.checkIntervalMs);
    if (typeof this._stalenessCheckTimer.unref === 'function') {
      this._stalenessCheckTimer.unref();
    }
  }

  #stopStalenessMonitor() {
    if (this._stalenessCheckTimer) {
      clearInterval(this._stalenessCheckTimer);
      this._stalenessCheckTimer = null;
    }
    this._staleSymbols.clear();
    this._globalStaleEmitted = false;
  }

  /** 重连/重订阅后重置 per-symbol WS 接收时刻（bookTicker 仅在盘口变化时推送） */
  #resetPublicStalenessBaseline() {
    const now = Date.now();
    this._subscribedAt = now;
    for (const sym of this.subscribedSymbols) {
      this._lastSymbolMessageAt.set(this.normalizeSymbol(sym), now);
    }
    this._staleSymbols.clear();
    this._globalStaleEmitted = false;
  }

  #startPublicWs24hTimer() {
    this.#stopPublicWs24hTimer();
    this._publicWs24hTimer = setTimeout(() => {
      if (this._shuttingDown || this._reconnectingPublicWs) return;
      console.log('[Binance] public WS approaching 24h limit, proactive reconnect...');
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
    this.#stopPublicHeartbeat();
    this.#stopStalenessMonitor();
    this.#stopPublicWs24hTimer();
  }

  async #forcePublicWsReconnect(reason = 'unknown') {
    if (this._reconnectingPublicWs || this._shuttingDown) return;
    this._reconnectingPublicWs = true;
    try {
      this.#stopPublicWsTimers();
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.terminate();
        this.ws = null;
      }
      await this.connectWebSocket();
      console.log(`[Binance] public WS reconnected (${reason})`);
    } finally {
      this._reconnectingPublicWs = false;
    }
  }

  /** REST bookTicker（对齐 ArbiTrade-1 getTicker 回退） */
  async getBookTicker(symbol, options = {}) {
    const exSymbol = this.toExchangeSymbol(symbol);
    const timeout = Number(options.timeoutMs) || this.config.timeout || 5000;
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v1/ticker/bookTicker`, {
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

  #emitBookTicker(ticker, { viaRest = false, restReason = null } = {}) {
    const localTs = Date.now();
    this._lastPublicMessageAt = localTs;
    const sym = this.normalizeSymbol(ticker.symbol);
    this._lastSymbolMessageAt.set(sym, localTs);
    if (this._staleSymbols.has(sym)) {
      this._staleSymbols.delete(sym);
      if (this._staleSymbols.size === 0) {
        this._globalStaleEmitted = false;
      }
    }
    this.emit(EventTypes.TICKER, {
      ...ticker,
      symbol: sym,
      localTimestamp: localTs,
      wsDelayMs: viaRest ? null : ticker.wsDelayMs,
      source: 'binance',
      viaRest,
      restReason
    });
  }

  /** 重连后 bookTicker 可能长时间不推（盘口未变）；REST 立即补一条新鲜价 */
  async #refreshBookTickerViaRest(reason = 'rest', symbols = null) {
    const list = symbols?.length ? symbols : this.subscribedSymbols;
    if (!list.length) return;
    for (const symbol of list) {
      try {
        const row = await this.getBookTicker(symbol, { reason });
        this.#emitBookTicker(row, { viaRest: true, restReason: reason });
      } catch (err) {
        console.warn(`[Binance] REST bookTicker refresh ${symbol} (${reason}):`, err.message);
      }
    }
  }

  async processQueue() {
    if (this.processing || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.processing = true;
    try {
      const pending = [...this.subscriptionQueue];
      this.subscriptionQueue = [];
      if (pending.length === 0) return;

      const useCombined = this.useCombinedStream && pending.length >= this.combinedStreamThreshold;
      const batchSize = useCombined ? 200 : this.subscriptionBatchSize;
      const betweenBatchMs = useCombined ? 500 : this.#subscriptionDelayMs();

      for (let i = 0; i < pending.length; i += batchSize) {
        const batch = pending.slice(i, i + batchSize);
        this.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: batch, id: Date.now() }));
        for (const stream of batch) this.activeSubscriptions.add(stream);
        if (i + batchSize < pending.length) {
          await new Promise((r) => setTimeout(r, betweenBatchMs));
        }
      }
      if (useCombined) {
        console.log(`[Binance] combined SUBSCRIBE ${pending.length} streams`);
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
      if (msg?.error) {
        console.warn('[Binance] public WS error:', msg.error.msg || msg.error);
        return;
      }
      if (msg?.result !== undefined && msg?.id != null) return;

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
      // 对齐 ArbiTrade-1：wsDelay = 接收时间 - 交易所事件时间（不在此处归零）
      let wsDelayMs = exchangeMsRaw != null ? Math.max(0, localTs - exchangeMsRaw) : null;
      let exchangeMs = exchangeMsRaw ?? localTs;
      const MAX_SANE_WS_DELAY_MS = 30_000;
      if (exchangeMsRaw != null && wsDelayMs > MAX_SANE_WS_DELAY_MS) {
        exchangeMs = localTs;
        wsDelayMs = null;
      }
      const ticker = {
        symbol: this.normalizeSymbol(payload.s),
        bid,
        ask,
        timestamp: exchangeMs,
        serverTimestamp: rawEventTs,
        wsDelayMs
      };
      this.#emitBookTicker(ticker);
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

  /** 设置 U 本位合约初始杠杆（Portfolio Margin: POST /papi/v1/um/leverage） */
  async setSymbolLeverage(symbol, leverage = 1) {
    const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1)));
    const data = await this.#signedRequest('POST', '/papi/v1/um/leverage', {
      symbol: this.toExchangeSymbol(symbol),
      leverage: lev
    });
    return {
      symbol: this.toCompactSymbol(symbol),
      leverage: Number(data?.leverage ?? lev),
      maxNotionalValue: data?.maxNotionalValue != null ? Number(data.maxNotionalValue) : null
    };
  }

  #signQuery(params) {
    const p = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: '5000' });
    const sig = cryptoUtils.hmacSha256(p.toString(), process.env.BINANCE_API_SECRET);
    return `${p}&signature=${sig}`;
  }

  async #signedRequest(method, path, params = {}) {
    const query = this.#signQuery(params);
    const url = `${this.config.papiRestUrl}${path}?${query}`;
    try {
      const { data } = await axios({
        method,
        url,
        headers: { 'X-MBX-APIKEY': process.env.BINANCE_API_KEY },
        timeout: 15000
      });
      return data;
    } catch (err) {
      throw new Error(describeBinanceApiError(err));
    }
  }

  async #getDualSidePosition() {
    if (this._dualSidePosition == null) {
      try {
        const r = await this.#signedRequest('GET', '/papi/v1/um/positionSide/dual');
        this._dualSidePosition = Boolean(r?.dualSidePosition);
        if (this._dualSidePosition) {
          console.warn('[Binance] 检测到双向持仓模式，下单将自动带 positionSide（平仓不传 reduceOnly）');
        }
      } catch {
        this._dualSidePosition = false;
      }
    }
    return this._dualSidePosition;
  }

  /** Hedge 模式：-a+b → A 腿 SHORT，+a-b → A 腿 LONG（与 side 无关，开/平共用） */
  #positionSideFromDirection(positionDirection) {
    if (positionDirection === '-a+b') return 'SHORT';
    if (positionDirection === '+a-b') return 'LONG';
    return null;
  }

  async getBalance(options = {}) {
    const [rows, accountInfo] = await Promise.all([
      this.#signedRequest('GET', '/papi/v1/balance'),
      this.#signedRequest('GET', '/papi/v1/account').catch(() => null)
    ]);
    const accountAvail = Number(accountInfo?.totalAvailableBalance ?? NaN);
    const accountMargin = Number(accountInfo?.accountInitialMargin ?? NaN);
    const balances = (rows || [])
      .map((row) => {
        const asset = String(row.asset || '').toUpperCase();
        if (!asset) return null;
        const wallet = Number(row.totalWalletBalance || 0);
        const umPnl = Number(row.umUnrealizedPNL || 0);
        const cmPnl = Number(row.cmUnrealizedPNL || 0);
        const crossFree = Number(row.crossMarginFree || 0);
        const umWallet = Number(row.umWalletBalance || 0);
        const crossLocked = Number(row.crossMarginLocked || 0);
        const equity = wallet + umPnl + cmPnl;
        const usdtAvailable = crossFree + umWallet;
        const available = asset === 'USDT' && Number.isFinite(accountAvail) && accountAvail >= 0
          ? accountAvail
          : usdtAvailable;
        const marginUsed = asset === 'USDT' && Number.isFinite(accountMargin) && accountMargin >= 0
          ? accountMargin
          : Math.max(0, equity - usdtAvailable, crossLocked);
        if (equity <= 1e-12 && available <= 1e-12) return null;
        return new Balance({
          currency: asset,
          exchange: this.config.name,
          total: equity,
          available,
          marginUsed,
          frozen: marginUsed,
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
          initialMargin: Number(r.positionInitialMargin || r.initialMargin || 0),
          maintMargin: Number(r.maintMargin || 0),
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

  /** 发单前余额/持仓检查（对齐 ArbiTrade-1） */
  async checkOrderPreconditions(params) {
    return runCheckOrderPreconditions(this, {
      ...params,
      futuresMode: true
    });
  }

  async placeOrder(orderData) {
    this.validateOrderData(orderData);
    const side = String(orderData.side).toUpperCase();
    const type = String(orderData.type).toUpperCase();
    const qtyStr = formatQtyByStep(
      Number(orderData.amount),
      orderData.stepSize ?? orderData.binanceStepSize
    );
    const params = {
      symbol: this.toExchangeSymbol(orderData.symbol),
      side,
      type,
      quantity: qtyStr,
      newClientOrderId: orderData.clientOrderId || this.generateClientOrderId()
    };
    if (type === 'LIMIT' && orderData.price) {
      params.price = String(orderData.price);
      params.timeInForce = orderData.timeInForce || 'GTC';
    }
    const dualSide = await this.#getDualSidePosition();
    // 双向持仓模式：用 positionSide 区分多/空，禁止传 reduceOnly（会报 -1106）
    if (orderData.reduceOnly && !dualSide) {
      params.reduceOnly = 'true';
    }
    if (dualSide) {
      const positionSide = orderData.positionSide
        ?? this.#positionSideFromDirection(orderData.positionDirection);
      if (!positionSide) {
        throw new Error('双向持仓下单缺少 positionDirection/positionSide');
      }
      params.positionSide = positionSide;
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

  /** 订单成交明细（PnL 真实 quote / fee 来源） */
  async getOrderTrades(orderId, symbol) {
    const rows = await this.#signedRequest('GET', '/papi/v1/um/userTrades', {
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

  /** 汇总订单成交手续费（USDT） */
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

  async #createListenKey() {
    const data = await this.#signedRequest('POST', '/papi/v1/listenKey', {});
    const key = data?.listenKey;
    if (!key) throw new Error('Binance listenKey missing in response');
    return key;
  }

  async #keepaliveListenKey() {
    if (!this.listenKey || !this.privateWsConnected || this._privateWsReconnecting) return;
    await this.#signedRequest('PUT', '/papi/v1/listenKey', { listenKey: this.listenKey });
  }

  #isListenKeyMissingError(err) {
    const msg = String(err?.message || '');
    return msg.includes('-1125') || msg.toLowerCase().includes('listenkey does not exist');
  }

  #scheduleBalanceRestSync() {
    if (this._balanceSyncTimer) clearTimeout(this._balanceSyncTimer);
    this._balanceSyncTimer = setTimeout(() => {
      this.getBalance({ silent: true }).catch(() => {});
    }, 300);
  }

  async #deleteListenKeySafely({ expectMissing = false } = {}) {
    if (!this.listenKey) return;
    const key = this.listenKey;
    this.listenKey = null;
    try {
      await this.#signedRequest('DELETE', '/papi/v1/listenKey', { listenKey: key });
    } catch (err) {
      if (expectMissing && this.#isListenKeyMissingError(err)) return;
      console.warn('[Binance] delete listenKey failed:', err.message);
    }
  }

  #handleListenKeyKeepaliveError(err, context = 'interval') {
    if (!this.privateWsConnected || this._privateWsReconnecting) return;
    const sinceOpen = Date.now() - (this._privateWsOpenedAt || 0);
    if (sinceOpen < this._PRIVATE_WS_KEEPALIVE_GRACE_MS) return;
    console.warn(`[Binance] listenKey keepalive failed (${context}):`, err.message);
    if (this.#isListenKeyMissingError(err)) {
      this.#schedulePrivateWsReconnect('keepalive');
    }
  }

  #stopListenKeyTimer() {
    if (this._listenKeyTimer) {
      clearInterval(this._listenKeyTimer);
      this._listenKeyTimer = null;
    }
  }

  #stopPrivateWs24hTimer() {
    if (this._privateWs24hTimer) {
      clearTimeout(this._privateWs24hTimer);
      this._privateWs24hTimer = null;
    }
  }

  #stopPrivateWsTimers() {
    this.#stopListenKeyTimer();
    this.#stopPrivateWs24hTimer();
  }

  #startPrivateWs24hTimer() {
    this.#stopPrivateWs24hTimer();
    this._privateWs24hTimer = setTimeout(() => {
      if (this._shuttingDown || this._privateWsReconnecting) return;
      console.log('[Binance] private WS approaching 24h limit, proactive reconnect...');
      this.#schedulePrivateWsReconnect('24h-limit');
    }, this._WS_PROACTIVE_RECONNECT_MS);
    if (typeof this._privateWs24hTimer.unref === 'function') {
      this._privateWs24hTimer.unref();
    }
  }

  #startListenKeyTimer() {
    this.#stopListenKeyTimer();
    const ms = Math.max(1, this.listenKeyKeepaliveMin) * 60 * 1000;
    // 连接后立即续期一次，避免 setInterval 首次在 T+30min 才执行而踩 60min TTL
    this.#keepaliveListenKey().catch((err) => {
      this.#handleListenKeyKeepaliveError(err, 'initial');
    });
    this._listenKeyTimer = setInterval(() => {
      this.#keepaliveListenKey().catch((err) => {
        this.#handleListenKeyKeepaliveError(err, 'interval');
      });
    }, ms);
    if (typeof this._listenKeyTimer.unref === 'function') {
      this._listenKeyTimer.unref();
    }
    console.log(`[Binance] listenKey keepalive every ${this.listenKeyKeepaliveMin} min (immediate + interval)`);
  }

  #emitBalanceMerge(rows) {
    if (!rows?.length) return;
    this.emitBalanceUpdate(rows.map((row) => new Balance({
      currency: row.currency,
      exchange: this.config.name,
      total: row.total,
      available: row.available,
      marginUsed: row.marginUsed ?? row.frozen ?? 0,
      frozen: row.frozen ?? 0,
      timestamp: Date.now()
    })));
  }

  #emitPositionMerge(rows) {
    if (!rows?.length) return;
    const positions = rows.map((row) => {
      const qty = Number(row.qty);
      return new Position({
        symbol: this.toCompactSymbol(row.symbol),
        exchange: this.config.name,
        side: qty >= 0 ? 'long' : 'short',
        size: Math.abs(qty),
        qty,
        entryPrice: 0,
        markPrice: 0,
        unrealizedPnl: 0,
        leverage: 1,
        timestamp: Date.now()
      });
    });
    this.emitPositionUpdate(positions);
  }

  #handlePrivateMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.e === 'listenKeyExpired') {
        console.warn('[Binance] listenKey expired, reconnecting private WS...');
        this.listenKey = null;
        this.#schedulePrivateWsReconnect('listenKeyExpired');
        return;
      }
      if (msg.e !== 'ACCOUNT_UPDATE' || !msg.a) return;

      if ((msg.a.B || []).length > 0) {
        this.#scheduleBalanceRestSync();
      }

      const positionRows = [];
      for (const p of msg.a.P || []) {
        const symbol = String(p.s || '');
        if (!symbol) continue;
        positionRows.push({ symbol, qty: Number(p.pa ?? 0) });
      }
      this.#emitPositionMerge(positionRows);
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
      console.warn(`[Binance] private WS reconnect (${reason}) failed:`, err.message);
    });
  }

  async #reconnectPrivateWs(reason = 'unknown') {
    if (this._privateWsReconnecting || this._shuttingDown) return;
    this._privateWsReconnecting = true;
    try {
      console.log(`[Binance] Reconnecting private WS (${reason})...`);
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
      console.log(`[Binance] private WS reconnected (${reason})`);
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
    this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'binance' });
  }

  async #connectPrivateWs() {
    this.listenKey = await this.#createListenKey();
    const url = `${this.pmWsUrl}/${this.listenKey}`;
    const gen = this._privateWsGen;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.privateWs = ws;

      ws.on('open', async () => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        this.privateWsConnected = true;
        this._privateWsOpenedAt = Date.now();
        try {
          await this.syncAccountSnapshot({ silent: true });
          if (gen !== this._privateWsGen || this.privateWs !== ws) return;
          this.emit('PRIVATE_WS_CONNECTED', { exchange: 'binance' });
          console.log('[Binance] private WS connected, account snapshot synced');
          this.#startListenKeyTimer();
          this.#startPrivateWs24hTimer();
          resolve();
        } catch (err) {
          console.error('[Binance] private WS onOpen sync failed:', err.message);
          this.privateWsConnected = false;
          this.#stopPrivateWsTimers();
          this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'binance' });
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.pong(data);
        }
      });
      ws.on('message', (raw) => this.#handlePrivateMessage(raw));
      ws.on('close', () => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        this.privateWsConnected = false;
        this.#stopPrivateWsTimers();
        this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'binance' });
        if (this._shuttingDown || this._privateWsReconnecting) return;
        setTimeout(() => {
          this.#schedulePrivateWsReconnect('close');
        }, 2000);
      });
      ws.on('error', (err) => {
        if (gen !== this._privateWsGen || this.privateWs !== ws) return;
        console.error('[Binance] private WS error:', err.message);
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  async startPrivateAccountStream() {
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
      return;
    }
    if (this._privateWsReconnecting) return;
    await this.#teardownPrivateWs({ deleteListenKey: false });
    await this.#connectPrivateWs();
  }

  /** 公开深度 REST（下单前预检用） */
  async getOrderBook(symbol, limit = 20, options = {}) {
    const sym = this.toExchangeSymbol(symbol);
    const depthLimit = Math.min(Math.max(Number(limit) || 20, 5), 1000);
    const timeout = Number(options.timeoutMs) || 5000;
    const { data } = await axios.get(`${this.config.restUrl}/fapi/v1/depth`, {
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

  async stopPrivateAccountStream() {
    await this.#teardownPrivateWs({ deleteListenKey: true });
  }
}

export default BinanceAdapter;
