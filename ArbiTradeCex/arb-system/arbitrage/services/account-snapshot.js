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

/** 权益 / 实际可用 / 占用保证金 */
function resolveWalletUsdt(bal) {
  if (!bal) return { equity: 0, available: 0, marginUsed: 0 };
  const equity = Number(bal.total ?? 0);
  const available = Number(bal.available ?? 0);
  const marginUsed = Number.isFinite(bal.marginUsed)
    ? Number(bal.marginUsed)
    : Math.max(0, equity - available);
  return {
    equity: Math.max(Number.isFinite(equity) ? equity : 0, Number.isFinite(available) ? available : 0),
    available: Number.isFinite(available) ? available : Math.max(0, equity - marginUsed),
    marginUsed: Math.max(0, marginUsed)
  };
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
  const binanceUsdt = binanceWallet.equity;
  const gateUsdt = gateWallet.equity;
  const binanceAvail = binanceWallet.available;
  const gateAvail = gateWallet.available;
  const binanceMarginUsed = binanceWallet.marginUsed;
  const gateMarginUsed = gateWallet.marginUsed;

  const positions = [];
  let positionNotionalUsdt = 0;
  let unrealizedPnlUsdt = 0;
  let initialMarginUsdt = 0;
  let maintMarginUsdt = 0;

  const binPosMap = new Map();
  const gatePosMap = new Map();
  if (cexManager && !accountCache.mockMode) {
    const [binRows, gateRows] = await Promise.all([
      cexManager.getPositions('binance', { silent: true }).catch(() => []),
      cexManager.getPositions('gate', { silent: true }).catch(() => [])
    ]);
    for (const p of binRows || []) binPosMap.set(compactSymbol(p.symbol), p);
    for (const p of gateRows || []) gatePosMap.set(compactSymbol(p.symbol), p);
  }

  for (const sym of symbols) {
    const key = compactSymbol(sym);
    const aQty = accountCache.getPosition('binance', key);
    const bQty = accountCache.getPosition('gate', key);
    if (Math.abs(aQty) < 1e-12 && Math.abs(bQty) < 1e-12) continue;

    const aPos = binPosMap.get(key);
    const bPos = gatePosMap.get(key);
    const aUpnl = Number(aPos?.unrealizedPnl ?? 0);
    const bUpnl = Number(bPos?.unrealizedPnl ?? 0);
    const aInitMargin = Number(aPos?.initialMargin ?? 0);
    const bInitMargin = Number(bPos?.initialMargin ?? 0);
    const aMaintMargin = Number(aPos?.maintMargin ?? 0);
    const bMaintMargin = Number(bPos?.maintMargin ?? 0);
    unrealizedPnlUsdt += aUpnl + bUpnl;
    initialMarginUsdt += aInitMargin + bInitMargin;
    maintMarginUsdt += aMaintMargin + bMaintMargin;

    const tick = quoteAggregator.buildTick(key);
    const midA = tick ? midPrice(tick.aBid, tick.aAsk) : (aPos?.markPrice ?? null);
    const midB = tick ? midPrice(tick.bBid, tick.bAsk) : (bPos?.markPrice ?? null);
    const aNotional = midA != null ? Math.abs(aQty) * midA : null;
    const bNotional = midB != null ? Math.abs(bQty) * midB : null;
    if (aNotional != null) positionNotionalUsdt += aNotional;
    if (bNotional != null) positionNotionalUsdt += bNotional;

    positions.push({
      symbol: key,
      aQty,
      bQty,
      hedgedBaseQty: Math.min(Math.abs(aQty), Math.abs(bQty)),
      midA,
      midB,
      aNotional,
      bNotional,
      netNotional: (aNotional ?? 0) + (bNotional ?? 0),
      aUnrealizedPnl: aUpnl,
      bUnrealizedPnl: bUpnl,
      aInitialMargin: aInitMargin,
      bInitialMargin: bInitMargin,
      aMaintMargin: aMaintMargin,
      bMaintMargin: bMaintMargin,
      aLeverage: aPos?.leverage ?? null,
      bLeverage: bPos?.leverage ?? null
    });
  }

  /** 两腿 USDT 钱包合计（PM/统一账户 total 通常已含未实现盈亏） */
  const totalUsdt = binanceUsdt + gateUsdt;

  return {
    at: Date.now(),
    mock: Boolean(accountCache.mockMode),
    binance: {
      equity: binanceUsdt,
      usdt: binanceUsdt,
      available: binanceAvail,
      marginUsed: binanceMarginUsed,
      balanceAgeMs: accountCache.getBalanceAgeMs('binance')
    },
    gate: {
      equity: gateUsdt,
      usdt: gateUsdt,
      available: gateAvail,
      marginUsed: gateMarginUsed,
      balanceAgeMs: accountCache.getBalanceAgeMs('gate')
    },
    totalUsdt,
    totalAvailableUsdt: binanceAvail + gateAvail,
    totalMarginUsedUsdt: binanceMarginUsed + gateMarginUsed,
    positionNotionalUsdt,
    unrealizedPnlUsdt,
    initialMarginUsdt,
    maintMarginUsdt,
    positions,
    positionCount: positions.length
  };
}

export default { buildAccountSnapshot };
