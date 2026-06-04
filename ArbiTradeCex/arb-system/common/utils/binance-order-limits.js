/**
 * Binance USDT-M 永续下单数量约束：LOT_SIZE + MIN_NOTIONAL 取有效最小量。
 */

export function ceilByStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const ratio = value / step;
  const n = Math.abs(ratio - Math.round(ratio)) < 1e-9 ? Math.round(ratio) : Math.ceil(ratio - 1e-12);
  return n * step;
}

export function getBinanceLotFilter(symbolInfo) {
  return (symbolInfo.filters || []).find((f) => f.filterType === 'LOT_SIZE') || null;
}

export function getBinanceMinNotional(symbolInfo) {
  const f = (symbolInfo.filters || []).find((x) => x.filterType === 'MIN_NOTIONAL');
  if (!f) return null;
  const n = Number(f.notional ?? f.minNotional);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {object} symbolInfo - exchangeInfo.symbols[] 单项
 * @param {{ refPrice?: number | null }} [opts] - 用于换算 MIN_NOTIONAL；建议用 bid（价越低，所需数量越大）
 */
export function resolveBinanceOrderLimits(symbolInfo, opts = {}) {
  const lot = getBinanceLotFilter(symbolInfo);
  if (!lot) {
    throw new Error(`LOT_SIZE filter missing for ${symbolInfo?.symbol || 'unknown'}`);
  }

  const lotMinQty = Number(lot.minQty);
  const stepSize = Number(lot.stepSize);
  if (!Number.isFinite(lotMinQty) || !Number.isFinite(stepSize) || stepSize <= 0) {
    throw new Error(`invalid LOT_SIZE for ${symbolInfo?.symbol || 'unknown'}`);
  }

  const minNotional = getBinanceMinNotional(symbolInfo);
  const refPrice = Number(opts.refPrice);
  let minQty = lotMinQty;

  if (minNotional && Number.isFinite(refPrice) && refPrice > 0) {
    const fromNotional = ceilByStep(minNotional / refPrice, stepSize);
    minQty = Math.max(lotMinQty, fromNotional);
  }

  return { lotMinQty, minQty, stepSize, minNotional };
}

export default {
  ceilByStep,
  getBinanceLotFilter,
  getBinanceMinNotional,
  resolveBinanceOrderLimits
};
