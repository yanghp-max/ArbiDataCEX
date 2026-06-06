import { DEFAULT_CEX_FEE_BPS_PER_LEG } from '../services/spread-calculator.js';

/**
 * 单腿 USDT 变动 — 对齐 ArbiTrade-1 calculateCexPnLFromReceipt
 * sell: +quoteVolume − fee
 * buy:  −(quoteVolume + fee)
 * 手续费已含在 usdtChange 内，汇总时不再二次扣除
 */
export function calcCexLegUsdtChange({
  side,
  filledQty = 0,
  avgPrice = 0,
  cumQuote = 0,
  fee = null,
  feeBpsFallback = DEFAULT_CEX_FEE_BPS_PER_LEG
} = {}) {
  const qty = Number(filledQty);
  const px = Number(avgPrice);
  const quote = Number(cumQuote) > 0 ? Number(cumQuote) : qty * px;

  if (!(qty > 0) || !Number.isFinite(quote) || quote <= 0) {
    return {
      usdtChange: 0,
      quoteVolume: 0,
      fee: 0,
      filled: false
    };
  }

  let feeAmount = Number(fee);
  if (!Number.isFinite(feeAmount) || feeAmount < 0) {
    const bps = Number(feeBpsFallback);
    feeAmount = quote * (Number.isFinite(bps) ? bps : DEFAULT_CEX_FEE_BPS_PER_LEG) / 10000;
  }

  const sideNorm = String(side || '').toLowerCase();
  const usdtChange = sideNorm === 'sell'
    ? quote - feeAmount
    : -(quote + feeAmount);

  return {
    usdtChange,
    quoteVolume: quote,
    fee: feeAmount,
    filled: true
  };
}

export function buildLegPnl({ exchange, side, filledQty, order, feeBpsFallback }) {
  const leg = calcCexLegUsdtChange({
    side,
    filledQty,
    avgPrice: order?.avgPrice ?? order?.price ?? 0,
    cumQuote: order?.cumQuote ?? 0,
    fee: order?.fee,
    feeBpsFallback
  });
  return {
    exchange,
    side,
    filledQty,
    ...leg
  };
}

/** netPnLUSDT = legA.usdtChange + legB.usdtChange */
export function calcTradePnlFromLegs(fill) {
  const a = Number(fill?.aLeg?.usdtChange) || 0;
  const b = Number(fill?.bLeg?.usdtChange) || 0;
  return a + b;
}

export function sumLegFees(fill) {
  return (Number(fill?.aLeg?.fee) || 0) + (Number(fill?.bLeg?.fee) || 0);
}

/** 展示用：价差毛利润（fee 已从 net 扣除，gross = net + fee） */
export function calcTradeGrossFromLegs(fill) {
  const net = calcTradePnlFromLegs(fill);
  const fees = sumLegFees(fill);
  const aFilled = Number(fill?.aFilledQty) > 0;
  const bFilled = Number(fill?.bFilledQty) > 0;
  if (!aFilled && !bFilled) return null;
  if (aFilled && bFilled) return net + fees;
  return null;
}
