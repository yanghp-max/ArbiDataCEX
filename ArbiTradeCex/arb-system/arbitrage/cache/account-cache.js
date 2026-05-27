/**
 * 账户 WS 缓存（REST 初始化 + merge；私有 WS 可后续接入）
 */
export class AccountCache {
  constructor() {
    this.balanceCache = new Map();
    this.positionCache = new Map();
    this.reliable = false;
    this.mockMode = false;
  }

  seedMock({ balanceUsdt = 10000 } = {}) {
    const now = Date.now();
    for (const exchange of ['binance', 'gate']) {
      this.setBalance(exchange, { total: balanceUsdt, available: balanceUsdt, updatedAtMs: now });
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

  setPosition(exchange, symbol, qty) {
    const key = `${exchange}:${symbol}`;
    if (Math.abs(qty) < 1e-12) {
      this.positionCache.delete(key);
      return;
    }
    this.positionCache.set(key, { qty, updatedAtMs: Date.now() });
  }

  getBalance(exchange) {
    return this.balanceCache.get(`${exchange}:USDT`) || null;
  }

  getPosition(exchange, symbol) {
    return this.positionCache.get(`${exchange}:${symbol}`)?.qty ?? 0;
  }

  #compactSymbol(symbol) {
    return String(symbol).replace(/[-_]/g, '');
  }

  #applyBalance(exchange, balances) {
    const usdt = (balances || []).find((b) => b.currency === 'USDT');
    const available = Number(usdt?.available ?? 0);
    this.setBalance(exchange, {
      total: Number(usdt?.total ?? available),
      available,
      updatedAtMs: Date.now()
    });
  }

  async refreshFromCexManager(cexManager) {
    const [bBalances, gBalances, bPos, gPos] = await Promise.all([
      cexManager.getBalance('binance', { silent: true }),
      cexManager.getBalance('gate', { silent: true }),
      cexManager.getPositions('binance', { silent: true }),
      cexManager.getPositions('gate', { silent: true })
    ]);
    this.#applyBalance('binance', bBalances);
    this.#applyBalance('gate', gBalances);
    for (const p of bPos) {
      this.setPosition('binance', this.#compactSymbol(p.symbol), p.qty);
    }
    for (const p of gPos) {
      this.setPosition('gate', this.#compactSymbol(p.symbol), p.qty);
    }
    this.reliable = true;
  }
}

export default AccountCache;
