import { EventEmitter } from 'events';

export class BaseAdapter extends EventEmitter {
  constructor(config) {
    super();
    this.config = { timeout: 10000, ...config };
    this.connected = false;
  }

  normalizeSymbol(symbol) {
    if (symbol.includes('-')) return symbol.replace('-', '');
    return symbol;
  }

  toAdapterSymbol(symbol) {
    const s = this.normalizeSymbol(symbol);
    if (s.endsWith('USDT') && !s.includes('-')) {
      return `${s.slice(0, -4)}-USDT`;
    }
    return s;
  }

  toExchangeSymbol(symbol) {
    return this.normalizeSymbol(symbol);
  }

  toGateContract(symbol) {
    const s = this.normalizeSymbol(symbol);
    return `${s.slice(0, -4)}_USDT`;
  }
}

export default BaseAdapter;
