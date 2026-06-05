/**
 * 账户 U 快照：REST/缓存余额 + 持仓按盘口 mid 估算名义价值
 */
function compactSymbol(symbol) {
  return String(symbol).replace(/[-_]/g, '');
}

function midPrice(bid, ask) {
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

/** Gate 单币种等场景可能 total=0 但 available>0；不能用 ?? 否则 0 不会回退 */
function resolveWalletUsdt(bal) {
  if (!bal) return { usdt: 0, available: 0 };
  const available = Number(bal.available ?? 0);
  const total = Number(bal.total ?? 0);
  const usdt = Math.max(
    Number.isFinite(total) ? total : 0,
    Number.isFinite(available) ? available : 0
  );
  return { usdt, available };
}

/**
 * @param {object} deps
 * @param {import('../cache/account-cache.js').AccountCache} deps.accountCache
 * @param {import('../../cex/manager.js').CexManager|null} deps.cexManager
 * @param {import('./quote-aggregator.js').QuoteAggregator} deps.quoteAggregator
 * @param {string[]} deps.symbols
 * @param {boolean} deps.forceRefresh
 */
export async function buildAccountSnapshot(deps) {
  const {
    accountCache,
    cexManager,
    quoteAggregator,
    symbols = [],
    forceRefresh = true
  } = deps;

  if (forceRefresh && cexManager && !accountCache.mockMode) {
    await accountCache.refreshFromCexManager(cexManager);
  }

  const binanceBal = accountCache.getBalance('binance');
  const gateBal = accountCache.getBalance('gate');
  const binanceWallet = resolveWalletUsdt(binanceBal);
  const gateWallet = resolveWalletUsdt(gateBal);
  const binanceUsdt = binanceWallet.usdt;
  const gateUsdt = gateWallet.usdt;
  const binanceAvail = binanceWallet.available;
  const gateAvail = gateWallet.available;

  const positions = [];
  let positionNotionalUsdt = 0;

  for (const sym of symbols) {
    const key = compactSymbol(sym);
    const aQty = accountCache.getPosition('binance', key);
    const bQty = accountCache.getPosition('gate', key);
    if (Math.abs(aQty) < 1e-12 && Math.abs(bQty) < 1e-12) continue;

    const tick = quoteAggregator.buildTick(key);
    const midA = tick ? midPrice(tick.aBid, tick.aAsk) : null;
    const midB = tick ? midPrice(tick.bBid, tick.bAsk) : null;
    const aNotional = midA != null ? aQty * midA : null;
    const bNotional = midB != null ? bQty * midB : null;
    if (aNotional != null) positionNotionalUsdt += aNotional;
    if (bNotional != null) positionNotionalUsdt += bNotional;

    positions.push({
      symbol: key,
      aQty,
      bQty,
      midA,
      midB,
      aNotional,
      bNotional,
      netNotional: (aNotional ?? 0) + (bNotional ?? 0)
    });
  }

  /** 两腿 USDT 钱包合计（PM/统一账户 total 通常已含未实现盈亏） */
  const totalUsdt = binanceUsdt + gateUsdt;

  return {
    at: Date.now(),
    mock: Boolean(accountCache.mockMode),
    binance: {
      usdt: binanceUsdt,
      available: binanceAvail,
      balanceAgeMs: accountCache.getBalanceAgeMs('binance')
    },
    gate: {
      usdt: gateUsdt,
      available: gateAvail,
      balanceAgeMs: accountCache.getBalanceAgeMs('gate')
    },
    totalUsdt,
    positionNotionalUsdt,
    positions,
    positionCount: positions.length
  };
}

export default { buildAccountSnapshot };
