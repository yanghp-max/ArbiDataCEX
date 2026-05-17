/**
 * 事件总线（参考 ArbiData 结构）
 */
import { EventEmitter } from 'events';

export const EVENTS = {
  PRICE_UPDATE: 'priceUpdate',
  FUNDING_UPDATE: 'fundingUpdate'
};

export class EventBus extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = {
      maxListeners: 100,
      enableMetrics: true,
      ...options
    };
    this.setMaxListeners(this.options.maxListeners);
    this.metrics = {
      emitted: new Map(),
      startTime: Date.now()
    };
  }

  emit(eventName, ...args) {
    if (this.options.enableMetrics) {
      const count = this.metrics.emitted.get(eventName) || 0;
      this.metrics.emitted.set(eventName, count + 1);
    }
    return super.emit(eventName, ...args);
  }
}

let globalBus = null;
export function getEventBus(options = {}) {
  if (!globalBus) {
    globalBus = new EventBus(options);
  }
  return globalBus;
}

export default EventBus;
