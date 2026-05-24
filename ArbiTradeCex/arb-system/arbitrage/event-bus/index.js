/**
 * 简单事件总线
 */
import { EventEmitter } from 'events';

class EventBus extends EventEmitter {
  emitExecutionStatus(payload) {
    this.emit('execution.status', { ...payload, timestamp: Date.now() });
  }
}

export const eventBus = new EventBus();
export default eventBus;
