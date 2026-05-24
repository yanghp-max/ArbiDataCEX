/**
 * 预占管理（原子 try_reserve / release，对齐 SmartBalanceCache）
 */
import { Mutex } from 'async-mutex';

let seq = 0;

export class ReservationManager {
  constructor(options = {}) {
    this.reservations = new Map();
    this.positionReserved = new Map();
    this.ttlMs = options.ttlMs ?? 30000;
    this.mutex = new Mutex();
    this.accountCache = options.accountCache;
  }

  #sumReserved(exchange) {
    let sum = 0;
    for (const r of this.reservations.values()) {
      if (r.type === 'balance' && r.key === `${exchange}:USDT` && r.status === 'active') {
        sum += r.amount;
      }
    }
    return sum;
  }

  getAvailableUsdt(exchange) {
    const bal = this.accountCache.getBalance(exchange);
    if (!bal) return 0;
    return bal.total - this.#sumReserved(exchange);
  }

  getAvailablePositionCapacity(exchange, symbol, maxPositionQty) {
    const pos = Math.abs(this.accountCache.getPosition(exchange, symbol));
    const reserved = this.positionReserved.get(`${exchange}:${symbol}`) || 0;
    return Math.max(0, maxPositionQty - pos - reserved);
  }

  async tryReserve({ tradeId, symbol, direction, qty, aNeed, bNeed, maxPositionQty, increasesAbs }) {
    return this.mutex.runExclusive(() => {
      const minUsdt = this.accountCache.minAvailableUsdt ?? 50;

      if (this.getAvailableUsdt('binance') < Math.max(minUsdt, aNeed)) return null;
      if (this.getAvailableUsdt('gate') < Math.max(minUsdt, bNeed)) return null;

      const ids = { balA: null, balB: null, pos: [] };

      if (increasesAbs) {
        const capA = this.getAvailablePositionCapacity('binance', symbol, maxPositionQty);
        const capB = this.getAvailablePositionCapacity('gate', symbol, maxPositionQty);
        if (qty > capA || qty > capB) return null;
      }

      ids.balA = this.#addReservation('balance', 'binance:USDT', aNeed, tradeId);
      ids.balB = this.#addReservation('balance', 'gate:USDT', bNeed, tradeId);

      if (increasesAbs) {
        this.#addPositionReserved('binance', symbol, qty);
        this.#addPositionReserved('gate', symbol, qty);
        ids.pos = ['binance', 'gate'].map((ex) =>
          this.#addReservation('position', `${ex}:${symbol}`, qty, tradeId)
        );
      }

      return ids;
    });
  }

  #addReservation(type, key, amount, tradeId) {
    const id = `res_${++seq}_${Date.now()}`;
    this.reservations.set(id, {
      id, type, key, amount, tradeId, status: 'active', createdAt: Date.now()
    });
    return id;
  }

  #addPositionReserved(exchange, symbol, qty) {
    const k = `${exchange}:${symbol}`;
    this.positionReserved.set(k, (this.positionReserved.get(k) || 0) + qty);
  }

  async releaseAll(ids) {
    if (!ids) return;
    await this.mutex.runExclusive(() => {
      const all = [ids.balA, ids.balB, ...(ids.pos || [])].filter(Boolean);
      for (const id of all) {
        const r = this.reservations.get(id);
        if (!r || r.status !== 'active') continue;
        r.status = 'released';
        if (r.type === 'position') {
          const k = r.key;
          const cur = this.positionReserved.get(k) || 0;
          const next = cur - r.amount;
          if (next <= 1e-12) this.positionReserved.delete(k);
          else this.positionReserved.set(k, next);
        }
        this.reservations.delete(id);
      }
    });
  }

  purgeExpired() {
    const now = Date.now();
    for (const [id, r] of this.reservations) {
      if (now - r.createdAt > this.ttlMs) {
        this.releaseAll({ balA: id, balB: null, pos: [] }).catch(() => {});
      }
    }
  }
}

export default ReservationManager;
