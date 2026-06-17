import { latencyCsvFields } from '../monitoring/trade-latency.js';
import {
  calcTradePnlFromLegs,
  calcTradeGrossFromLegs,
  sumLegFees
} from './cex-leg-pnl.js';

/**
 * PnL — 对齐 ArbiTrade-1 pnl-csv-manager：
 *   netPnLUSDT = legA.usdtChange + legB.usdtChange
 *
 * 单腿 usdtChange（成交额 ± 手续费，来自成交回执）：
 *   sell: +quoteVolume − fee
 *   buy:  −(quoteVolume + fee)
 *
 * 展示列：
 *   gross_pnl = net_pnl + fee_cost（两腿 fee 之和）
 *   a_usdt_change / b_usdt_change = 各腿 usdtChange（非价差毛利；旧版 CSV 曾把 gross/fee 误标在此两列）
 */

const PNL_EPS = 1e-4;

export function calcTradePnl(fill) {
  return calcTradePnlFromLegs(fill);
}

export function assertLegPnlConsistency(fill, netPnl = null) {
  const a = Number(fill?.aLeg?.usdtChange) || 0;
  const b = Number(fill?.bLeg?.usdtChange) || 0;
  const legSum = a + b;
  const legNet = calcTradePnlFromLegs(fill);
  const issues = [];
  if (legNet != null && Math.abs(legSum - legNet) > PNL_EPS) {
    issues.push(`a+b=${legSum.toFixed(6)} vs legNet=${legNet.toFixed(6)}`);
  }
  if (
    netPnl != null
    && Number.isFinite(netPnl)
    && legNet != null
    && Math.abs(netPnl - legNet) > PNL_EPS
  ) {
    issues.push(`passed net=${netPnl.toFixed(6)} vs legNet=${legNet.toFixed(6)}`);
  }
  const gross = calcTradeGrossFromLegs(fill);
  const fees = calcTradeFeeCost(fill);
  if (
    gross != null
    && legNet != null
    && fees != null
    && Math.abs(gross - fees - legNet) > PNL_EPS
  ) {
    issues.push(`gross-fee=${(gross - fees).toFixed(6)} vs net=${legNet.toFixed(6)}`);
  }
  return { ok: issues.length === 0, legSum, legNet, issues };
}

export function calcTradeGross(fill) {
  return calcTradeGrossFromLegs(fill);
}

export function calcTradeFeeCost(fill) {
  return sumLegFees(fill);
}

export class ResultReporter {
  constructor({ tradeCsvWriter = null, providerA = 'binance', providerB = 'gate' } = {}) {
    this.tradeCsvWriter = tradeCsvWriter;
    this.providerA = providerA;
    this.providerB = providerB;
    this.cumPnl = 0;
    this.tradeCount = 0;
    this.winCount = 0;
    this.lossCount = 0;
    this.pendingPnlCount = 0;
    this.bySymbol = {};
    this.trades = [];
  }

  getSummary() {
    return {
      totalPnl: this.cumPnl,
      tradeCount: this.tradeCount,
      winCount: this.winCount,
      lossCount: this.lossCount,
      pendingCount: this.pendingPnlCount,
      confirmedCount: this.winCount + this.lossCount,
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
    const aLeg = fill.aLeg ?? {};
    const bLeg = fill.bLeg ?? {};
    const legNet = calcTradePnlFromLegs(fill);
    const pnlComplete = fill?.pnlComplete !== false && legNet != null && Number.isFinite(legNet);
    const resolvedNetPnl = pnlComplete ? legNet : null;

    if (pnlComplete) {
      const check = assertLegPnlConsistency(fill, netPnl);
      if (!check.ok) {
        console.warn(`[PNL] 两腿与净盈亏不一致 (${symbol}): ${check.issues.join('; ')}`);
      }
      this.cumPnl += resolvedNetPnl;
      if (resolvedNetPnl >= 0) this.winCount += 1;
      else this.lossCount += 1;
      this.bySymbol[symbol] = (this.bySymbol[symbol] ?? 0) + resolvedNetPnl;
    }
    this.tradeCount += 1;
    if (!pnlComplete) this.pendingPnlCount += 1;

    const ts = Date.now();
    const quote = fill.quote ?? {};
    const grossPnl = calcTradeGross(fill);
    const feeCost = calcTradeFeeCost(fill);
    const priceStages = latencyTrace?.priceStages ?? null;
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
      acceptAPrice: priceStages?.signal?.aPrice ?? null,
      acceptBPrice: priceStages?.signal?.bPrice ?? null,
      sendAPrice: priceStages?.send?.aPrice ?? null,
      sendBPrice: priceStages?.send?.bPrice ?? null,
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
      netPnl: resolvedNetPnl,
      cumPnl: this.cumPnl,
      pnlComplete,
      simulated: Boolean(fill.simulated),
      legMismatch: Boolean(fill.legMismatch),
      legExposure: Boolean(fill.legExposure),
      failedLeg: fill.failedLeg ?? null,
      failReason: fill.failReason ?? null,
      aPosQty: accountCache.getPosition(this.providerA, symbol),
      bPosQty: accountCache.getPosition(this.providerB, symbol),
      latency: latencyCsvFields(latencyTrace)
    };
    this.trades.push(row);
    if (this.trades.length > 500) {
      this.trades.splice(0, this.trades.length - 500);
    }
    console.log('[TRADE]', JSON.stringify(row));
    if (pnlComplete) {
      console.log(
        `[PNL] total=${this.cumPnl.toFixed(4)} USDT · trades=${this.tradeCount} · latest=${resolvedNetPnl.toFixed(4)} (${symbol})`
        + ` · legA${aLeg.usdtChange >= 0 ? '+' : ''}${Number(aLeg.usdtChange).toFixed(4)}`
        + ` legB${bLeg.usdtChange >= 0 ? '+' : ''}${Number(bLeg.usdtChange).toFixed(4)}`
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
        accept_a_price: row.acceptAPrice,
        accept_b_price: row.acceptBPrice,
        send_a_price: row.sendAPrice,
        send_b_price: row.sendBPrice,
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
