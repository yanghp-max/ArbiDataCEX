/**
 * 滑点 bps：相对发单时名义价（卖@bid / 买@ask，与 legPricesForDirection 一致）
 * 展示与计算均按名义价小数位对齐，避免 Binance 成交价多几位小数时出现假滑点（如 +0.09 bps）
 */

function decimalPlacesFromPrice(price) {
  const s = String(price);
  const i = s.indexOf('.');
  if (i === -1) return 0;
  return s.length - i - 1;
}

function roundPrice(price, decimals) {
  if (!Number.isFinite(Number(price))) return NaN;
  if (decimals <= 0) return Math.round(Number(price));
  const f = 10 ** decimals;
  return Math.round(Number(price) * f) / f;
}

/** @returns {number|null} 正 bps = 对该 side 不利 */
export function calcLegSlippageBps({ side, nominal, fill, alignDecimals = null } = {}) {
  const ref = Number(nominal);
  const px = Number(fill);
  if (!Number.isFinite(ref) || ref === 0 || !Number.isFinite(px)) return null;

  const dp = Number.isFinite(alignDecimals)
    ? alignDecimals
    : Math.max(decimalPlacesFromPrice(ref), 6);

  const refR = roundPrice(ref, dp);
  const fillR = roundPrice(px, dp);
  if (refR === fillR) return 0;

  const raw = ((fillR - refR) / refR) * 10000;
  const sideNorm = String(side || '').toLowerCase();
  return sideNorm === 'sell' ? -raw : raw;
}

export function formatSlippageBps(bps) {
  if (bps == null || !Number.isFinite(bps)) return null;
  if (Math.abs(bps) < 0.005) return '0.00 bps';
  const sign = bps > 0 ? '+' : '';
  return `${sign}${bps.toFixed(2)} bps`;
}

export function nominalPriceForLeg({ side, bid, ask, priceNominal }) {
  if (priceNominal != null && Number.isFinite(Number(priceNominal))) {
    return Number(priceNominal);
  }
  const sideNorm = String(side || '').toLowerCase();
  if (sideNorm === 'sell' && bid != null && Number.isFinite(Number(bid))) return Number(bid);
  if (sideNorm === 'buy' && ask != null && Number.isFinite(Number(ask))) return Number(ask);
  return null;
}

export function formatPriceForDisplay(price, refPrice = price) {
  const dp = Math.max(decimalPlacesFromPrice(refPrice), 6);
  const rounded = roundPrice(price, dp);
  if (!Number.isFinite(rounded)) return '—';
  return rounded.toFixed(dp);
}
