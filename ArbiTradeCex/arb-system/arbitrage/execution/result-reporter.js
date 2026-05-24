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
    this.trades = [];
  }

  recordTrade({ symbol, direction, fill, netPnl, accountCache, dashboardBridge }) {
    this.cumPnl += netPnl;
    const row = {
      symbol,
      timestamp: Date.now(),
      direction,
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
    dashboardBridge?.recordTrade(row);
    return row;
  }
}
