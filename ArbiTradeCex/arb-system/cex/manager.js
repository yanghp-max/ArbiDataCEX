import { BinanceAdapter } from './adapters/binance-adapter.js';
import { GateAdapter } from './adapters/gate-adapter.js';
import { AsterAdapter } from './adapters/aster-adapter.js';
import { applyDefaultLeverage } from './leverage-bootstrap.js';

export { BinanceAdapter, GateAdapter, AsterAdapter };
export { BaseAdapter } from './adapters/base-adapter.js';

export class CexManager {
  constructor() {
    this.adapters = new Map();
  }

  register(name, adapter) {
    this.adapters.set(name, adapter);
  }

  get(name) {
    return this.adapters.get(name);
  }

  getAdapter(name) {
    return this.get(name);
  }

  #requireAdapter(exchange) {
    const adapter = this.get(exchange);
    if (!adapter) {
      throw new Error(`Exchange ${exchange} not found`);
    }
    return adapter;
  }

  async connect(exchange) {
    const adapter = this.#requireAdapter(exchange);
    await adapter.connect();
  }

  async disconnect(exchange) {
    const adapter = this.get(exchange);
    if (adapter) {
      await adapter.disconnect();
    }
  }

  async disconnectAll() {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.disconnect()));
  }

  async subscribe(exchange, symbols, channels) {
    const adapter = this.#requireAdapter(exchange);
    return adapter.subscribe(symbols, channels);
  }

  async unsubscribe(exchange, symbol, channels = []) {
    const adapter = this.#requireAdapter(exchange);
    return adapter.unsubscribe(symbol, channels);
  }

  async placeOrder(exchange, orderData) {
    return this.#requireAdapter(exchange).placeOrder(orderData);
  }

  async cancelOrder(exchange, orderId, symbol) {
    return this.#requireAdapter(exchange).cancelOrder(orderId, symbol);
  }

  async getOrderStatus(exchange, orderId, symbol) {
    return this.#requireAdapter(exchange).getOrderStatus(orderId, symbol);
  }

  async getOrderHistory(exchange, symbol, limit = 100) {
    return this.#requireAdapter(exchange).getOrderHistory(symbol, limit);
  }

  async getOrderCommission(exchange, orderId, symbol, options = {}) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getOrderCommission !== 'function') {
      return null;
    }
    return adapter.getOrderCommission(orderId, symbol, options);
  }

  async getOrderTrades(exchange, orderId, symbol, options = {}) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getOrderTrades !== 'function') {
      return [];
    }
    return adapter.getOrderTrades(orderId, symbol, options);
  }

  async getBalance(exchange, options = {}) {
    return this.#requireAdapter(exchange).getBalance(options);
  }

  async getPositions(exchange, options = {}) {
    return this.#requireAdapter(exchange).getPositions(options);
  }

  async getSymbols(exchange) {
    return this.#requireAdapter(exchange).getSymbols();
  }

  async checkOrder(exchange, orderData) {
    return this.#requireAdapter(exchange).checkOrder(orderData);
  }

  async checkOrderPreconditions(exchange, params) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.checkOrderPreconditions !== 'function') {
      throw new Error(`checkOrderPreconditions not supported on ${exchange}`);
    }
    return adapter.checkOrderPreconditions(params);
  }

  async getFundingRate(exchange, symbol) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getFundingRate !== 'function') {
      throw new Error(`getFundingRate not supported on ${exchange}`);
    }
    return adapter.getFundingRate(symbol);
  }

  async getOrderBook(exchange, symbol, limit = 20, options = {}) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getOrderBook !== 'function') {
      throw new Error(`getOrderBook not supported on ${exchange}`);
    }
    return adapter.getOrderBook(symbol, limit, options);
  }

  /** REST 最优买卖（发单前校正 WS 缓存，对齐 ArbiTrade-1 getTicker） */
  async getBookTicker(exchange, symbol, options = {}) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getBookTicker !== 'function') {
      throw new Error(`getBookTicker not supported on ${exchange}`);
    }
    return adapter.getBookTicker(symbol, options);
  }

  normalizeSymbol(exchange, symbol) {
    return this.#requireAdapter(exchange).normalizeSymbol(symbol);
  }

  async startPrivateAccountStreams(symbols = []) {
    const binance = this.get('binance');
    const gate = this.get('gate');
    const aster = this.get('aster');
    await Promise.all([
      binance?.startPrivateAccountStream?.(),
      gate?.startPrivateAccountStream?.(symbols),
      aster?.startPrivateAccountStream?.(symbols)
    ]);
  }

  async stopPrivateAccountStreams() {
    await Promise.all([
      this.get('binance')?.stopPrivateAccountStream?.(),
      this.get('gate')?.stopPrivateAccountStream?.(),
      this.get('aster')?.stopPrivateAccountStream?.()
    ]);
  }

  async applyDefaultLeverage(symbols, leverage) {
    return applyDefaultLeverage(this, symbols, leverage);
  }

  static async createDefault(strategyConfig = {}, options = {}) {
    const mgr = new CexManager();
    const enablePublicStream = options.enablePublicStream !== false;
    const enablePrivateAccountStream = options.enablePrivateAccountStream
      ?? (enablePublicStream === false);
    const configured = Array.isArray(options.providers)
      ? options.providers
      : ['binance', 'gate', 'aster'];
    const providers = [...new Set(
      configured
        .map((name) => String(name || '').trim().toLowerCase())
        .filter(Boolean)
    )];
    if (providers.length === 0) {
      throw new Error('No providers configured for CexManager');
    }

    const tasks = [];
    if (providers.includes('binance')) {
      const binance = new BinanceAdapter({
        listenKeyKeepaliveMin: strategyConfig.listenKeyKeepaliveMin ?? 30,
        enablePublicStream
      });
      tasks.push(binance.connect().then(() => mgr.register('binance', binance)));
    }
    if (providers.includes('gate')) {
      const gate = new GateAdapter({
        accountMode: strategyConfig.gateAccountMode,
        enablePublicStream,
        enablePrivateAccountStream
      });
      tasks.push(gate.connect().then(() => mgr.register('gate', gate)));
    }
    if (providers.includes('aster')) {
      const aster = new AsterAdapter({
        enablePublicStream
      });
      tasks.push(aster.connect().then(() => mgr.register('aster', aster)));
    }
    await Promise.all(tasks);
    return mgr;
  }
}

export default CexManager;
