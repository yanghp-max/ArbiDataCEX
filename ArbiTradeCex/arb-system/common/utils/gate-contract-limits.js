/**
 * Gate 合约最小量/步进解析。
 * enable_decimal 时 order_size_min / order_size_round 均为「张数」；基础币 = 张数 × quanto_multiplier。
 */
import { ceilByStep } from './binance-order-limits.js';

function parsePositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Gate API order_size_min（张数，需 X-Gate-Size-Decimal: 1） */
export function parseGateDecimalOrderSizeMin(gateInfo) {
  if (!gateInfo || gateInfo.enable_decimal !== true) return null;
  return parsePositiveNumber(gateInfo.order_size_min);
}

/** Gate API order_size_round（张数步进） */
export function parseGateDecimalOrderSizeRound(gateInfo) {
  if (!gateInfo || gateInfo.enable_decimal !== true) return null;
  return parsePositiveNumber(gateInfo.order_size_round);
}

/** 张数最小量 → 基础币最小量 */
export function gateContractMinToBaseQty(contractMin, quantoMultiplier) {
  const contracts = Number(contractMin);
  const mult = Number(quantoMultiplier);
  if (!(contracts > 0) || !(mult > 0)) return 0;
  return contracts * mult;
}

/** 解析 Gate decimal 合约的张数步进（缺省用 order_size_min，再缺省 1） */
export function resolveGateContractStep(gateCfgOrInfo) {
  const round = parsePositiveNumber(gateCfgOrInfo?.gateOrderSizeRound ?? gateCfgOrInfo?.order_size_round);
  if (round != null) return round;
  const min = parsePositiveNumber(gateCfgOrInfo?.gateOrderSizeMin ?? gateCfgOrInfo?.order_size_min);
  if (min != null) return min;
  return 1;
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
  const gateDecimalMinContracts = parseGateDecimalOrderSizeMin(gateInfo);
  const gateDecimalRoundContracts = parseGateDecimalOrderSizeRound(gateInfo);

  if (enableDecimal) {
    if (!Number.isFinite(binanceMinQty) || binanceMinQty <= 0) {
      throw new Error(`invalid Binance minQty for decimal Gate contract ${name}`);
    }
    if (!Number.isFinite(binanceStepSize) || binanceStepSize <= 0) {
      throw new Error(`invalid Binance stepSize for decimal Gate contract ${name}`);
    }

    const mult = Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
      ? gateQuantoMultiplier
      : 1;
    const contractStep = gateDecimalRoundContracts ?? gateDecimalMinContracts ?? 1;
    const baseStep = contractStep * mult;

    let gateMinBase = 0;
    if (gateDecimalMinContracts != null) {
      gateMinBase = gateContractMinToBaseQty(gateDecimalMinContracts, mult);
      gateMinBase = ceilByStep(gateMinBase, baseStep);
    }

    const minBaseQty = Math.max(binanceMinQty, gateMinBase || 0);
    const minQty = ceilByStep(minBaseQty, binanceStepSize);

    return {
      minQty,
      stepSize: baseStep,
      quantityUnit: 'contract',
      enableDecimal: true,
      quantoMultiplier: mult,
      minBaseQty: minQty,
      gateOrderSizeMin: gateDecimalMinContracts,
      gateOrderSizeRound: gateDecimalRoundContracts
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
    gateOrderSizeMin: null,
    gateOrderSizeRound: gateOrderSizeRound > 0 ? gateOrderSizeRound : null
  };
}

export default {
  resolveGateOrderLimits,
  parseGateDecimalOrderSizeMin,
  parseGateDecimalOrderSizeRound,
  gateContractMinToBaseQty,
  resolveGateContractStep
};
