import { BinanceAdapter } from './adapters/binance-adapter.js';
import { GateAdapter } from './adapters/gate-adapter.js';

export { BinanceAdapter, GateAdapter };
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

  async getFundingRate(exchange, symbol) {
    const adapter = this.#requireAdapter(exchange);
    if (typeof adapter.getFundingRate !== 'function') {
      throw new Error(`getFundingRate not supported on ${exchange}`);
    }
    return adapter.getFundingRate(symbol);
  }

  normalizeSymbol(exchange, symbol) {
    return this.#requireAdapter(exchange).normalizeSymbol(symbol);
  }

  static async createDefault() {
    const mgr = new CexManager();
    const binance = new BinanceAdapter();
    const gate = new GateAdapter();
    await Promise.all([binance.connect(), gate.connect()]);
    mgr.register('binance', binance);
    mgr.register('gate', gate);
    return mgr;
  }
}

export default CexManager;
