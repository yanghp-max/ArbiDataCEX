/**
 * 账户 U 快照：REST/缓存余额 + 持仓按盘口 mid 估算名义价值
 */
import { isFlatPosition } from './spread-calculator.js';

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
  const exchangeA = accountCache.exchangeA || 'binance';
  const exchangeB = accountCache.exchangeB || 'gate';

  if (forceRefresh && cexManager && !accountCache.mockMode) {
    await accountCache.refreshFromCexManager(cexManager, { fullReplace: false });
  }

  const balanceA = accountCache.getBalance(exchangeA);
  const balanceB = accountCache.getBalance(exchangeB);
  const walletA = resolveWalletUsdt(balanceA);
  const walletB = resolveWalletUsdt(balanceB);
  const equityA = walletA.equity;
  const equityB = walletB.equity;
  const availA = walletA.available;
  const availB = walletB.available;
  const marginUsedA = walletA.marginUsed;
  let marginUsedB = walletB.marginUsed;

  const positions = [];
  let positionNotionalUsdt = 0;
  let unrealizedPnlUsdt = 0;
  let initialMarginUsdt = 0;
  let maintMarginUsdt = 0;

  const posMapA = new Map();
  const posMapB = new Map();
  if (cexManager && !accountCache.mockMode) {
    const [rowsA, rowsB] = await Promise.all([
      cexManager.getPositions(exchangeA, { silent: true }).catch(() => []),
      cexManager.getPositions(exchangeB, { silent: true }).catch(() => [])
    ]);
    for (const p of rowsA || []) posMapA.set(compactSymbol(p.symbol), p);
    for (const p of rowsB || []) posMapB.set(compactSymbol(p.symbol), p);
  }

  for (const sym of symbols) {
    const key = compactSymbol(sym);
    const aPos = posMapA.get(key);
    const bPos = posMapB.get(key);

    if (aPos != null && Number.isFinite(Number(aPos.qty))) {
      accountCache.setPosition(exchangeA, key, Number(aPos.qty));
    }
    if (bPos != null && Number.isFinite(Number(bPos.qty))) {
      accountCache.setPosition(exchangeB, key, Number(bPos.qty));
    }

    if (
      forceRefresh
      && cexManager
      && !accountCache.mockMode
      && aPos == null
      && bPos == null
      && !isFlatPosition(
        accountCache.getPosition(exchangeA, key),
        accountCache.getPosition(exchangeB, key)
      )
    ) {
      await accountCache.reconcileSymbolPositions(cexManager, key);
    }

    const aQty = accountCache.getPosition(exchangeA, key);
    const bQty = accountCache.getPosition(exchangeB, key);

    if (Math.abs(aQty) < 1e-12 && Math.abs(bQty) < 1e-12) continue;
    const aUpnl = Number(aPos?.unrealizedPnl ?? 0);
    const bUpnl = Number(bPos?.unrealizedPnl ?? 0);
    const aInitMargin = Number(aPos?.initialMargin ?? 0);
    const bInitMargin = Number(bPos?.initialMargin ?? 0);
    const aMaintMargin = Number(aPos?.maintMargin ?? 0);
    const bMaintMargin = Number(bPos?.maintMargin ?? 0);
    unrealizedPnlUsdt += aUpnl + bUpnl;
    initialMarginUsdt += aInitMargin + bInitMargin;
    maintMarginUsdt += aMaintMargin + bMaintMargin;

    const tick = quoteAggregator.buildTick(key, { sourceA: exchangeA, sourceB: exchangeB });
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

  /** 部分交易所全仓账户 REST 常不填 position_margin，用持仓 initial_margin 补全展示 */
  if (marginUsedB <= 0) {
    const posMarginB = positions.reduce((s, p) => s + Number(p.bInitialMargin || 0), 0);
    if (posMarginB > 0) marginUsedB = posMarginB;
  }

  /** 两腿 USDT 钱包合计（PM/统一账户 total 通常已含未实现盈亏） */
  const totalUsdt = equityA + equityB;

  return {
    at: Date.now(),
    mock: Boolean(accountCache.mockMode),
    exchangeA,
    exchangeB,
    [exchangeA]: {
      equity: equityA,
      usdt: equityA,
      available: availA,
      marginUsed: marginUsedA,
      balanceAgeMs: accountCache.getBalanceAgeMs(exchangeA)
    },
    [exchangeB]: {
      equity: equityB,
      usdt: equityB,
      available: availB,
      marginUsed: marginUsedB,
      balanceAgeMs: accountCache.getBalanceAgeMs(exchangeB)
    },
    totalUsdt,
    totalAvailableUsdt: availA + availB,
    totalMarginUsedUsdt: marginUsedA + marginUsedB,
    positionNotionalUsdt,
    unrealizedPnlUsdt,
    initialMarginUsdt,
    maintMarginUsdt,
    positions,
    positionCount: positions.length
  };
}

export default { buildAccountSnapshot };
