/**
 * 账户 WS 缓存（REST 初始化 + 私有 WS 增量 merge）
 */
export class AccountCache {
  constructor() {
    this.balanceCache = new Map();
    this.positionCache = new Map();
    /** 策略监控币种（compact），用于 merge 刷新时清掉 REST 已平仓的残留 */
    this.trackedSymbols = [];
    this.reliable = false;
    this.mockMode = false;
    this.accountCacheMaxAgeMs = 5000;
    this._lastRestRefreshMs = { binance: 0, gate: 0 };
    this.restRefreshMinIntervalMs = 2000;
    this.absentPositionGraceMs = 8000;
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
      marginUsed: data.marginUsed ?? data.frozen ?? 0,
      updatedAtMs: data.updatedAtMs || Date.now()
    });
  }

  mergeBalance(exchange, { currency = 'USDT', total, available, marginUsed, frozen } = {}) {
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
      marginUsed: marginUsed ?? frozen ?? 0,
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

  getPositionEntry(exchange, symbol) {
    return this.positionCache.get(`${exchange}:${this.#compactSymbol(symbol)}`) || null;
  }

  setTrackedSymbols(symbols = []) {
    this.trackedSymbols = [...new Set(
      (symbols || []).map((s) => this.#compactSymbol(s))
    )];
  }

  /**
   * 按 symbol 用 REST 对账两腿持仓。
   * REST 不返回 qty=0 的合约；两腿皆缺席时强制清 0（不受 grace 影响）。
   * 仅一侧缺席时：若本地条目在 graceMs 内刚被 WS/applyLegDelta 更新则暂保留（Gate 写入延迟）。
   */
  async reconcileSymbolPositions(cexManager, symbol, { graceMs } = {}) {
    const sym = this.#compactSymbol(symbol);
    const now = Date.now();
    const grace = graceMs ?? this.absentPositionGraceMs ?? 8000;

    const fetchLeg = async (exchange) => {
      const rows = await cexManager.getPositions(exchange, { silent: true });
      return (rows || []).find((p) => this.#compactSymbol(p.symbol) === sym) ?? null;
    };

    let binRow;
    let gateRow;
    try {
      [binRow, gateRow] = await Promise.all([
        fetchLeg('binance'),
        fetchLeg('gate')
      ]);
    } catch (err) {
      console.warn(`[AccountCache] reconcile ${sym} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }

    if (binRow == null && gateRow == null) {
      this.setPosition('binance', sym, 0);
      this.setPosition('gate', sym, 0);
      return { ok: true, bothAbsent: true };
    }

    const applyLeg = (exchange, row) => {
      if (row != null) {
        this.setPosition(exchange, sym, Number(row.qty));
        return;
      }
      const cached = this.getPositionEntry(exchange, sym);
      if (cached && now - cached.updatedAtMs < grace) return;
      this.setPosition(exchange, sym, 0);
    };

    applyLeg('binance', binRow);
    applyLeg('gate', gateRow);
    return { ok: true };
  }

  /** merge 刷新后：监控币种未出现在 REST 列表且条目已过期 → 清 0 */
  #clearAbsentTrackedPositions(exchange, positions, { graceMs } = {}) {
    const tracked = this.trackedSymbols;
    if (!tracked?.length) return 0;
    const grace = graceMs ?? this.absentPositionGraceMs ?? 8000;
    const now = Date.now();
    const returned = new Set(
      (positions || []).map((p) => this.#compactSymbol(p.symbol))
    );
    let cleared = 0;
    for (const sym of tracked) {
      if (returned.has(sym)) continue;
      const cached = this.getPositionEntry(exchange, sym);
      if (!cached) continue;
      if (now - cached.updatedAtMs < grace) continue;
      this.setPosition(exchange, sym, 0);
      cleared += 1;
    }
    return cleared;
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
      marginUsed: Number(usdt.marginUsed ?? usdt.frozen ?? Math.max(0, total - available)),
      updatedAtMs: Date.now()
    });
  }

  /**
   * @param {boolean} [options.fullReplace] - true：清空该所全部持仓再写入（仅启动/手动全量刷新）
   *   false（默认）：仅 merge REST 返回的条目，避免成交后 Gate 延迟未出现在列表时把缓存清成 0
   */
  async refreshExchange(cexManager, exchange, { force = false, fullReplace = false } = {}) {
    const now = Date.now();
    const minGap = this.restRefreshMinIntervalMs ?? 2000;
    if (!force && now - (this._lastRestRefreshMs[exchange] || 0) < minGap) {
      return { ok: true, skipped: true };
    }
    this._lastRestRefreshMs[exchange] = now;

    let balances;
    let positions;
    try {
      [balances, positions] = await Promise.all([
        cexManager.getBalance(exchange, { silent: true }),
        cexManager.getPositions(exchange, { silent: true })
      ]);
    } catch (err) {
      console.warn(`[AccountCache] ${exchange} REST 刷新失败，保留旧持仓: ${err.message}`);
      return { ok: false, error: err.message };
    }

    if (!Array.isArray(positions)) {
      console.warn(`[AccountCache] ${exchange} positions 非数组，保留旧持仓`);
      return { ok: false, error: 'invalid_positions' };
    }

    this.#applyBalance(exchange, balances);

    const prefix = `${exchange}:`;
    let merged = 0;

    if (fullReplace) {
      for (const key of [...this.positionCache.keys()]) {
        if (key.startsWith(prefix)) this.positionCache.delete(key);
      }
    }

    for (const p of positions) {
      const sym = this.#compactSymbol(p.symbol);
      const qty = Number(p.qty);
      if (!Number.isFinite(qty)) continue;
      this.setPosition(exchange, sym, qty);
      if (Math.abs(qty) >= 1e-12) merged += 1;
    }

    if (!fullReplace) {
      this.#clearAbsentTrackedPositions(exchange, positions);
    }

    return { ok: true, count: merged, fullReplace };
  }

  async refreshFromCexManager(cexManager, { fullReplace = false } = {}) {
    await Promise.all([
      this.refreshExchange(cexManager, 'binance', { force: true, fullReplace }),
      this.refreshExchange(cexManager, 'gate', { force: true, fullReplace })
    ]);
    this.markRestSnapshotReliable();
  }

  /** 成交后 Gate 持仓写入常有延迟，带重试刷新（merge 模式，不清空未返回的 symbol） */
  async refreshFromCexManagerWithRetry(cexManager, { retries = 3, delayMs = 350 } = {}) {
    for (let i = 0; i < retries; i += 1) {
      await this.refreshFromCexManager(cexManager, { fullReplace: false });
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
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
