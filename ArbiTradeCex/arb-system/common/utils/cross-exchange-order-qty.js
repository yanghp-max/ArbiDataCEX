import { ceilByStep } from './binance-order-limits.js';
import { floorByStep } from './precision.js';

/** Gate 最小基础币数量（张数合约：minQty 张 × multiplier） */
export function resolveGateMinBaseQty(gateCfg) {
  if (!gateCfg) return 0;
  const apiMin = Number(gateCfg.gateOrderSizeMin);
  const minBase = Number(gateCfg.minBaseQty);
  if (Number.isFinite(apiMin) && apiMin > 0 && Number.isFinite(minBase) && minBase > 0) {
    return Math.max(apiMin, minBase);
  }
  if (Number.isFinite(minBase) && minBase > 0) return minBase;
  if (Number.isFinite(apiMin) && apiMin > 0) return apiMin;

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

/**
 * Gate 张数合约：1 个「Gate 步进单位」对应多少 Binance 基础币。
 * 例：multiplier=100、gateStep=1 → 100；multiplier=10、gateStep=1 → 10（币安须为其整数倍）。
 */
export function resolveGateBaseAlignStep(gateCfg) {
  if (!gateCfg || gateCfg.enableDecimal || gateCfg.quantityUnit === 'base') {
    return Number(gateCfg?.stepSize) || 0;
  }
  const mult = Number(gateCfg?.quantoMultiplier);
  const gateStep = Number(gateCfg?.stepSize || 1);
  if (!Number.isFinite(mult) || mult <= 0) return 0;
  return mult * (gateStep > 0 ? gateStep : 1);
}

/** @deprecated 使用 resolveGateBaseAlignStep */
export function resolveAlignStep(binanceStepSize, gateCfg) {
  const gateBase = resolveGateBaseAlignStep(gateCfg);
  const binStep = Number(binanceStepSize);
  if (!Number.isFinite(binStep) || binStep <= 0) return gateBase;
  if (!(gateBase > 0)) return binStep;
  return Math.max(binStep, gateBase);
}

function isAligned(value, step) {
  if (!(step > 0)) return true;
  const rem = value % step;
  return rem < 1e-9 || Math.abs(rem - step) < 1e-9;
}

/** 向上对齐到 step 整数倍（已是整数倍则不变：250+step100→250，122+step100→200） */
export function ceilToStepMultiple(value, step) {
  if (!Number.isFinite(value) || value <= 0 || !(step > 0)) return 0;
  if (isAligned(value, step)) return value;
  return value + (step - (value % step));
}

/** 向下对齐到 step 整数倍 */
export function floorToStepMultiple(value, step) {
  if (!Number.isFinite(value) || value <= 0 || !(step > 0)) return 0;
  return floorByStep(value, step);
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

/** JSON 里 binance.minQty（LOT_SIZE + MIN_NOTIONAL 合成，build 脚本写入） */
export function resolveBinanceApiMinBaseQty(binanceCfg) {
  const stepSize = Number(binanceCfg?.stepSize);
  const minQty = Number(binanceCfg?.minQty);
  if (!Number.isFinite(stepSize) || stepSize <= 0) return 0;
  if (!Number.isFinite(minQty) || minQty <= 0) return 0;
  return ceilByStep(minQty, stepSize);
}

/**
 * 币安基础币 ↔ Gate 张数对齐。
 * round='ceil'（开仓/最小量）：币安量向上调到 Gate 张数倍的整数倍。
 * round='floor'（平仓截断）：向下对齐，避免超平。
 */
export function alignHedgeBaseQty({ baseQty, binanceCfg, gateCfg, round = 'ceil' }) {
  const stepSize = Number(binanceCfg?.stepSize);
  if (!Number.isFinite(stepSize) || stepSize <= 0 || !(baseQty > 0)) {
    return { qty: 0, gateSize: 0 };
  }

  const toMultiple = round === 'floor' ? floorToStepMultiple : ceilToStepMultiple;
  const toBinStep = round === 'floor' ? floorByStep : ceilByStep;

  let qty = toBinStep(baseQty, stepSize);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  if (gateCfg?.quantityUnit === 'base' || gateCfg?.enableDecimal) {
    const gateStep = Number(gateCfg?.stepSize) || stepSize;
    qty = toMultiple(qty, gateStep);
    if (qty <= 0) return { qty: 0, gateSize: 0 };
    return { qty, gateSize: qty };
  }

  const multiplier = Number(gateCfg?.quantoMultiplier || 0);
  const gateStep = Number(gateCfg?.stepSize || 1);
  if (!(multiplier > 0)) return { qty: 0, gateSize: 0 };

  const gateBaseUnit = multiplier * (gateStep > 0 ? gateStep : 1);
  qty = toMultiple(qty, gateBaseUnit);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  let gateSize = qty / multiplier;
  if (gateStep > 1) {
    gateSize = toMultiple(gateSize, gateStep);
    qty = gateSize * multiplier;
  }
  return { qty, gateSize };
}

/**
 * 币安侧：有效最小 U → 基础币数量（实时价）；特例币用 JSON lotMinQty。
 * 再向上对齐到 Gate 张数倍数（resolveGateBaseAlignStep）。
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
    const apiMin = resolveBinanceApiMinBaseQty(binanceCfg);
    if (apiMin > 0) qty = Math.max(qty, apiMin);
  }

  const gateBaseUnit = resolveGateBaseAlignStep(gateCfg);
  if (gateBaseUnit > 0) {
    qty = ceilToStepMultiple(qty, gateBaseUnit);
  }
  return qty;
}

/**
 * 两腿都能下单的最小基础币数量（币安 min + Gate min，再向上对齐 Gate 张数倍）。
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
  const rawQty = Math.max(qBinance, qGate);
  if (rawQty <= 0) {
    return { qty: 0, gateSize: 0, effectiveMinNotional, qBinance, qGate };
  }

  const { qty, gateSize } = alignHedgeBaseQty({
    baseQty: rawQty,
    binanceCfg,
    gateCfg,
    round: 'ceil'
  });

  if (qty <= 0 || gateSize <= 0) {
    return { qty: 0, gateSize: 0, effectiveMinNotional, qBinance, qGate };
  }
  return { qty, gateSize, effectiveMinNotional, qBinance, qGate };
}

/** 按已有基础币数量对齐两腿；开仓用 ceil，平仓用 floor */
export function resolveHedgeQtyFromBaseQty({ baseQty, binanceCfg, gateCfg, round = 'floor' }) {
  return alignHedgeBaseQty({ baseQty, binanceCfg, gateCfg, round });
}

export default {
  resolveGateMinBaseQty,
  resolveGateBaseAlignStep,
  resolveAlignStep,
  ceilToStepMultiple,
  floorToStepMultiple,
  resolveEffectiveMinNotional,
  resolveBinanceApiMinBaseQty,
  resolveBinanceMinBaseQty,
  alignHedgeBaseQty,
  resolveMinHedgeQty,
  resolveHedgeQtyFromBaseQty
};
