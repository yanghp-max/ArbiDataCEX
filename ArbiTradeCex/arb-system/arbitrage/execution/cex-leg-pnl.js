import { DEFAULT_CEX_FEE_BPS_PER_LEG } from '../services/spread-calculator.js';

/**
 * 单腿 USDT 变动 — 对齐 ArbiTrade-1 calculateCexPnLFromReceipt
 * sell: +quoteVolume − fee
 * buy:  −(quoteVolume + fee)
 * 手续费已含在 usdtChange 内，汇总时不再二次扣除
 */
export function aggregateBinanceTrades(trades = []) {
  let quoteVolume = 0;
  let baseVolume = 0;
  let fee = 0;
  for (const row of trades) {
    const quote = Math.abs(Number(row.quoteQty ?? row.quoteVolume ?? 0));
    const base = Math.abs(Number(row.qty ?? row.baseVolume ?? 0));
    if (quote > 0) quoteVolume += quote;
    if (base > 0) baseVolume += base;
    const feeAsset = String(row.feeAsset ?? row.commissionAsset ?? 'USDT').toUpperCase();
    if (feeAsset === 'USDT') {
      fee += Math.abs(Number(row.fee ?? row.commission ?? 0));
    }
  }
  return { quoteVolume, baseVolume, fee, tradesCount: trades.length };
}

export function aggregateGateTrades(trades = [], quantoMultiplier = 1) {
  const mult = Number(quantoMultiplier);
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  let quoteVolume = 0;
  let baseVolume = 0;
  let fee = 0;
  for (const row of trades) {
    const quote = Math.abs(Number(row.quoteQty ?? row.quoteVolume ?? 0));
    if (quote > 0) {
      quoteVolume += quote;
    } else {
      const contracts = Math.abs(Number(row.contracts ?? row.size ?? 0));
      const price = Number(row.price ?? 0);
      if (contracts > 0 && price > 0) {
        const base = contracts * m;
        baseVolume += base;
        quoteVolume += base * price;
      }
    }
    const base = Math.abs(Number(row.baseQty ?? row.baseVolume ?? 0));
    if (base > 0) baseVolume += base;
    fee += Math.abs(Number(row.fee ?? 0)) + Math.abs(Number(row.pointFee ?? row.point_fee ?? 0));
  }
  return { quoteVolume, baseVolume, fee, tradesCount: trades.length };
}

export function calcCexLegUsdtChange({
  side,
  filledQty = 0,
  avgPrice = 0,
  cumQuote = 0,
  fee = null,
  feeBpsFallback = DEFAULT_CEX_FEE_BPS_PER_LEG,
  requireRealFee = false
} = {}) {
  const qty = Number(filledQty);
  const px = Number(avgPrice);
  const quote = Number(cumQuote) > 0 ? Number(cumQuote) : qty * px;

  if (!(qty > 0) || !Number.isFinite(quote) || quote <= 0) {
    return {
      usdtChange: 0,
      quoteVolume: 0,
      fee: 0,
      filled: false,
      feeEstimated: false,
      pnlComplete: false
    };
  }

  let feeAmount = fee != null && Number.isFinite(Number(fee)) ? Number(fee) : NaN;
  let feeEstimated = false;
  let pnlComplete = true;

  if (!Number.isFinite(feeAmount) || feeAmount < 0) {
    if (requireRealFee) {
      pnlComplete = false;
      feeAmount = 0;
    } else {
      const bps = Number(feeBpsFallback);
      feeAmount = quote * (Number.isFinite(bps) ? bps : DEFAULT_CEX_FEE_BPS_PER_LEG) / 10000;
      feeEstimated = true;
    }
  }

  const sideNorm = String(side || '').toLowerCase();
  const usdtChange = sideNorm === 'sell'
    ? quote - feeAmount
    : -(quote + feeAmount);

  return {
    usdtChange,
    quoteVolume: quote,
    fee: feeAmount,
    filled: true,
    feeEstimated,
    pnlComplete
  };
}

export function buildLegPnl({
  exchange,
  side,
  filledQty,
  order,
  trades = null,
  quantoMultiplier = 1,
  feeBpsFallback = DEFAULT_CEX_FEE_BPS_PER_LEG,
  requireRealFee = false
}) {
  let quote = Number(order?.cumQuote) > 0 ? Number(order.cumQuote) : 0;
  let fee = order?.fee != null && Number.isFinite(Number(order.fee)) ? Number(order.fee) : null;
  let feeFromTrades = false;

  if (Array.isArray(trades) && trades.length > 0) {
    const agg = exchange === 'gate'
      ? aggregateGateTrades(trades, quantoMultiplier)
      : aggregateBinanceTrades(trades);
    if (agg.quoteVolume > 0) quote = agg.quoteVolume;
    fee = agg.fee;
    feeFromTrades = true;
  }

  const leg = calcCexLegUsdtChange({
    side,
    filledQty,
    avgPrice: order?.avgPrice ?? order?.price ?? 0,
    cumQuote: quote,
    fee: feeFromTrades || fee != null ? fee : null,
    feeBpsFallback,
    requireRealFee
  });

  return {
    exchange,
    side,
    filledQty,
    feeFromTrades,
    ...leg
  };
}

/** netPnLUSDT = legA.usdtChange + legB.usdtChange；任一条腿 fee 未确认则返回 null */
export function calcTradePnlFromLegs(fill) {
  if (fill?.pnlComplete === false) return null;
  const a = fill?.aLeg;
  const b = fill?.bLeg;
  if (a?.filled && a.pnlComplete === false) return null;
  if (b?.filled && b.pnlComplete === false) return null;
  return (Number(a?.usdtChange) || 0) + (Number(b?.usdtChange) || 0);
}

export function isFillPnlComplete(fill) {
  if (!fill) return false;
  const legs = [fill.aLeg, fill.bLeg].filter((leg) => leg?.filled);
  if (legs.length === 0) return false;
  return legs.every((leg) => leg.pnlComplete !== false);
}

export function sumLegFees(fill) {
  return (Number(fill?.aLeg?.fee) || 0) + (Number(fill?.bLeg?.fee) || 0);
}

/** 展示用：价差毛利润（fee 已从 net 扣除，gross = net + fee） */
export function calcTradeGrossFromLegs(fill) {
  const net = calcTradePnlFromLegs(fill);
  if (net == null) return null;
  const fees = sumLegFees(fill);
  const aFilled = Number(fill?.aFilledQty) > 0;
  const bFilled = Number(fill?.bFilledQty) > 0;
  if (!aFilled && !bFilled) return null;
  if (aFilled && bFilled) return net + fees;
  return null;
}
