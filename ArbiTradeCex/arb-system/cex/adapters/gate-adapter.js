/**
 * Gate USDT 永续适配器
 * - single（默认）：单币种保证金，余额走 /futures/usdt/accounts + futures.balances WS
 * - unified：跨币种统一账户，余额走 /unified/accounts + unified.asset_detail WS
 */
import WebSocket from 'ws';
import axios from 'axios';
import { parseJsonPreserveBigIntIds, idToString } from '../../common/utils/parse-json-bigint.js';
import { BaseAdapter } from './base-adapter.js';
import { Balance, Order, Position, OrderStatus, EventTypes } from '../types.js';
import { cryptoUtils } from '../utils.js';
import {
  checkOrderPreconditions as runCheckOrderPreconditions
} from '../utils/check-order-preconditions.js';

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
    /** 公共 book_ticker WS；主进程用 market worker 时可关 */
    this.enablePublicStream = config.enablePublicStream !== false;
    /** worker 模式下主进程单独 fx-ws，仅 balances/positions（不订 book_ticker） */
    this.enablePrivateAccountStream = config.enablePrivateAccountStream
      ?? (config.enablePublicStream === false);
    /** 与 this.ws（公共行情）分离的账户专用连接 */
    this.accountWs = null;
    this._privateAccountSymbols = [];
    this._reconnectingAccountWs = false;
    this._accountWsReconnectAttempts = 0;
    this._maxAccountWsReconnectAttempts = 20;
    this.accountMode = String(
      config.accountMode || process.env.GATE_ACCOUNT_MODE || 'single'
    ).toLowerCase();
    this.subscribed = [];
    this.subscribedChannels = ['book_ticker'];
    this._lastSymbolMessageAt = new Map();
    this._feedWatchdog = null;
    this._reconnectingPublicWs = false;
    this._publicReconnectAttempts = 0;
    this._maxPublicReconnectAttempts = 20;
    this._publicWsReconnectAt = 0;
    this._publicWsEverOpened = false;
    this._nextReconnectAllowedAt = 0;
    this._restRefreshPending = false;
    this._shuttingDown = false;
    this._symbolStaleMs = Number(config.symbolStaleMs) || 900;
    this._lastWsRawMessageAt = 0;
    this._wsIdleCheckTimer = null;
    this._wsIdleReconnectMs = 5 * 60 * 1000;
    this._reconnectRecoveryTimer = null;
    this._reconnectRecoveryMs = 5 * 60 * 1000;
    this._balanceCache = null;
    this._positionCache = new Map();
    this.unifiedWsUrl = process.env.GATE_UNIFIED_WS_URL || 'wss://ws.gate.com/v4/ws/unified';
    this.unifiedWs = null;
    this.unifiedWsConnected = false;
    this.privatePositionsSubscribed = false;
    this.privateBalancesSubscribed = false;
    this._userId = null;
    /** contract -> quanto_multiplier（WS 持仓推送不含 multiplier） */
    this._contractMultipliers = new Map();
  }

  #getContractMultiplier(contract) {
    const key = String(contract || '');
    if (this._contractMultipliers.has(key)) {
      return this._contractMultipliers.get(key);
    }
    const compact = this.toCompactSymbol(key.replace('_USDT', 'USDT'));
    for (const [name, mult] of this._contractMultipliers) {
      if (this.toCompactSymbol(name) === compact) return mult;
    }
    return 1;
  }

  #contractsToBaseQty(contract, contractSize) {
    return Number(contractSize) * this.#getContractMultiplier(contract);
  }

  async #refreshContractMultipliers() {
    try {
      const { data } = await axios.get(`${this.config.restUrl}/futures/usdt/contracts`, {
        timeout: this.config.timeout
      });
      for (const c of data || []) {
        const name = c.name || c.contract;
        if (!name) continue;
        this._contractMultipliers.set(String(name), Number(c.quanto_multiplier || 1));
      }
    } catch (err) {
      console.warn('[Gate] load contract multipliers failed:', err.message);
    }
  }

  #isUnifiedMode() {
    const mode = this.accountMode;
    return mode === 'unified' || mode === 'cross' || mode === 'multi';
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

  get publicConnected() {
    return Boolean(this.enablePublicStream && this.ws?.readyState === WebSocket.OPEN);
  }

  /** single 模式下私有 futures 订阅所用的 fx-ws（公共开则用 this.ws，否则 accountWs） */
  #getPrivateFxWs() {
    if (this.enablePublicStream) return this.ws;
    return this.accountWs;
  }

  #isPrivateFxOpen() {
    const ws = this.#getPrivateFxWs();
    return ws?.readyState === WebSocket.OPEN;
  }

  #privateAccountStreamReady() {
    if (this.#isUnifiedMode()) {
      return this.unifiedWsConnected
        || (this.#isPrivateFxOpen() && this.privatePositionsSubscribed);
    }
    if (!this.#isPrivateFxOpen()) return false;
    return this.privateBalancesSubscribed || this.privatePositionsSubscribed;
  }

  #emitPrivateWsConnected() {
    this.emit('PRIVATE_WS_CONNECTED', {
      exchange: 'gate',
      positionsReady: this.privatePositionsSubscribed
    });
  }

  async reconnectWebSocket() {
    if (!this.enablePublicStream || this._reconnectingPublicWs || this._shuttingDown) return;
    this._reconnectingPublicWs = true;
    try {
      this.#stopFeedWatchdog();
      this.#stopWsIdleMonitor();
      if (this.ws) {
        this.ws.removeAllListeners();
        this.ws.terminate();
        this.ws = null;
      }
      await this.connectWebSocket();
      console.log('[Gate] public WS reconnected (manual)');
    } finally {
      this._reconnectingPublicWs = false;
    }
  }

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    if (this.enablePublicStream) {
      await this.connectWebSocket();
    }
    if (process.env.GATE_API_KEY && process.env.GATE_API_SECRET) {
      this.authenticated = true;
    }
    await super.connect();
    if (this.authenticated) {
      await this.#refreshContractMultipliers();
      const modeLabel = this.#isUnifiedMode() ? 'unified (cross-currency)' : 'single (USDT futures)';
      console.log(`[Gate] account mode: ${modeLabel}`);
    }
  }

  async disconnect() {
    this._shuttingDown = true;
    this.#stopFeedWatchdog();
    this.#stopWsIdleMonitor();
    this.#stopReconnectRecovery();
    await this.stopPrivateAccountStream();
    this.#teardownAccountWebSocket();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    await super.disconnect();
  }

  #teardownAccountWebSocket() {
    if (this.accountWs) {
      this.accountWs.removeAllListeners();
      this.accountWs.close();
      this.accountWs = null;
    }
  }

  #signV4({ method, path, queryString, body, timestamp }) {
    const payload = `${method}\n${path}\n${queryString}\n${cryptoUtils.sha512Hex(body)}\n${timestamp}`;
    return cryptoUtils.hmacSha512(payload, process.env.GATE_API_SECRET || '');
  }

  #formatApiError(err) {
    const data = err?.response?.data;
    if (data?.label || data?.message) {
      return `Gate[${data.label || 'ERROR'}] ${data.message || ''}`.trim();
    }
    return err?.message || 'Gate request failed';
  }

  async #signedRequest(method, path, options = null, extraHeaders = {}, requestOpts = {}) {
    let bodyObj = null;
    let queryString = '';
    let urlPath = path;

    if (options) {
      if (method === 'GET' || method === 'DELETE' || requestOpts.asQuery) {
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
      timeout: 15000,
      transformResponse: [(data) => parseJsonPreserveBigIntIds(data)]
    };
    if (bodyObj) config.data = bodyObj;
    try {
      const { data } = await axios(config);
      return data;
    } catch (err) {
      throw new Error(this.#formatApiError(err));
    }
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
        this._publicReconnectAttempts = 0;
        if (this.subscribed.length > 0) {
          await this.subscribe(this.subscribed, this.subscribedChannels);
        }
        if (this.privatePositionsSubscribed || this.privateBalancesSubscribed || this.unifiedWsConnected) {
          await this.#subscribePositions(this.subscribed).catch((err) => {
            console.warn('[Gate] resubscribe positions failed:', err.message);
          });
          if (this.privateBalancesSubscribed) {
            await this.#subscribeBalances().catch((err) => {
              console.warn('[Gate] resubscribe balances failed:', err.message);
            });
          }
          if (this.#privateAccountStreamReady()) {
            this.#emitPrivateWsConnected();
          }
        }
        this.#startFeedWatchdog();
        this.#startWsIdleMonitor();
        this._lastWsRawMessageAt = Date.now();
        const clearCache = this._publicWsEverOpened;
        this._publicWsEverOpened = true;
        this.emit('PUBLIC_WS_RECONNECTED', {
          exchange: 'gate',
          reason: 'public-ws-open',
          clearCache
        });
        resolve();
      });
      ws.on('message', (raw) => {
        this._lastWsRawMessageAt = Date.now();
        this.handleMessage(raw);
      });
      ws.on('close', (code) => {
        this.connected = false;
        this.#stopFeedWatchdog();
        this.#stopWsIdleMonitor();
        if (this._shuttingDown || this._reconnectingPublicWs) return;

        if (this._publicReconnectAttempts >= this._maxPublicReconnectAttempts) {
          console.error(`[Gate] public WS max reconnect attempts reached (${this._maxPublicReconnectAttempts}), will retry in ${this._reconnectRecoveryMs / 1000}s`);
          this.#scheduleReconnectRecovery();
          return;
        }
        this._publicReconnectAttempts += 1;
        const baseDelay = Math.min(1000 * (2 ** (this._publicReconnectAttempts - 1)), 30_000);
        const cooldownDelay = Math.max(0, this._nextReconnectAllowedAt - Date.now());
        const delay = Math.max(baseDelay, cooldownDelay);
        console.warn(`[Gate] public WS closed (code=${code}), reconnect in ${delay}ms (${this._publicReconnectAttempts}/${this._maxPublicReconnectAttempts})`);
        setTimeout(() => {
          this.connectWebSocket().catch((err) => {
            console.warn('[Gate] public WS reconnect failed:', err.message);
          });
        }, delay);
      });
      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  /** worker 模式：主进程单独 fx-ws，只用于 futures.balances / futures.positions */
  async #connectAccountWebSocket() {
    if (this.enablePublicStream || !this.enablePrivateAccountStream || this._shuttingDown) return;
    const wsState = this.accountWs?.readyState;
    if (wsState === WebSocket.OPEN || wsState === WebSocket.CONNECTING) return;

    this.#teardownAccountWebSocket();

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.accountWs = ws;

      ws.on('open', async () => {
        this._accountWsReconnectAttempts = 0;
        try {
          const resubscribe = this.privateBalancesSubscribed || this.privatePositionsSubscribed;
          if (!this.#isUnifiedMode() && this.privateBalancesSubscribed) {
            await this.#subscribeBalances();
          }
          if (this.privatePositionsSubscribed) {
            await this.#subscribePositions(this._privateAccountSymbols);
          }
          console.log('[Gate] account fx-ws connected (worker mode: balances/positions only)');
          if (resubscribe && this.#privateAccountStreamReady()) {
            this.#emitPrivateWsConnected();
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ws.on('message', (raw) => this.#handleAccountWsMessage(raw));

      ws.on('close', (code) => {
        if (this._shuttingDown || this._reconnectingAccountWs) return;

        if (this._accountWsReconnectAttempts >= this._maxAccountWsReconnectAttempts) {
          console.error(
            `[Gate] account fx-ws max reconnect attempts (${this._maxAccountWsReconnectAttempts}), retry in ${this._reconnectRecoveryMs / 1000}s`
          );
          this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'gate' });
          setTimeout(() => {
            this._accountWsReconnectAttempts = 0;
            this.#connectAccountWebSocket().catch(() => {});
          }, this._reconnectRecoveryMs);
          return;
        }

        this._accountWsReconnectAttempts += 1;
        const delay = Math.min(1000 * (2 ** (this._accountWsReconnectAttempts - 1)), 30_000);
        console.warn(
          `[Gate] account fx-ws closed (code=${code}), reconnect in ${delay}ms `
          + `(${this._accountWsReconnectAttempts}/${this._maxAccountWsReconnectAttempts})`
        );
        this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'gate' });
        setTimeout(() => {
          this.#connectAccountWebSocket().catch((err) => {
            console.warn('[Gate] account fx-ws reconnect failed:', err.message);
          });
        }, delay);
      });

      ws.on('error', (err) => {
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
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
      source: 'gate',
      viaRest,
      restReason
    });
  }

  async #refreshBookTickerViaRest(reason = 'rest', symbols = null) {
    const list = symbols?.length ? symbols : this.subscribed;
    if (!list.length) return;
    await Promise.all(list.map(async (symbol) => {
      try {
        const row = await this.getBookTicker(symbol, { reason });
        this.#emitBookTicker(row, { viaRest: true, restReason: reason });
      } catch (err) {
        console.warn(`[Gate] REST bookTicker refresh ${symbol} (${reason}):`, err.message);
      }
    }));
  }

  #startFeedWatchdog() {
    this.#stopFeedWatchdog();
    this._feedWatchdog = setInterval(() => {
      if (this._shuttingDown || this.subscribed.length === 0) return;
      const staleSymbols = this.subscribed.filter((sym) => {
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

  #startWsIdleMonitor() {
    this.#stopWsIdleMonitor();
    this._wsIdleCheckTimer = setInterval(() => {
      if (this._shuttingDown || this._reconnectingPublicWs || !this.ws) return;
      const last = this._lastWsRawMessageAt || 0;
      if (last > 0 && Date.now() - last > this._wsIdleReconnectMs) {
        console.warn(`[Gate] public WS idle ${((Date.now() - last) / 1000).toFixed(0)}s, reconnecting...`);
        this.connectWebSocket().catch((err) => {
          console.warn('[Gate] public WS idle reconnect failed:', err.message);
        });
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

  #scheduleReconnectRecovery() {
    if (this._shuttingDown || this._reconnectRecoveryTimer) return;
    this._reconnectRecoveryTimer = setTimeout(() => {
      this._reconnectRecoveryTimer = null;
      if (this._shuttingDown) return;
      console.log('[Gate] public WS max-attempts recovery retry...');
      this._publicReconnectAttempts = 0;
      this.connectWebSocket().catch((err) => {
        console.warn('[Gate] public WS recovery reconnect failed:', err.message);
      });
    }, this._reconnectRecoveryMs);
    if (typeof this._reconnectRecoveryTimer.unref === 'function') {
      this._reconnectRecoveryTimer.unref();
    }
  }

  #stopReconnectRecovery() {
    if (this._reconnectRecoveryTimer) {
      clearTimeout(this._reconnectRecoveryTimer);
      this._reconnectRecoveryTimer = null;
    }
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
    if (!this.enablePublicStream) return;
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

  #wsAuth(channel, event, timeSec) {
    const message = `channel=${channel}&event=${event}&time=${timeSec}`;
    return {
      method: 'api_key',
      KEY: process.env.GATE_API_KEY || '',
      SIGN: cryptoUtils.hmacSha512(message, process.env.GATE_API_SECRET || '')
    };
  }

  handleMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (this.#handlePrivateChannelMessage(msg)) return;
      if (!this.enablePublicStream) return;
      if (msg.channel !== 'futures.book_ticker' || msg.event !== 'update') return;

      const r = msg.result || {};
      const contract = String(r.s || r.contract || '');
      if (!contract) return;

      const bid = Number(r.b);
      const ask = Number(r.a);
      if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) return;

      const localTs = Date.now();
      const serverTimestamp = r.t ?? null;
      const exchangeMsRaw = serverTimestamp != null && Number.isFinite(Number(serverTimestamp))
        ? (Number(serverTimestamp) > 1e12 ? Number(serverTimestamp) : Number(serverTimestamp) * 1000)
        : null;
      const timestamp = exchangeMsRaw ?? localTs;
      const wsDelayMs = exchangeMsRaw != null ? Math.max(0, localTs - exchangeMsRaw) : null;

      const symbol = this.normalizeSymbol(this.toCompactSymbol(contract));
      this.#emitBookTicker({
        symbol,
        bid,
        ask,
        timestamp,
        serverTimestamp,
        wsDelayMs
      });
    } catch {
      // ignore
    }
  }

  #handleAccountWsMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      this.#handlePrivateChannelMessage(msg);
    } catch {
      // ignore
    }
  }

  /** @returns {boolean} handled */
  #handlePrivateChannelMessage(msg) {
    if (msg.channel === 'futures.positions' && msg.event === 'update') {
      this.#handlePositionsUpdate(msg.result);
      return true;
    }
    if (msg.channel === 'futures.balances' && msg.event === 'update') {
      this.#handleFuturesBalancesUpdate(msg.result);
      return true;
    }
    return false;
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
    if (this.#isUnifiedMode()) {
      return this.#getUnifiedBalance(options);
    }
    return this.#getSingleFuturesBalance(options);
  }

  async #getUnifiedBalance(options = {}) {
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

  async #sumPositionInitialMargin() {
    try {
      const rows = await this.#signedRequest('GET', '/futures/usdt/positions');
      let sum = 0;
      for (const r of rows || []) {
        if (Math.abs(Number(r.size)) <= 0) continue;
        sum += Math.abs(Number(r.initial_margin ?? r.margin ?? 0));
      }
      return sum;
    } catch {
      return 0;
    }
  }

  /** Gate 全仓/新账户 API：position_margin 常为空，需读 cross_* / 持仓 initial_margin */
  async #resolveSingleFuturesMarginUsed(data, equity, available) {
    const crossInit = Number(data?.cross_initial_margin ?? 0);
    const isolatedPos = Number(data?.isolated_position_margin ?? data?.position_margin ?? 0);
    const posInitUnified = Number(data?.position_initial_margin ?? 0);
    const orderMargin = Number(data?.cross_order_margin ?? data?.order_margin ?? 0);
    let positionMargin = crossInit + isolatedPos;
    if (positionMargin <= 0 && posInitUnified > 0) {
      positionMargin = posInitUnified;
    }
    if (positionMargin <= 0 && orderMargin <= 0) {
      positionMargin = await this.#sumPositionInitialMargin();
    }
    return Math.max(0, positionMargin + orderMargin, equity - available);
  }

  async #getSingleFuturesBalance(options = {}) {
    const data = await this.#signedRequest('GET', '/futures/usdt/accounts');
    const unrealised = Number(data?.unrealised_pnl ?? data?.cross_unrealised_pnl ?? 0);
    const available = Number(
      data?.cross_available ?? data?.available ?? data?.available_margin ?? 0
    );
    const rawTotal = Number(
      data?.total ?? data?.margin_balance ?? data?.cross_margin_balance ?? NaN
    );
    const equityField = Number(data?.equity ?? data?.account_equity ?? NaN);
    let equity = Number.isFinite(equityField) && equityField > 0
      ? equityField
      : (Number.isFinite(rawTotal) && rawTotal > 0 ? rawTotal + unrealised : available);
    if (equity <= 0 && available > 0) equity = available;
    const marginUsed = await this.#resolveSingleFuturesMarginUsed(data, equity, available);
    const balances = [];
    if (equity > 0 || available > 0) {
      balances.push(new Balance({
        currency: 'USDT',
        exchange: this.config.name,
        total: equity,
        available,
        marginUsed,
        frozen: marginUsed,
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
        const contract = String(r.contract || '');
        const size = Number(r.size);
        const multiplier = Number(r.quanto_multiplier || this.#getContractMultiplier(contract));
        if (Number.isFinite(multiplier) && multiplier > 0) {
          this._contractMultipliers.set(contract, multiplier);
        }
        const baseQty = size * multiplier;
        const pos = new Position({
          symbol: this.toCompactSymbol(contract),
          exchange: this.config.name,
          side: size >= 0 ? 'long' : 'short',
          size: Math.abs(baseQty),
          qty: baseQty,
          entryPrice: Number(r.entry_price || 0),
          markPrice: Number(r.mark_price || 0),
          unrealizedPnl: Number(r.unrealised_pnl || 0),
          leverage: Number(r.leverage || 0) > 0
            ? Number(r.leverage)
            : Number(r.cross_leverage_limit || r.lever || 1),
          initialMargin: Number(r.initial_margin || 0),
          maintMargin: Number(r.maintenance_margin || r.maint_margin || 0),
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

  #parseGateFilled(response) {
    const size = Math.abs(Number(response.size || 0));
    if (size <= 0) return 0;
    if (response.left == null) {
      return response.status === 'finished' ? size : 0;
    }
    const left = Math.abs(Number(response.left));
    return Math.max(0, size - left);
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
    if (orderData.reduceOnly) {
      body.reduce_only = true;
    }
    const headers = orderData.decimalSize ? { 'X-Gate-Size-Decimal': '1' } : {};
    const response = await this.#signedRequest('POST', '/futures/usdt/orders', body, headers);
    const filled = this.#parseGateFilled(response);
    return new Order({
      orderId: idToString(response.id),
      clientOrderId: response.text,
      symbol: this.normalizeSymbol(orderData.symbol),
      exchange: this.config.name,
      side,
      type,
      amount: Math.abs(Number(orderData.amount)),
      price: Number(response.price || orderData.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled,
      timestamp: Date.now(),
      avgPrice: Number(response.fill_price || 0),
      cumQuote: this.#gateOrderCumQuote(response, contract, filled)
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
    const filled = this.#parseGateFilled(response);
    return new Order({
      orderId: idToString(response.id),
      clientOrderId: response.text,
      symbol: this.normalizeSymbol(symbol),
      exchange: this.config.name,
      side: Number(response.size) >= 0 ? 'buy' : 'sell',
      type: Number(response.price) > 0 ? 'limit' : 'market',
      amount: Math.abs(Number(response.size || 0)),
      price: Number(response.price || 0),
      status: this.#mapOrderStatus(response.status),
      filled,
      timestamp: Number(response.create_time || Date.now()) * 1000,
      avgPrice: Number(response.fill_price || 0),
      cumQuote: this.#gateOrderCumQuote(response, contract, filled, false)
    });
  }

  async getOrderHistory(symbol, limit = 100) {
    const contract = this.toGateContract(symbol);
    const response = await this.#signedRequest('GET', '/futures/usdt/orders', { contract, limit });
    return (response || []).map((row) => new Order({
      orderId: idToString(row.id),
      clientOrderId: row.text,
      symbol: this.normalizeSymbol(symbol),
      exchange: this.config.name,
      side: Number(row.size) >= 0 ? 'buy' : 'sell',
      type: Number(row.price) > 0 ? 'limit' : 'market',
      amount: Math.abs(Number(row.size || 0)),
      price: Number(row.price || 0),
      status: this.#mapOrderStatus(row.status),
      filled: this.#parseGateFilled(row),
      timestamp: Number(row.create_time || Date.now()) * 1000,
      avgPrice: Number(row.fill_price || 0)
    }));
  }

  #gateOrderCumQuote(response, contract, filledContracts) {
    const filled = Number(filledContracts);
    const avgPrice = Number(response.fill_price || 0);
    if (!(filled > 0) || !(avgPrice > 0)) return 0;
    const mult = this.#getContractMultiplier(contract);
    return filled * mult * avgPrice;
  }

  /** 订单成交明细（PnL 真实 quote / fee 来源） */
  async getOrderTrades(orderId, symbol, options = {}) {
    const contract = this.toGateContract(symbol);
    const orderStr = String(orderId);
    const mult = this.#getContractMultiplier(contract);
    const mapRows = (rows) => (rows || []).map((row) => {
      const contracts = Math.abs(Number(row.size || 0));
      const price = Number(row.price || 0);
      const baseQty = contracts * mult;
      return {
        contracts,
        price,
        baseQty,
        quoteQty: baseQty * price,
        fee: Math.abs(Number(row.fee || 0)) + Math.abs(Number(row.point_fee || 0)),
        feeAsset: 'USDT',
        orderId: idToString(row.order_id ?? row.orderId),
      };
    });

    // order 必须用字符串传递（Gate order_id 常超过 JS 安全整数）
    let rows = await this.#signedRequest('GET', '/futures/usdt/my_trades', {
      contract,
      order: orderStr,
      limit: 100
    });
    let mapped = mapRows(rows).filter((row) => !row.orderId || row.orderId === orderStr);
    if (mapped.length > 0) return mapped;

    const from = Math.floor(Date.now() / 1000) - 180;
    rows = await this.#signedRequest('GET', '/futures/usdt/my_trades_timerange', {
      contract,
      from,
      limit: 100
    });
    mapped = mapRows(rows).filter((row) => row.orderId === orderStr);
    return mapped;
  }

  /** 汇总订单成交手续费（USDT） */
  async getOrderCommission(orderId, symbol, options = {}) {
    const trades = await this.getOrderTrades(orderId, symbol, options);
    return trades.reduce((sum, row) => sum + row.fee, 0);
  }

  async checkOrder(orderData) {
    this.validateOrderData(orderData);
    return true;
  }

  async syncAccountSnapshot(options = {}) {
    await this.getBalance({ silent: true, ...options });
    await this.getPositions({ silent: true, ...options });
  }

  async #fetchUserId() {
    if (this._userId) return this._userId;

    if (this.#isUnifiedMode()) {
      const data = await this.#signedRequest('GET', '/unified/accounts');
      const uid = data?.user_id ?? data?.user ?? data?.uid ?? data?.id;
      if (uid != null && String(uid)) {
        this._userId = String(uid);
        return this._userId;
      }
      throw new Error('Gate user_id not found in /unified/accounts');
    }

    try {
      const wallet = await this.#signedRequest('GET', '/wallet/user_id');
      const uid = wallet?.user_id ?? wallet?.user_id_str ?? wallet?.id;
      if (uid != null && String(uid)) {
        this._userId = String(uid);
        return this._userId;
      }
    } catch {
      // fallback below
    }

    const futures = await this.#signedRequest('GET', '/futures/usdt/accounts');
    const uid = futures?.user ?? futures?.user_id ?? futures?.uid;
    if (uid != null && String(uid)) {
      this._userId = String(uid);
      return this._userId;
    }
    throw new Error('Gate user_id not found for single-currency account');
  }

  #handlePositionsUpdate(result) {
    const rows = Array.isArray(result) ? result : (result ? [result] : []);
    const positions = [];
    for (const r of rows) {
      const contract = String(r.contract || r.s || '');
      if (!contract) continue;
      const size = Number(r.size ?? 0);
      const rowMult = Number(r.quanto_multiplier);
      if (Number.isFinite(rowMult) && rowMult > 0) {
        this._contractMultipliers.set(contract, rowMult);
      }
      const baseQty = Number.isFinite(rowMult) && rowMult > 0
        ? size * rowMult
        : this.#contractsToBaseQty(contract, size);
      const pos = new Position({
        symbol: this.toCompactSymbol(contract),
        exchange: this.config.name,
        side: size >= 0 ? 'long' : 'short',
        size: Math.abs(baseQty),
        qty: baseQty,
        entryPrice: Number(r.entry_price || 0),
        markPrice: Number(r.mark_price || 0),
        unrealizedPnl: Number(r.unrealised_pnl || 0),
        leverage: Number(r.leverage || 0) > 0
          ? Number(r.leverage)
          : Number(r.cross_leverage_limit || r.lever || 1),
        initialMargin: Number(r.initial_margin || 0),
        maintMargin: Number(r.maintenance_margin || r.maint_margin || 0),
        timestamp: Date.now()
      });
      pos.contracts = size;
      positions.push(pos);
    }
    if (positions.length > 0) {
      this.emitPositionUpdate(positions);
    }
  }

  async #reconnectPrivateAccount() {
    const symbols = this._privateAccountSymbols.length ? this._privateAccountSymbols : this.subscribed;
    this._reconnectingAccountWs = true;
    try {
      await this.stopPrivateAccountStream();
      await this.startPrivateAccountStream(symbols);
    } finally {
      this._reconnectingAccountWs = false;
    }
  }

  #handleFuturesBalancesUpdate(result) {
    /** WS 只有 balance 增量，不含 equity/unrealised_pnl；改走 REST 全量同步 */
    this.#scheduleBalanceRestSync();
  }

  #scheduleBalanceRestSync() {
    if (this._balanceSyncTimer) clearTimeout(this._balanceSyncTimer);
    this._balanceSyncTimer = setTimeout(() => {
      this.#getSingleFuturesBalance({ silent: true }).catch(() => {});
    }, 300);
  }

  #handleUnifiedMessage(raw) {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== 'unified.asset_detail' || msg.event !== 'update') return;
      const result = msg.result || {};
      if (result.u != null) this._userId = String(result.u);
      const dts = result.dts || {};
      const usdt = dts.USDT;
      if (!usdt) return;
      const available = Number(usdt.a ?? usdt.available ?? 0);
      const total = Number(usdt.b ?? usdt.balance ?? available);
      if (total <= 1e-12 && available <= 1e-12) {
        this.emitBalanceUpdate([new Balance({
          currency: 'USDT',
          exchange: this.config.name,
          total: 0,
          available: 0,
          frozen: 0,
          timestamp: Date.now()
        })]);
        return;
      }
      this.emitBalanceUpdate([new Balance({
        currency: 'USDT',
        exchange: this.config.name,
        total,
        available,
        frozen: Math.max(0, total - available),
        timestamp: Date.now()
      })]);
    } catch {
      // ignore
    }
  }

  async #subscribeBalances() {
    const ws = this.#getPrivateFxWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const userId = await this.#fetchUserId();
    const time = Math.floor(Date.now() / 1000);
    const channel = 'futures.balances';
    const event = 'subscribe';
    ws.send(JSON.stringify({
      time,
      channel,
      event,
      auth: this.#wsAuth(channel, event, time),
      payload: [userId]
    }));
    this.privateBalancesSubscribed = true;
  }

  async #subscribePositions(symbols) {
    const ws = this.#getPrivateFxWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const userId = await this.#fetchUserId();
    const contracts = (symbols || this.subscribed || []).map((s) => this.toGateContract(s));
    const time = Math.floor(Date.now() / 1000);
    const channel = 'futures.positions';
    const event = 'subscribe';
    ws.send(JSON.stringify({
      time,
      channel,
      event,
      auth: this.#wsAuth(channel, event, time),
      payload: [userId, ...contracts]
    }));
    this.privatePositionsSubscribed = true;
  }

  async #connectUnifiedWs() {
    if (this.unifiedWs) return;
    await new Promise((resolve, reject) => {
      this.unifiedWs = new WebSocket(this.unifiedWsUrl);
      this.unifiedWs.on('open', () => {
        const time = Math.floor(Date.now() / 1000);
        const channel = 'unified.asset_detail';
        const event = 'subscribe';
        this.unifiedWs.send(JSON.stringify({
          time,
          channel,
          event,
          auth: this.#wsAuth(channel, event, time),
          payload: ['USDT']
        }));
        resolve();
      });
      this.unifiedWs.on('message', (raw) => this.#handleUnifiedMessage(raw));
      this.unifiedWs.on('close', () => {
        this.unifiedWsConnected = false;
        this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'gate' });
        if (this._shuttingDown) return;
        setTimeout(() => {
          this.#reconnectPrivateAccount().catch(() => {});
        }, 2000);
      });
      this.unifiedWs.on('error', reject);
    });
    this.unifiedWsConnected = true;
  }

  async #reconnectUnifiedWs() {
    if (this.unifiedWs) {
      this.unifiedWs.removeAllListeners();
      this.unifiedWs.close();
      this.unifiedWs = null;
    }
    await this.#connectUnifiedWs();
  }

  async startPrivateAccountStream(symbols = []) {
    if (!process.env.GATE_API_KEY || !process.env.GATE_API_SECRET) return;

    this._privateAccountSymbols = symbols?.length ? [...symbols] : [...this.subscribed];

    await this.syncAccountSnapshot({ silent: true });

    if (this.#isUnifiedMode()) {
      await this.#connectUnifiedWs();
    } else if (!this.enablePublicStream && this.enablePrivateAccountStream) {
      await this.#connectAccountWebSocket();
    } else if (this.ws?.readyState !== WebSocket.OPEN) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (this.#isPrivateFxOpen()) {
      if (!this.#isUnifiedMode()) {
        await this.#subscribeBalances();
      }
      await this.#subscribePositions(this._privateAccountSymbols);
    } else if (!this.#isUnifiedMode()) {
      if (this.enablePrivateAccountStream && !this.enablePublicStream) {
        console.warn('[Gate] account fx-ws not open; private futures subscriptions skipped');
      } else {
        console.warn('[Gate] public fx-ws not open; private futures subscriptions skipped');
      }
    }

    if (this.#privateAccountStreamReady()) {
      this.#emitPrivateWsConnected();
    }
    const modeNote = this.#isUnifiedMode() ? 'unified USDT' : 'single USDT futures';
    const wsNote = !this.enablePublicStream && this.enablePrivateAccountStream ? 'account-fx-ws' : 'public-fx-ws';
    const balNote = this.#isUnifiedMode()
      ? (this.unifiedWsConnected ? 'unified.asset_detail' : 'unified pending')
      : (this.privateBalancesSubscribed ? 'futures.balances' : 'balances pending');
    const posNote = this.privatePositionsSubscribed ? 'futures.positions' : 'positions pending';
    console.log(`[Gate] private streams (${modeNote} via ${wsNote}: ${balNote} + ${posNote})`);
  }

  /** 设置 USDT 永续杠杆（Gate 要求 query 参数，非 JSON body） */
  async setSymbolLeverage(symbol, leverage = 1) {
    const contract = this.toGateContract(symbol);
    const lev = String(Math.max(1, Math.min(125, Math.floor(Number(leverage) || 1))));
    const path = `/futures/usdt/positions/${contract}/leverage`;
    const queryOpts = { asQuery: true };

    try {
      const data = await this.#signedRequest(
        'POST',
        path,
        { leverage: '0', cross_leverage_limit: lev },
        {},
        queryOpts
      );
      return {
        symbol: this.toCompactSymbol(symbol),
        contract,
        leverage: Number(data?.cross_leverage_limit ?? data?.lever ?? lev),
        mode: 'cross'
      };
    } catch (crossErr) {
      try {
        const data = await this.#signedRequest(
          'POST',
          path,
          { leverage: lev },
          {},
          queryOpts
        );
        return {
          symbol: this.toCompactSymbol(symbol),
          contract,
          leverage: Number(data?.leverage ?? data?.lever ?? lev),
          mode: 'isolated'
        };
      } catch (isolatedErr) {
        throw new Error(`全仓: ${crossErr.message}; 逐仓: ${isolatedErr.message}`);
      }
    }
  }

  /** REST 最优买卖（对齐 ArbiTrade-1 getTicker 回退） */
  async getBookTicker(symbol, options = {}) {
    const book = await this.getOrderBook(symbol, 1, options);
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (!(Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0)) {
      throw new Error(`Invalid Gate bookTicker ${symbol}`);
    }
    const localTs = Date.now();
    return {
      symbol: this.normalizeSymbol(symbol),
      bid,
      ask,
      timestamp: localTs,
      serverTimestamp: null,
      restReason: options.reason ?? 'rest'
    };
  }

  /** 公开深度 REST；size 换算为 base 数量（contracts × quanto_multiplier） */
  async getOrderBook(symbol, limit = 20, options = {}) {
    const contract = this.toGateContract(symbol);
    const depthLimit = Math.min(Math.max(Number(limit) || 20, 5), 50);
    const timeout = Number(options.timeoutMs) || 5000;
    const { data } = await axios.get(`${this.config.restUrl}/futures/usdt/order_book`, {
      params: { contract, limit: depthLimit, with_id: false },
      timeout
    });
    const mult = this.#getContractMultiplier(contract);
    const parse = (rows) => (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const price = Number(Array.isArray(row) ? row[0] : row.p);
        const contracts = Number(Array.isArray(row) ? row[1] : row.s);
        return {
          price,
          size: contracts * mult
        };
      })
      .filter((x) => Number.isFinite(x.price) && x.price > 0 && Number.isFinite(x.size) && x.size > 0);
    return {
      bids: parse(data.bids).sort((a, b) => b.price - a.price),
      asks: parse(data.asks).sort((a, b) => a.price - b.price),
      timestamp: Date.now()
    };
  }

  async stopPrivateAccountStream() {
    this.privatePositionsSubscribed = false;
    this.privateBalancesSubscribed = false;
    if (this.unifiedWs) {
      this.unifiedWs.removeAllListeners();
      this.unifiedWs.close();
      this.unifiedWs = null;
    }
    this.unifiedWsConnected = false;
    this.#teardownAccountWebSocket();
    this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'gate' });
  }
}

export default GateAdapter;
