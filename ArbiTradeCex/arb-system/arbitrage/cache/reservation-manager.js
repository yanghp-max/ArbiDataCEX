/**
 * 预占管理（原子 try_reserve / release，对齐 SmartBalanceCache）
 */
import { Mutex } from 'async-mutex';

let seq = 0;

export class ReservationManager {
  constructor(options = {}) {
    this.reservations = new Map();
    this.positionReserved = new Map();
    /** 同一 symbol 在途交易（对齐 ArbiTrade-1 SmartBalanceCache 预占互斥） */
    this.busySymbols = new Set();
    this.ttlMs = options.ttlMs ?? 30000;
    this.mutex = new Mutex();
    this.accountCache = options.accountCache;
    this.exchangeA = options.exchangeA || 'binance';
    this.exchangeB = options.exchangeB || 'gate';
    /** 执行中的 tradeId，purgeExpired 不得释放 */
    this.executingTradeIds = new Set();
  }

  setExchangePair(exchangeA, exchangeB) {
    this.exchangeA = String(exchangeA || this.exchangeA || 'binance');
    this.exchangeB = String(exchangeB || this.exchangeB || 'gate');
  }

  #compactSymbol(symbol) {
    return String(symbol).replace(/[-_]/g, '');
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
    const base = Number.isFinite(bal.available) ? bal.available : bal.total;
    return Math.max(0, base - this.#sumReserved(exchange));
  }

  getAvailablePositionCapacity(exchange, symbol, maxPositionQty) {
    const sym = this.#compactSymbol(symbol);
    const pos = Math.abs(this.accountCache.getPosition(exchange, sym));
    const reserved = this.positionReserved.get(`${exchange}:${sym}`) || 0;
    return Math.max(0, maxPositionQty - pos - reserved);
  }

  /** 预占失败原因（含超出量，供拦单日志） */
  describeReserveFail({ symbol, qty, aNeed, bNeed, maxPositionQty, increasesAbs }) {
    const sym = this.#compactSymbol(symbol);
    if (this.busySymbols.has(sym)) {
      return 'symbol 在途预占中（busySymbols）';
    }

    const minUsdt = this.accountCache.minAvailableUsdt ?? 50;
    const availA = this.getAvailableUsdt(this.exchangeA);
    const needA = Math.max(minUsdt, aNeed);
    if (availA < needA) {
      return `${this.exchangeA} USDT 不足 可用${availA.toFixed(2)} < 需要${needA.toFixed(2)} (差${(needA - availA).toFixed(2)})`;
    }

    const availB = this.getAvailableUsdt(this.exchangeB);
    const needB = Math.max(minUsdt, bNeed);
    if (availB < needB) {
      return `${this.exchangeB} USDT 不足 可用${availB.toFixed(2)} < 需要${needB.toFixed(2)} (差${(needB - availB).toFixed(2)})`;
    }

    if (increasesAbs) {
      const capA = this.getAvailablePositionCapacity(this.exchangeA, sym, maxPositionQty);
      const capB = this.getAvailablePositionCapacity(this.exchangeB, sym, maxPositionQty);
      if (qty > capA) {
        return `${this.exchangeA} 仓位上限 qty=${qty} > 可用容量${capA.toFixed(6)} (超出${(qty - capA).toFixed(6)}) maxPos=${maxPositionQty}`;
      }
      if (qty > capB) {
        return `${this.exchangeB} 仓位上限 qty=${qty} > 可用容量${capB.toFixed(6)} (超出${(qty - capB).toFixed(6)}) maxPos=${maxPositionQty}`;
      }
    }

    return '预占失败（未知原因）';
  }

  async tryReserve({ tradeId, symbol, direction, qty, aNeed, bNeed, maxPositionQty, increasesAbs }) {
    const sym = this.#compactSymbol(symbol);
    return this.mutex.runExclusive(() => {
      if (this.busySymbols.has(sym)) return null;

      const minUsdt = this.accountCache.minAvailableUsdt ?? 50;

      if (this.getAvailableUsdt(this.exchangeA) < Math.max(minUsdt, aNeed)) return null;
      if (this.getAvailableUsdt(this.exchangeB) < Math.max(minUsdt, bNeed)) return null;

      const ids = { balA: null, balB: null, pos: [] };

      if (increasesAbs) {
        const capA = this.getAvailablePositionCapacity(this.exchangeA, sym, maxPositionQty);
        const capB = this.getAvailablePositionCapacity(this.exchangeB, sym, maxPositionQty);
        if (qty > capA || qty > capB) return null;
      }

      this.busySymbols.add(sym);

      ids.balA = this.#addReservation('balance', `${this.exchangeA}:USDT`, aNeed, tradeId);
      ids.balB = this.#addReservation('balance', `${this.exchangeB}:USDT`, bNeed, tradeId);
      ids.symbol = sym;

      if (increasesAbs) {
        this.#addPositionReserved(this.exchangeA, sym, qty);
        this.#addPositionReserved(this.exchangeB, sym, qty);
        ids.pos = [this.exchangeA, this.exchangeB].map((ex) =>
          this.#addReservation('position', `${ex}:${sym}`, qty, tradeId)
        );
      }

      return { ...ids, tradeId };
    });
  }

  markExecuting(tradeId) {
    if (tradeId) this.executingTradeIds.add(tradeId);
  }

  markExecutionDone(tradeId) {
    if (tradeId) this.executingTradeIds.delete(tradeId);
  }

  #addReservation(type, key, amount, tradeId) {
    const id = `res_${++seq}_${Date.now()}`;
    this.reservations.set(id, {
      id, type, key, amount, tradeId, status: 'active', createdAt: Date.now()
    });
    return id;
  }

  #addPositionReserved(exchange, symbol, qty) {
    const k = `${exchange}:${this.#compactSymbol(symbol)}`;
    this.positionReserved.set(k, (this.positionReserved.get(k) || 0) + qty);
  }

  async releaseAll(ids) {
    if (!ids) return;
    await this.mutex.runExclusive(() => {
      if (ids.symbol) this.busySymbols.delete(ids.symbol);
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
    const expiredTradeIds = new Set();
    for (const r of this.reservations.values()) {
      if (r.status === 'active' && now - r.createdAt > this.ttlMs && r.tradeId) {
        expiredTradeIds.add(r.tradeId);
      }
    }
    for (const tradeId of expiredTradeIds) {
      if (this.executingTradeIds.has(tradeId)) continue;
      const ids = { balA: null, balB: null, pos: [], symbol: null };
      for (const [id, r] of this.reservations) {
        if (r.tradeId !== tradeId || r.status !== 'active') continue;
        if (r.type === 'balance' && r.key === `${this.exchangeA}:USDT`) ids.balA = id;
        if (r.type === 'balance' && r.key === `${this.exchangeB}:USDT`) ids.balB = id;
        if (r.type === 'position') {
          ids.pos.push(id);
          const parts = String(r.key).split(':');
          if (parts.length >= 2) ids.symbol = parts.slice(1).join(':');
        }
      }
      this.releaseAll(ids).catch(() => {});
    }
  }
}

export default ReservationManager;
