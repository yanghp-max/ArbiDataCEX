import { latencyCsvFields } from '../monitoring/trade-latency.js';
import {
  calcTradePnlFromLegs,
  calcTradeGrossFromLegs,
  sumLegFees
} from './cex-leg-pnl.js';

/**
 * PnL — 对齐 ArbiTrade-1 pnl-csv-manager：
 *   netPnL = legA.usdtChange + legB.usdtChange（仅真实成交 fee 确认后计入累计）
 * 手续费、滑点已体现在各腿 usdtChange（来自成交价 + 交易所成交回执）
 */

export function calcTradePnl(fill) {
  return calcTradePnlFromLegs(fill);
}

export function calcTradeGross(fill) {
  return calcTradeGrossFromLegs(fill);
}

export function calcTradeFeeCost(fill) {
  return sumLegFees(fill);
}

export class ResultReporter {
  constructor({ tradeCsvWriter = null } = {}) {
    this.tradeCsvWriter = tradeCsvWriter;
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

  recordTrade({
    symbol,
    direction,
    action = 'open',
    lockedDirection,
    fill,
    netPnl,
    accountCache,
    dashboardBridge,
    latencyTrace = null
  }) {
    const pnlComplete = fill?.pnlComplete !== false && netPnl != null && Number.isFinite(netPnl);
    if (pnlComplete) {
      this.cumPnl += netPnl;
      if (netPnl >= 0) this.winCount += 1;
      else this.lossCount += 1;
      this.bySymbol[symbol] = (this.bySymbol[symbol] ?? 0) + netPnl;
    }
    this.tradeCount += 1;

    const ts = Date.now();
    const quote = fill.quote ?? {};
    const grossPnl = calcTradeGross(fill);
    const feeCost = calcTradeFeeCost(fill);
    const aLeg = fill.aLeg ?? {};
    const bLeg = fill.bLeg ?? {};
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
      aUsdtChange: aLeg.usdtChange ?? null,
      bUsdtChange: bLeg.usdtChange ?? null,
      aFee: aLeg.fee ?? null,
      bFee: bLeg.fee ?? null,
      grossPnl,
      feeCost,
      netPnl,
      cumPnl: this.cumPnl,
      pnlComplete,
      simulated: Boolean(fill.simulated),
      legMismatch: Boolean(fill.legMismatch),
      legExposure: Boolean(fill.legExposure),
      failedLeg: fill.failedLeg ?? null,
      failReason: fill.failReason ?? null,
      aPosQty: accountCache.getPosition('binance', symbol),
      bPosQty: accountCache.getPosition('gate', symbol),
      latency: latencyCsvFields(latencyTrace)
    };
    this.trades.push(row);
    if (this.trades.length > 500) {
      this.trades.splice(0, this.trades.length - 500);
    }
    console.log('[TRADE]', JSON.stringify(row));
    if (pnlComplete) {
      console.log(
        `[PNL] total=${this.cumPnl.toFixed(4)} USDT · trades=${this.tradeCount} · latest=${netPnl.toFixed(4)} (${symbol})`
      );
    } else {
      console.warn(
        `[PNL] 跳过累计（fee 未确认）· trades=${this.tradeCount} · ${symbol} quote=${(aLeg.quoteVolume ?? 0).toFixed(4)}/${(bLeg.quoteVolume ?? 0).toFixed(4)}`
      );
    }
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
        a_usdt_change: row.aUsdtChange,
        b_usdt_change: row.bUsdtChange,
        a_fee: row.aFee,
        b_fee: row.bFee,
        gross_pnl: row.grossPnl,
        fee_cost: row.feeCost,
        net_pnl: row.netPnl,
        cum_pnl: row.cumPnl,
        pnl_complete: row.pnlComplete,
        a_pos_qty: row.aPosQty,
        b_pos_qty: row.bPosQty,
        leg_mismatch: row.legMismatch,
        leg_exposure: row.legExposure,
        failed_leg: row.failedLeg,
        fail_reason: row.failReason,
        ...(row.latency ?? {})
      }).catch((err) => {
        console.error('[ResultReporter] failed to write trade CSV:', err.message);
      });
    }
    return row;
  }
}
