/**
 * 账户 WS 缓存（REST 初始化 + 私有 WS 增量 merge）
 */
export class AccountCache {
  constructor() {
    this.balanceCache = new Map();
    this.positionCache = new Map();
    this.reliable = false;
    this.mockMode = false;
    this.accountCacheMaxAgeMs = 5000;
    this._lastRestRefreshMs = { binance: 0, gate: 0 };
    this.restRefreshMinIntervalMs = 2000;
    this.wsStatus = {
      binance: { connected: false, reliable: false },
      gate: { connected: false, reliable: false }
    };
  }

  seedMock({ balanceUsdt = 10000 } = {}) {
    const now = Date.now();
    for (const exchange of ['binance', 'gate']) {
      this.setBalance(exchange, { total: balanceUsdt, available: balanceUsdt, updatedAtMs: now });
      this.wsStatus[exchange] = { connected: true, reliable: true };
    }
    this.positionCache.clear();
    this.reliable = true;
    this.mockMode = true;
  }

  setBalance(exchange, data) {
    this.balanceCache.set(`${exchange}:USDT`, {
      total: data.total,
      available: data.available ?? data.total,
      updatedAtMs: data.updatedAtMs || Date.now()
    });
  }

  mergeBalance(exchange, { currency = 'USDT', total, available } = {}) {
    const cur = String(currency).toUpperCase();
    if (cur !== 'USDT') return;
    const totalN = Number(total);
    const availN = Number(available ?? total);
    if (!Number.isFinite(totalN) && !Number.isFinite(availN)) return;
    if (totalN <= 1e-12 && availN <= 1e-12) {
      this.balanceCache.delete(`${exchange}:USDT`);
      return;
    }
    this.setBalance(exchange, {
      total: Number.isFinite(totalN) ? totalN : availN,
      available: Number.isFinite(availN) ? availN : totalN,
      updatedAtMs: Date.now()
    });
  }

  setPosition(exchange, symbol, qty) {
    const key = `${exchange}:${this.#compactSymbol(symbol)}`;
    if (Math.abs(qty) < 1e-12) {
      this.positionCache.delete(key);
      return;
    }
    this.positionCache.set(key, { qty, updatedAtMs: Date.now() });
  }

  mergePosition(exchange, symbol, qty) {
    this.setPosition(exchange, symbol, Number(qty));
  }

  getBalance(exchange) {
    return this.balanceCache.get(`${exchange}:USDT`) || null;
  }

  getPosition(exchange, symbol) {
    return this.positionCache.get(`${exchange}:${this.#compactSymbol(symbol)}`)?.qty ?? 0;
  }

  getBalanceAgeMs(exchange) {
    const bal = this.getBalance(exchange);
    if (!bal?.updatedAtMs) return Infinity;
    return Date.now() - bal.updatedAtMs;
  }

  isStale(exchange, maxAgeMs = this.accountCacheMaxAgeMs) {
    return this.getBalanceAgeMs(exchange) > maxAgeMs;
  }

  isReliable(exchange) {
    return Boolean(this.wsStatus[exchange]?.reliable);
  }

  isPrivateWsConnected(exchange) {
    return Boolean(this.wsStatus[exchange]?.connected);
  }

  setWsStatus(exchange, { connected, reliable }) {
    const prev = this.wsStatus[exchange] || { connected: false, reliable: false };
    this.wsStatus[exchange] = {
      connected: connected ?? prev.connected,
      reliable: reliable ?? prev.reliable
    };
    this.reliable = ['binance', 'gate'].every((ex) => this.wsStatus[ex].reliable);
  }

  /**
   * 按套利腿方向更新本地持仓（dry 模拟成交）
   */
  applyLegDelta(symbol, direction, qty) {
    const sym = this.#compactSymbol(symbol);
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return;

    let aQty = this.getPosition('binance', sym);
    let bQty = this.getPosition('gate', sym);
    if (direction === '-a+b') {
      aQty -= q;
      bQty += q;
    } else {
      aQty += q;
      bQty -= q;
    }
    this.setPosition('binance', sym, aQty);
    this.setPosition('gate', sym, bQty);
  }

  #compactSymbol(symbol) {
    return String(symbol).replace(/[-_]/g, '');
  }

  #applyBalance(exchange, balances) {
    const usdt = (balances || []).find((b) => b.currency === 'USDT');
    if (!usdt) return;
    const available = Number(usdt.available ?? 0);
    const total = Number(usdt.total ?? available);
    if (total <= 1e-12 && available <= 1e-12) {
      this.balanceCache.delete(`${exchange}:USDT`);
      return;
    }
    this.setBalance(exchange, {
      total,
      available,
      updatedAtMs: Date.now()
    });
  }

  async refreshExchange(cexManager, exchange, { force = false } = {}) {
    const now = Date.now();
    const minGap = this.restRefreshMinIntervalMs ?? 2000;
    if (!force && now - (this._lastRestRefreshMs[exchange] || 0) < minGap) {
      return;
    }
    this._lastRestRefreshMs[exchange] = now;

    const [balances, positions] = await Promise.all([
      cexManager.getBalance(exchange, { silent: true }),
      cexManager.getPositions(exchange, { silent: true })
    ]);
    this.#applyBalance(exchange, balances);
    const prefix = `${exchange}:`;
    for (const key of [...this.positionCache.keys()]) {
      if (key.startsWith(prefix)) this.positionCache.delete(key);
    }
    for (const p of positions) {
      this.setPosition(exchange, this.#compactSymbol(p.symbol), p.qty);
    }
  }

  async refreshFromCexManager(cexManager) {
    await Promise.all([
      this.refreshExchange(cexManager, 'binance', { force: true }),
      this.refreshExchange(cexManager, 'gate', { force: true })
    ]);
    this.markRestSnapshotReliable();
  }

  /** 启动时 REST 全量同步后标记可用，避免私有 WS 连上前每笔信号都打 REST */
  markRestSnapshotReliable() {
    for (const exchange of ['binance', 'gate']) {
      this.setWsStatus(exchange, { connected: false, reliable: true });
    }
    this.reliable = true;
  }

  /**
   * 发单前：缓存过期或私有 WS 不可靠时 REST 补全
   */
  async ensureFresh(cexManager) {
    if (this.mockMode) return;
    const maxAge = this.accountCacheMaxAgeMs ?? 5000;
    const tasks = [];
    for (const exchange of ['binance', 'gate']) {
      if (!this.isReliable(exchange) || this.isStale(exchange, maxAge)) {
        const force = !this.isReliable(exchange);
        tasks.push(this.refreshExchange(cexManager, exchange, { force }));
      }
    }
    if (tasks.length > 0) await Promise.all(tasks);
  }
}

export default AccountCache;
