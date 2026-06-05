import { ceilByStep } from './binance-order-limits.js';
import { floorByStep } from './precision.js';

/** Gate 最小基础币数量（张数合约：minQty 张 × multiplier） */
export function resolveGateMinBaseQty(gateCfg) {
  if (!gateCfg) return 0;
  const minBase = Number(gateCfg.minBaseQty);
  if (Number.isFinite(minBase) && minBase > 0) return minBase;

  const minQty = Number(gateCfg.minQty);
  const mul = Number(gateCfg.quantoMultiplier);
  if (
    (gateCfg.quantityUnit === 'contract' || !gateCfg.enableDecimal)
    && Number.isFinite(minQty)
    && minQty > 0
    && Number.isFinite(mul)
    && mul > 0
  ) {
    return minQty * mul;
  }
  if (Number.isFinite(minQty) && minQty > 0) return minQty;
  return 0;
}

/** 币安最小 U 换算后的对齐步长：张数合约与 Gate multiplier 对齐 */
export function resolveAlignStep(binanceStepSize, gateCfg) {
  const binStep = Number(binanceStepSize);
  if (!Number.isFinite(binStep) || binStep <= 0) return 0;
  if (!gateCfg || gateCfg.enableDecimal || gateCfg.quantityUnit === 'base') {
    return binStep;
  }
  const mul = Number(gateCfg.quantoMultiplier);
  if (Number.isFinite(mul) && mul > 0) return Math.max(binStep, mul);
  return binStep;
}

/**
 * 币安有效最小名义 U：config.orderUsd 与 JSON 里该币 API minNotional 取大。
 */
export function resolveEffectiveMinNotional(orderUsd, binanceCfg) {
  const cfgU = Number(orderUsd);
  const apiU = Number(binanceCfg?.minNotional);
  const hasCfg = Number.isFinite(cfgU) && cfgU > 0;
  const hasApi = Number.isFinite(apiU) && apiU > 0;
  if (hasCfg && hasApi) return Math.max(cfgU, apiU);
  if (hasCfg) return cfgU;
  if (hasApi) return apiU;
  return 0;
}

/**
 * 币安侧：有效最小 U → 基础币数量（实时价）；特例币用 JSON lotMinQty。
 */
export function resolveBinanceMinBaseQty({ orderUsd, aPrice, binanceCfg, gateCfg, useLotMinQty }) {
  const stepSize = Number(binanceCfg?.stepSize);
  if (!Number.isFinite(stepSize) || stepSize <= 0) return 0;

  let qty;
  if (useLotMinQty) {
    qty = Number(binanceCfg.lotMinQty ?? binanceCfg.minQty);
    if (!Number.isFinite(qty) || qty <= 0) return 0;
    qty = ceilByStep(qty, stepSize);
  } else {
    const minU = resolveEffectiveMinNotional(orderUsd, binanceCfg);
    if (minU <= 0 || !Number.isFinite(aPrice) || aPrice <= 0) return 0;
    qty = ceilByStep(minU / aPrice, stepSize);
    const alignStep = resolveAlignStep(stepSize, gateCfg);
    if (alignStep > stepSize) {
      qty = ceilByStep(qty, alignStep);
    }
  }
  return qty;
}

/**
 * 两腿都能下单的最小基础币数量，并按 Gate 张数回推对齐。
 */
export function resolveMinHedgeQty({ orderUsd, aPrice, binanceCfg, gateCfg, useLotMinQty }) {
  const stepSize = Number(binanceCfg?.stepSize);
  if (!Number.isFinite(stepSize) || stepSize <= 0) {
    return { qty: 0, gateSize: 0, effectiveMinNotional: 0, qBinance: 0, qGate: 0 };
  }

  const effectiveMinNotional = useLotMinQty
    ? 0
    : resolveEffectiveMinNotional(orderUsd, binanceCfg);
  const qBinance = resolveBinanceMinBaseQty({
    orderUsd,
    aPrice,
    binanceCfg,
    gateCfg,
    useLotMinQty
  });
  const qGate = resolveGateMinBaseQty(gateCfg);
  let qty = Math.max(qBinance, qGate);
  if (qty <= 0) {
    return { qty: 0, gateSize: 0, effectiveMinNotional, qBinance, qGate };
  }

  const gateStep = Number(gateCfg?.stepSize || 1);
  let gateSize = 0;

  if (gateCfg?.quantityUnit === 'base' || gateCfg?.enableDecimal) {
    gateSize = floorByStep(qty, gateStep);
    if (gateSize <= 0 && qGate > 0) gateSize = ceilByStep(qGate, gateStep);
    qty = gateSize;
  } else {
    const multiplier = Number(gateCfg?.quantoMultiplier || 0);
    if (multiplier > 0) {
      gateSize = floorByStep(qty / multiplier, gateStep);
      if (gateSize <= 0 && qGate > 0) {
        gateSize = ceilByStep(qGate / multiplier, gateStep);
      }
      qty = floorByStep(gateSize * multiplier, stepSize);
    }
  }

  if (qty <= 0 || gateSize <= 0) {
    return { qty: 0, gateSize: 0, effectiveMinNotional, qBinance, qGate };
  }
  return { qty, gateSize, effectiveMinNotional, qBinance, qGate };
}

/** 按已有基础币数量向下对齐两腿步进，并回推 Gate 张数 */
export function resolveHedgeQtyFromBaseQty({ baseQty, binanceCfg, gateCfg }) {
  const stepSize = Number(binanceCfg?.stepSize);
  if (!Number.isFinite(stepSize) || stepSize <= 0 || !(baseQty > 0)) {
    return { qty: 0, gateSize: 0 };
  }

  let qty = floorByStep(baseQty, stepSize);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  const gateStep = Number(gateCfg?.stepSize || 1);
  let gateSize = 0;

  if (gateCfg?.quantityUnit === 'base' || gateCfg?.enableDecimal) {
    gateSize = floorByStep(qty, gateStep);
    qty = gateSize;
  } else {
    const multiplier = Number(gateCfg?.quantoMultiplier || 0);
    if (multiplier > 0) {
      gateSize = floorByStep(qty / multiplier, gateStep);
      qty = floorByStep(gateSize * multiplier, stepSize);
    }
  }

  if (qty <= 0 || gateSize <= 0) return { qty: 0, gateSize: 0 };
  return { qty, gateSize };
}

export default {
  resolveGateMinBaseQty,
  resolveAlignStep,
  resolveEffectiveMinNotional,
  resolveBinanceMinBaseQty,
  resolveMinHedgeQty,
  resolveHedgeQtyFromBaseQty
};
