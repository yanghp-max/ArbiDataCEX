/**
 * Gate 合约最小量/步进解析。
 * enable_decimal 合约需带 X-Gate-Size-Decimal 拉取的 order_size_min（币本位）。
 */
import { ceilByStep } from './binance-order-limits.js';

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Gate API order_size_min（币本位，需 X-Gate-Size-Decimal: 1） */
export function parseGateDecimalOrderSizeMin(gateInfo) {
  if (!gateInfo || gateInfo.enable_decimal !== true) return null;
  return parsePositiveNumber(gateInfo.order_size_min);
}

/**
 * Gate 合约最小量/步进解析。
 */
export function resolveGateOrderLimits(gateInfo, { binanceMinQty, binanceStepSize, gateSymbol }) {
  if (!gateInfo) {
    throw new Error(`Gate contract not found: ${gateSymbol}`);
  }

  const name = gateSymbol || gateInfo.name || gateInfo.contract || 'unknown';
  const gateQuantoMultiplier = Number(gateInfo.quanto_multiplier || 0);
  const enableDecimal = gateInfo.enable_decimal === true;
  const gateMinContracts = Number(gateInfo.order_size_min);
  const gateOrderSizeRound = Number(gateInfo.order_size_round || 0);
  const gateDecimalMinBase = parseGateDecimalOrderSizeMin(gateInfo);

  if (enableDecimal) {
    if (!Number.isFinite(binanceMinQty) || binanceMinQty <= 0) {
      throw new Error(`invalid Binance minQty for decimal Gate contract ${name}`);
    }
    if (!Number.isFinite(binanceStepSize) || binanceStepSize <= 0) {
      throw new Error(`invalid Binance stepSize for decimal Gate contract ${name}`);
    }

    const gateStep = gateOrderSizeRound > 0 ? gateOrderSizeRound : binanceStepSize;
    let minBaseQty = binanceMinQty;
    if (gateDecimalMinBase != null) {
      minBaseQty = Math.max(minBaseQty, ceilByStep(gateDecimalMinBase, gateStep));
    }

    return {
      minQty: minBaseQty,
      stepSize: gateStep,
      quantityUnit: 'base',
      enableDecimal: true,
      quantoMultiplier: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
        ? gateQuantoMultiplier
        : null,
      minBaseQty,
      gateOrderSizeMin: gateDecimalMinBase
    };
  }

  if (!Number.isFinite(gateMinContracts) || gateMinContracts <= 0) {
    throw new Error(`invalid Gate order_size_min for ${name}`);
  }

  return {
    minQty: gateMinContracts,
    stepSize: gateOrderSizeRound > 0 ? gateOrderSizeRound : 1,
    quantityUnit: 'contract',
    enableDecimal: false,
    quantoMultiplier: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
      ? gateQuantoMultiplier
      : null,
    minBaseQty: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
      ? gateMinContracts * gateQuantoMultiplier
      : null,
    gateOrderSizeMin: null
  };
}

export default { resolveGateOrderLimits, parseGateDecimalOrderSizeMin };
