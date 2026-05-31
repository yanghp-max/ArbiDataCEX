export function calcTradePnl(fill, direction, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const qty = fill.qty;
  const aPx = fill.aPriceUsed;
  const bPx = fill.bPriceUsed;
  let gross;
  let aLeg;
  let bLeg;
  if (direction === '-a+b') {
    gross = qty * aPx - qty * bPx;
    aLeg = qty * aPx;
    bLeg = qty * bPx;
  } else {
    gross = qty * bPx - qty * aPx;
    aLeg = qty * aPx;
    bLeg = qty * bPx;
  }
  const feeRate = (feeBpsTotal + slippageBpsTotal) / 10000;
  const perLeg = feeRate / 2;
  const feeCost = Math.abs(aLeg) * perLeg + Math.abs(bLeg) * perLeg;
  return gross - feeCost;
}

export class ResultReporter {
  constructor() {
    this.cumPnl = 0;
    this.tradeCount = 0;
    this.winCount = 0;
    this.lossCount = 0;
    this.bySymbol = {};
    this.trades = [];
  }

  getSummary() {
    return {
      totalPnl: this.cumPnl,
      tradeCount: this.tradeCount,
      winCount: this.winCount,
      lossCount: this.lossCount,
      bySymbol: { ...this.bySymbol }
    };
  }

  recordTrade({ symbol, direction, action = 'open', lockedDirection, fill, netPnl, accountCache, dashboardBridge }) {
    this.cumPnl += netPnl;
    this.tradeCount += 1;
    if (netPnl >= 0) this.winCount += 1;
    else this.lossCount += 1;
    this.bySymbol[symbol] = (this.bySymbol[symbol] ?? 0) + netPnl;

    const row = {
      symbol,
      timestamp: Date.now(),
      direction,
      action,
      lockedDirection: lockedDirection ?? direction,
      aPriceUsed: fill.aPriceUsed,
      bPriceUsed: fill.bPriceUsed,
      qty: fill.qty,
      aOrderId: fill.aOrderId,
      bOrderId: fill.bOrderId,
      netPnl,
      cumPnl: this.cumPnl,
      simulated: Boolean(fill.simulated),
      aPosQty: accountCache.getPosition('binance', symbol),
      bPosQty: accountCache.getPosition('gate', symbol)
    };
    this.trades.push(row);
    console.log('[TRADE]', JSON.stringify(row));
    console.log(
      `[PNL] total=${this.cumPnl.toFixed(4)} USDT · trades=${this.tradeCount} · latest=${netPnl.toFixed(4)} (${symbol})`
    );
    dashboardBridge?.recordTrade(row, this.getSummary());
    return row;
  }
}
