/**
 * CEX 适配器基类
 */
import { EventEmitter } from 'events';

export class BaseAdapter extends EventEmitter {
  constructor(config) {
    super();
    this.config = { timeout: 10000, ...config };
    this.connected = false;
  }

  normalizeSymbol(symbol) {
    if (symbol.includes('-')) return symbol;
    if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}-USDT`;
    return symbol;
  }

  toExchangeSymbol(symbol) {
    return symbol.replace('-', '');
  }
}

export default BaseAdapter;
