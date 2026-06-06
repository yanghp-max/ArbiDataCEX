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

function fillLegPrices(fill) {
  return {
    aPx: fill.aFillPrice ?? fill.aPrice ?? fill.aPriceUsed,
    bPx: fill.bFillPrice ?? fill.bPrice ?? fill.bPriceUsed
  };
}

function filledLegNotional(fill) {
  const { aPx, bPx } = fillLegPrices(fill);
  const aQty = Number(fill.aFilledQty) > 0 ? Number(fill.aFilledQty) : 0;
  const bQty = Number(fill.bFilledQty) > 0 ? Number(fill.bFilledQty) : 0;
  return {
    aQty,
    bQty,
    aPx: Number(aPx),
    bPx: Number(bPx)
  };
}

/** 按实际成交价计算毛利润（两腿都成交时才有意义） */
export function calcTradeGross(fill, ctx) {
  const { aQty, bQty, aPx, bPx } = filledLegNotional(fill);
  if (!(aQty > 0 && bQty > 0) || !Number.isFinite(aPx) || !Number.isFinite(bPx)) {
    return null;
  }
  const { action, direction, lockedDirection } = ctx;
  if (action === 'close') {
    const locked = lockedDirection ?? direction;
    return locked === '-a+b'
      ? bQty * bPx - aQty * aPx
      : aQty * aPx - bQty * bPx;
  }
  return direction === '-a+b'
    ? aQty * aPx - bQty * bPx
    : bQty * bPx - aQty * aPx;
}

export function calcTradeFeeCost(fill, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const { aQty, bQty, aPx, bPx } = filledLegNotional(fill);
  const perLeg = (feeBpsTotal + slippageBpsTotal) / 10000 / 2;
  const aLeg = Number.isFinite(aPx) ? Math.abs(aQty * aPx) : 0;
  const bLeg = Number.isFinite(bPx) ? Math.abs(bQty * bPx) : 0;
  return aLeg * perLeg + bLeg * perLeg;
}

/** 开仓 / 加仓 PnL（同 backtest execute_open） */
export function calcOpenPnl(fill, direction, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const gross = calcTradeGross(fill, { action: 'open', direction, lockedDirection: direction });
  if (gross == null) {
    return -calcTradeFeeCost(fill, feeBpsTotal, slippageBpsTotal);
  }
  return gross - calcTradeFeeCost(fill, feeBpsTotal, slippageBpsTotal);
}

/** 平仓 PnL（同 backtest calc_close_profit，按 lockedDirection） */
export function calcClosePnl(fill, lockedDirection, feeBpsTotal = 4, slippageBpsTotal = 4) {
  const gross = calcTradeGross(fill, {
    action: 'close',
    direction: lockedDirection,
    lockedDirection
  });
  if (gross == null) {
    return -calcTradeFeeCost(fill, feeBpsTotal, slippageBpsTotal);
  }
  return gross - calcTradeFeeCost(fill, feeBpsTotal, slippageBpsTotal);
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

  recordTrade({
    symbol,
    direction,
    action = 'open',
    lockedDirection,
    fill,
    netPnl,
    feeBpsTotal = 4,
    slippageBpsTotal = 4,
    accountCache,
    dashboardBridge
  }) {
    this.cumPnl += netPnl;
    this.tradeCount += 1;
    if (netPnl >= 0) this.winCount += 1;
    else this.lossCount += 1;
    this.bySymbol[symbol] = (this.bySymbol[symbol] ?? 0) + netPnl;

    const ts = Date.now();
    const quote = fill.quote ?? {};
    const pnlCtx = {
      action,
      direction,
      lockedDirection: lockedDirection ?? direction
    };
    const grossPnl = calcTradeGross(fill, pnlCtx);
    const feeCost = calcTradeFeeCost(fill, feeBpsTotal, slippageBpsTotal);
    const row = {
      symbol,
      timestamp: ts,
      timestampMs: ts,
      timestampIso: new Date(ts).toISOString(),
      direction,
      action,
      lockedDirection: lockedDirection ?? direction,
      aBid: quote.aBid ?? null,
      aAsk: quote.aAsk ?? null,
      bBid: quote.bBid ?? null,
      bAsk: quote.bAsk ?? null,
      spreadAbPct: quote.spreadAbPct ?? null,
      spreadBaPct: quote.spreadBaPct ?? null,
      aSide: fill.aSide,
      aPriceNominal: quote.aPriceNominal ?? null,
      bPriceNominal: quote.bPriceNominal ?? null,
      aFillPrice: fill.aFilledQty > 0
        ? (fill.aFillPrice ?? fill.aPrice ?? fill.aPriceUsed ?? null)
        : null,
      bFillPrice: fill.bFilledQty > 0
        ? (fill.bFillPrice ?? fill.bPrice ?? fill.bPriceUsed ?? null)
        : null,
      aPrice: fill.aFilledQty > 0
        ? (fill.aFillPrice ?? fill.aPrice ?? fill.aPriceUsed ?? null)
        : null,
      bSide: fill.bSide,
      bPrice: fill.bFilledQty > 0
        ? (fill.bFillPrice ?? fill.bPrice ?? fill.bPriceUsed ?? null)
        : null,
      qty: fill.qty,
      aFilledQty: fill.aFilledQty,
      bFilledQty: fill.bFilledQty,
      aOrderId: fill.aOrderId,
      bOrderId: fill.bOrderId,
      grossPnl,
      feeCost,
      netPnl,
      cumPnl: this.cumPnl,
      simulated: Boolean(fill.simulated),
      legMismatch: Boolean(fill.legMismatch),
      legExposure: Boolean(fill.legExposure),
      failedLeg: fill.failedLeg ?? null,
      failReason: fill.failReason ?? null,
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
        a_bid: row.aBid,
        a_ask: row.aAsk,
        b_bid: row.bBid,
        b_ask: row.bAsk,
        spread_ab_pct: row.spreadAbPct,
        spread_ba_pct: row.spreadBaPct,
        a_side: row.aSide,
        a_price_nominal: row.aPriceNominal,
        b_side: row.bSide,
        b_price_nominal: row.bPriceNominal,
        a_fill_price: row.aFillPrice,
        b_fill_price: row.bFillPrice,
        qty: row.qty,
        a_filled_qty: row.aFilledQty,
        b_filled_qty: row.bFilledQty,
        a_order_id: row.aOrderId,
        b_order_id: row.bOrderId,
        gross_pnl: row.grossPnl,
        fee_cost: row.feeCost,
        net_pnl: row.netPnl,
        cum_pnl: row.cumPnl,
        a_pos_qty: row.aPosQty,
        b_pos_qty: row.bPosQty,
        leg_mismatch: row.legMismatch,
        leg_exposure: row.legExposure,
        failed_leg: row.failedLeg,
        fail_reason: row.failReason
      }).catch((err) => {
        console.error('[ResultReporter] failed to write trade CSV:', err.message);
      });
    }
    return row;
  }
}
