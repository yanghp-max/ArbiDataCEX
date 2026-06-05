/**
 * PnL 计算 — 与 backtest_cex_cex_open_only.py 完全一致
 *
 * 开仓 / 加仓（direction = 执行方向）：
 *   -a+b: gross = qty × (a − b)
 *   +a-b: gross = qty × (b − a)
 *
 * 平仓（lockedDirection = 原持仓方向，执行方向相反）：
 *   locked -a+b: gross = qty × (b − a)   // 与开仓 -a+b 符号相反
 *   locked +a-b: gross = qty × (a − b)   // 与开仓 +a-b 符号相反
 *
 * 手续费（两腿分别按成交额）：
 *   fee_rate_per_leg = (fee_bps_total + slippage_bps_total) / 2 / 10000
 *   fee_cost = |a_leg| × fee_rate_per_leg + |b_leg| × fee_rate_per_leg
 *
 * 累计 PnL：cumPnl = Σ 每笔 netPnl（开/加/平全部累加）
 */

function feeCost(qty, aPx, bPx, feeBpsTotal, slippageBpsTotal) {
  const perLeg = (feeBpsTotal + slippageBpsTotal) / 10000 / 2;
  const aLeg = qty * aPx;
  const bLeg = qty * bPx;
  return Math.abs(aLeg) * perLeg + Math.abs(bLeg) * perLeg;
}

/** 开仓 / 加仓 PnL（同 backtest execute_open） */
function fillLegPrices(fill) {
  return {
    aPx: fill.aPrice ?? fill.aPriceUsed,
    bPx: fill.bPrice ?? fill.bPriceUsed
  };
}

export function calcOpenPnl(fill, direction, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const qty = fill.qty;
  const { aPx, bPx } = fillLegPrices(fill);
  const gross = direction === '-a+b'
    ? qty * aPx - qty * bPx
    : qty * bPx - qty * aPx;
  return gross - feeCost(qty, aPx, bPx, feeBpsTotal, slippageBpsTotal);
}

/** 平仓 PnL（同 backtest calc_close_profit，按 lockedDirection） */
export function calcClosePnl(fill, lockedDirection, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const qty = fill.qty;
  const { aPx, bPx } = fillLegPrices(fill);
  const gross = lockedDirection === '-a+b'
    ? qty * bPx - qty * aPx
    : qty * aPx - qty * bPx;
  return gross - feeCost(qty, aPx, bPx, feeBpsTotal, slippageBpsTotal);
}

/**
 * @param {object} fill
 * @param {object} ctx
 * @param {string} ctx.action - 'open' | 'add' | 'close'
 * @param {string} ctx.direction - 本笔执行方向（execDirection）
 * @param {string} [ctx.lockedDirection] - 平仓时原持仓方向
 */
export function calcTradePnl(fill, ctx, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const { action, direction, lockedDirection } = ctx;
  if (action === 'close') {
    if (!lockedDirection) {
      throw new Error('calcTradePnl close requires lockedDirection');
    }
    return calcClosePnl(fill, lockedDirection, feeBpsTotal, slippageBpsTotal);
  }
  return calcOpenPnl(fill, direction, feeBpsTotal, slippageBpsTotal);
}

export class ResultReporter {
  constructor({ tradeCsvWriter = null } = {}) {
    this.cumPnl = 0;
    this.tradeCount = 0;
    this.winCount = 0;
    this.lossCount = 0;
    this.bySymbol = {};
    this.trades = [];
    this.tradeCsvWriter = tradeCsvWriter;
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

    const ts = Date.now();
    const row = {
      symbol,
      timestamp: ts,
      timestampMs: ts,
      timestampIso: new Date(ts).toISOString(),
      direction,
      action,
      lockedDirection: lockedDirection ?? direction,
      aSide: fill.aSide,
      aPrice: fill.aPrice ?? fill.aPriceUsed,
      bSide: fill.bSide,
      bPrice: fill.bPrice ?? fill.bPriceUsed,
      qty: fill.qty,
      aFilledQty: fill.aFilledQty,
      bFilledQty: fill.bFilledQty,
      aOrderId: fill.aOrderId,
      bOrderId: fill.bOrderId,
      netPnl,
      cumPnl: this.cumPnl,
      simulated: Boolean(fill.simulated),
      legMismatch: Boolean(fill.legMismatch),
      aPosQty: accountCache.getPosition('binance', symbol),
      bPosQty: accountCache.getPosition('gate', symbol)
    };
    this.trades.push(row);
    if (this.trades.length > 500) {
      this.trades.splice(0, this.trades.length - 500);
    }
    console.log('[TRADE]', JSON.stringify(row));
    console.log(
      `[PNL] total=${this.cumPnl.toFixed(4)} USDT · trades=${this.tradeCount} · latest=${netPnl.toFixed(4)} (${symbol})`
    );
    dashboardBridge?.recordTrade(row, this.getSummary());
    if (this.tradeCsvWriter && !row.simulated) {
      this.tradeCsvWriter.appendRow({
        timestamp_ms: row.timestampMs,
        timestamp_iso: row.timestampIso,
        symbol: row.symbol,
        action: row.action,
        direction: row.direction,
        locked_direction: row.lockedDirection,
        a_side: row.aSide,
        a_price: row.aPrice,
        b_side: row.bSide,
        b_price: row.bPrice,
        qty: row.qty,
        a_filled_qty: row.aFilledQty,
        b_filled_qty: row.bFilledQty,
        a_order_id: row.aOrderId,
        b_order_id: row.bOrderId,
        net_pnl: row.netPnl,
        cum_pnl: row.cumPnl,
        a_pos_qty: row.aPosQty,
        b_pos_qty: row.bPosQty,
        leg_mismatch: row.legMismatch
      }).catch((err) => {
        console.error('[ResultReporter] failed to write trade CSV:', err.message);
      });
    }
    return row;
  }
}
