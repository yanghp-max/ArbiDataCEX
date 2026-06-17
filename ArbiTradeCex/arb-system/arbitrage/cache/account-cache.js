/**
 * 账户 WS 缓存（REST 初始化 + 私有 WS 增量 merge）
 */
import { isFlatPosition, isHedgedPosition } from '../services/spread-calculator.js';

export class AccountCache {
  constructor() {
    this.balanceCache = new Map();
    this.positionCache = new Map();
    /** 策略监控币种（compact），用于 merge 刷新时清掉 REST 已平仓的残留 */
    this.trackedSymbols = [];
    /** 成交后保护：防止全所 merge 刷新把 Gate 延迟腿清成 0 */
    this._fillSyncProtect = new Map();
    this.fillSyncProtectMs = 90000;
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
    this.exchangePair = { a: 'binance', b: 'gate' };
  }

  setExchangePair(exchangeA, exchangeB) {
    this.exchangePair = {
      a: String(exchangeA || 'binance'),
      b: String(exchangeB || 'gate')
    };
    for (const ex of [this.exchangePair.a, this.exchangePair.b]) {
      if (!this.wsStatus[ex]) {
        this.wsStatus[ex] = { connected: false, reliable: false };
      }
      if (this._lastRestRefreshMs[ex] == null) {
        this._lastRestRefreshMs[ex] = 0;
      }
    }
  }

  get exchangeA() {
    return this.exchangePair.a;
  }

  get exchangeB() {
    return this.exchangePair.b;
  }

  seedMock({ balanceUsdt = 10000 } = {}) {
    const now = Date.now();
    for (const exchange of [this.exchangeA, this.exchangeB]) {
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

  #markFillSync(symbol) {
    const sym = this.#compactSymbol(symbol);
    const aQty = this.getPosition(this.exchangeA, sym);
    const bQty = this.getPosition(this.exchangeB, sym);
    this._fillSyncProtect.set(sym, {
      until: Date.now() + (this.fillSyncProtectMs ?? 90000),
      aQty,
      bQty
    });
  }

  #clearFillSync(symbol) {
    this._fillSyncProtect.delete(this.#compactSymbol(symbol));
  }

  #fillSyncActive(sym, now = Date.now()) {
    const p = this._fillSyncProtect.get(sym);
    return p && now < p.until ? p : null;
  }

  #shouldKeepAbsentLeg(exchange, sym, now, grace) {
    const protect = this.#fillSyncActive(sym, now);
    if (protect) {
      const expected = exchange === this.exchangeA ? protect.aQty : protect.bQty;
      const cached = this.getPosition(exchange, sym);
      if (Math.abs(expected) > 1e-12 && Math.abs(cached - expected) <= 1e-6) {
        return true;
      }
    }
    const cached = this.getPositionEntry(exchange, sym);
    if (cached && now - cached.updatedAtMs < grace) return true;
    return false;
  }

  /**
   * 成交回执优先写缓存（同步），再按需 REST 确认；不依赖全所 merge 刷新。
   * open/add 单腿敞口不入账（由回滚/REST 对账纠正），避免对冲仓位被错误累加。
   */
  applyFillToCache(symbol, direction, fill, { action } = {}) {
    const sym = this.#compactSymbol(symbol);
    if (fill?.simulated) {
      this.applyLegDelta(sym, direction, fill.qty);
      this.#markFillSync(sym);
      return;
    }

    const isOpenAdd = action === 'open' || action === 'add';
    if (isOpenAdd && (fill?.legExposure || fill?.rollbackApplied)) {
      return;
    }

    const aFill = Number(fill?.aFilledQty) || 0;
    const bFill = Number(fill?.bFilledQty) || 0;
    if (!fill?.legExposure && aFill > 0 && bFill > 0) {
      this.applyLegDelta(sym, direction, Math.min(aFill, bFill));
    } else if (aFill > 0 || bFill > 0) {
      let aQty = this.getPosition(this.exchangeA, sym);
      let bQty = this.getPosition(this.exchangeB, sym);
      if (aFill > 0) {
        if (fill.aSide === 'sell') aQty -= aFill;
        else aQty += aFill;
      }
      if (bFill > 0) {
        if (fill.bSide === 'sell') bQty -= bFill;
        else bQty += bFill;
      }
      this.setPosition(this.exchangeA, sym, aQty);
      this.setPosition(this.exchangeB, sym, bQty);
    }

    this.#markFillSync(sym);
    const aQty = this.getPosition(this.exchangeA, sym);
    const bQty = this.getPosition(this.exchangeB, sym);
    if (isFlatPosition(aQty, bQty)) {
      this.#clearFillSync(sym);
    }
  }

  /**
   * 成交后仅对当前 symbol REST 确认（带重试），不触发全所 refresh。
   */
  async syncSymbolPositionsAfterFill(cexManager, symbol, { retries = 6, delayMs = 500 } = {}) {
    const sym = this.#compactSymbol(symbol);
    const grace = Math.max(this.absentPositionGraceMs ?? 8000, this.fillSyncProtectMs ?? 90000);
    let last = { ok: false };

    for (let i = 0; i < retries; i += 1) {
      last = await this.reconcileSymbolPositions(cexManager, sym, { graceMs: grace });
      const aQty = this.getPosition(this.exchangeA, sym);
      const bQty = this.getPosition(this.exchangeB, sym);
      if (isFlatPosition(aQty, bQty)) {
        this.#clearFillSync(sym);
        return { ...last, ok: true, flat: true };
      }
      if (isHedgedPosition(aQty, bQty)) {
        this.#markFillSync(sym);
        return { ...last, ok: true, hedged: true };
      }
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    const aQty = this.getPosition(this.exchangeA, sym);
    const bQty = this.getPosition(this.exchangeB, sym);
    if (isFlatPosition(aQty, bQty)) this.#clearFillSync(sym);
    return { ...last, ok: last.ok !== false, timeout: true };
  }

  /**
   * 按 symbol 用 REST 对账两腿持仓。
   * REST 不返回 qty=0 的合约；成交保护期内不因 REST 缺席清腿。
   */
  async reconcileSymbolPositions(cexManager, symbol, { graceMs } = {}) {
    const sym = this.#compactSymbol(symbol);
    const now = Date.now();
    const grace = graceMs ?? this.absentPositionGraceMs ?? 8000;

    const fetchLeg = async (exchange) => {
      const rows = await cexManager.getPositions(exchange, { silent: true });
      return (rows || []).find((p) => this.#compactSymbol(p.symbol) === sym) ?? null;
    };

    let aRow;
    let bRow;
    try {
      [aRow, bRow] = await Promise.all([
        fetchLeg(this.exchangeA),
        fetchLeg(this.exchangeB)
      ]);
    } catch (err) {
      console.warn(`[AccountCache] reconcile ${sym} failed: ${err.message}`);
      return { ok: false, error: err.message };
    }

    if (aRow == null && bRow == null) {
      const protect = this.#fillSyncActive(sym, now);
      if (protect && !isFlatPosition(protect.aQty, protect.bQty)) {
        return { ok: true, bothAbsent: false, deferred: true };
      }
      this.setPosition(this.exchangeA, sym, 0);
      this.setPosition(this.exchangeB, sym, 0);
      this.#clearFillSync(sym);
      return { ok: true, bothAbsent: true };
    }

    const applyLeg = (exchange, row) => {
      if (row != null) {
        this.setPosition(exchange, sym, Number(row.qty));
        return;
      }
      if (this.#shouldKeepAbsentLeg(exchange, sym, now, grace)) return;
      this.setPosition(exchange, sym, 0);
    };

    applyLeg(this.exchangeA, aRow);
    applyLeg(this.exchangeB, bRow);

    const aQty = this.getPosition(this.exchangeA, sym);
    const bQty = this.getPosition(this.exchangeB, sym);
    if (isFlatPosition(aQty, bQty)) this.#clearFillSync(sym);
    else if (isHedgedPosition(aQty, bQty)) this.#markFillSync(sym);

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
      if (this.#fillSyncActive(sym, now)) continue;
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
    this.reliable = [this.exchangeA, this.exchangeB].every((ex) => this.wsStatus[ex]?.reliable);
  }

  /**
   * 按套利腿方向更新本地持仓（dry 模拟成交）
   */
  applyLegDelta(symbol, direction, qty) {
    const sym = this.#compactSymbol(symbol);
    const q = Number(qty);
    if (!Number.isFinite(q) || q <= 0) return;

    let aQty = this.getPosition(this.exchangeA, sym);
    let bQty = this.getPosition(this.exchangeB, sym);
    if (direction === '-a+b') {
      aQty -= q;
      bQty += q;
    } else {
      aQty += q;
      bQty -= q;
    }
    this.setPosition(this.exchangeA, sym, aQty);
    this.setPosition(this.exchangeB, sym, bQty);
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
      this.refreshExchange(cexManager, this.exchangeA, { force: true, fullReplace }),
      this.refreshExchange(cexManager, this.exchangeB, { force: true, fullReplace })
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
    for (const exchange of [this.exchangeA, this.exchangeB]) {
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
    for (const exchange of [this.exchangeA, this.exchangeB]) {
      if (!this.isReliable(exchange) || this.isStale(exchange, maxAge)) {
        const force = !this.isReliable(exchange);
        tasks.push(this.refreshExchange(cexManager, exchange, { force }));
      }
    }
    if (tasks.length > 0) await Promise.all(tasks);
  }
}

export default AccountCache;
