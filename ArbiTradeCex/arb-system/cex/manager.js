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
