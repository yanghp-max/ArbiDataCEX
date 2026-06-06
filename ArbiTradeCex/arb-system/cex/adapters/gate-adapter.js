/**
 * Gate USDT 永续适配器
 * - single（默认）：单币种保证金，余额走 /futures/usdt/accounts + futures.balances WS
 * - unified：跨币种统一账户，余额走 /unified/accounts + unified.asset_detail WS
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
    this.accountMode = String(
      config.accountMode || process.env.GATE_ACCOUNT_MODE || 'single'
    ).toLowerCase();
    this.subscribed = [];
    this.subscribedChannels = ['book_ticker'];
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

  async connect() {
    if (this._shuttingDown) this._shuttingDown = false;
    await this.connectWebSocket();
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
    await this.stopPrivateAccountStream();
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
      timeout: 15000
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
        if (this.privatePositionsSubscribed || this.privateBalancesSubscribed || this.unifiedWsConnected) {
          await this.#subscribePositions(this.subscribed).catch((err) => {
            console.warn('[Gate] resubscribe positions failed:', err.message);
          });
          if (this.privateBalancesSubscribed) {
            await this.#subscribeBalances().catch((err) => {
              console.warn('[Gate] resubscribe balances failed:', err.message);
            });
          }
          if (this.privatePositionsSubscribed || this.privateBalancesSubscribed || this.unifiedWsConnected) {
            this.emit('PRIVATE_WS_CONNECTED', {
              exchange: 'gate',
              positionsReady: this.privatePositionsSubscribed
            });
          }
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
      if (msg.channel === 'futures.positions' && msg.event === 'update') {
        this.#handlePositionsUpdate(msg.result);
        return;
      }
      if (msg.channel === 'futures.balances' && msg.event === 'update') {
        this.#handleFuturesBalancesUpdate(msg.result);
        return;
      }
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

      const symbol = this.normalizeSymbol(this.toCompactSymbol(contract));
      this.emit(EventTypes.TICKER, {
        symbol,
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
      filled: this.#parseGateFilled(response),
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
      filled: this.#parseGateFilled(response),
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
      filled: this.#parseGateFilled(row),
      timestamp: Number(row.create_time || Date.now()) * 1000,
      avgPrice: Number(row.fill_price || 0)
    }));
  }

  /** 汇总订单成交手续费（USDT） */
  async getOrderCommission(orderId, symbol) {
    const contract = this.toGateContract(symbol);
    const rows = await this.#signedRequest('GET', '/futures/usdt/my_trades', {
      contract,
      order: orderId
    });
    let fee = 0;
    for (const row of rows || []) {
      fee += Math.abs(Number(row.fee || 0));
    }
    return fee;
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
      const baseQty = this.#contractsToBaseQty(contract, size);
      positions.push(new Position({
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
      }));
    }
    if (positions.length > 0) {
      this.emitPositionUpdate(positions);
    }
  }

  async #reconnectPrivateAccount() {
    const symbols = this.subscribed;
    await this.stopPrivateAccountStream();
    this.privatePositionsSubscribed = false;
    await this.startPrivateAccountStream(symbols);
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const userId = await this.#fetchUserId();
    const time = Math.floor(Date.now() / 1000);
    const channel = 'futures.balances';
    const event = 'subscribe';
    this.ws.send(JSON.stringify({
      time,
      channel,
      event,
      auth: this.#wsAuth(channel, event, time),
      payload: [userId]
    }));
    this.privateBalancesSubscribed = true;
  }

  async #subscribePositions(symbols) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const userId = await this.#fetchUserId();
    const contracts = (symbols || this.subscribed || []).map((s) => this.toGateContract(s));
    const time = Math.floor(Date.now() / 1000);
    const channel = 'futures.positions';
    const event = 'subscribe';
    this.ws.send(JSON.stringify({
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

    await this.syncAccountSnapshot({ silent: true });

    if (this.#isUnifiedMode()) {
      await this.#connectUnifiedWs();
    }

    if (this.ws?.readyState !== WebSocket.OPEN) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (!this.#isUnifiedMode()) {
        await this.#subscribeBalances();
      }
      await this.#subscribePositions(symbols);
    } else {
      console.warn('[Gate] public fx-ws not open; private futures subscriptions skipped');
    }

    this.emit('PRIVATE_WS_CONNECTED', {
      exchange: 'gate',
      positionsReady: this.privatePositionsSubscribed
    });
    const modeNote = this.#isUnifiedMode() ? 'unified USDT' : 'single USDT futures';
    const balNote = this.#isUnifiedMode()
      ? (this.unifiedWsConnected ? 'unified.asset_detail' : 'unified pending')
      : (this.privateBalancesSubscribed ? 'futures.balances' : 'balances pending');
    const posNote = this.privatePositionsSubscribed ? 'futures.positions' : 'positions pending';
    console.log(`[Gate] private streams (${modeNote}: ${balNote} + ${posNote})`);
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
    this.emit('PRIVATE_WS_DISCONNECTED', { exchange: 'gate' });
  }
}

export default GateAdapter;
