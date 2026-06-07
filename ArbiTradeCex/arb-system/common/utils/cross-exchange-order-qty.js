import { ceilByStep } from './binance-order-limits.js';
import { floorByStep } from './precision.js';
import {
  gateContractMinToBaseQty,
  resolveGateContractStep
} from './gate-contract-limits.js';

/** Gate 最小基础币数量（decimal：gateOrderSizeMin 张 × multiplier） */
export function resolveGateMinBaseQty(gateCfg) {
  if (!gateCfg) return 0;

  const mul = Number(gateCfg.quantoMultiplier);
  const contractMin = Number(gateCfg.gateOrderSizeMin);
  let derived = 0;
  if (gateCfg.enableDecimal && contractMin > 0 && mul > 0) {
    derived = gateContractMinToBaseQty(contractMin, mul);
  }

  const minBase = Number(gateCfg.minBaseQty);
  const minQty = Number(gateCfg.minQty);
  let best = derived;
  if (Number.isFinite(minBase) && minBase > 0) best = Math.max(best, minBase);
  if (Number.isFinite(minQty) && minQty > 0) best = Math.max(best, minQty);

  if (
    (gateCfg.quantityUnit === 'contract' || !gateCfg.enableDecimal)
    && Number.isFinite(minQty)
    && minQty > 0
    && mul > 0
    && !(derived > 0)
  ) {
    return minQty * mul;
  }

  return best > 0 ? best : 0;
}

/**
 * Gate 张数合约：1 个「Gate 步进单位」对应多少 Binance 基础币。
 * decimal + multiplier：contractStep × multiplier（例：0.1 张 × 100 = 10 币）。
 */
export function resolveGateBaseAlignStep(gateCfg) {
  if (!gateCfg) return 0;

  const mult = Number(gateCfg?.quantoMultiplier);
  if (gateCfg.enableDecimal && Number.isFinite(mult) && mult > 0) {
    const contractStep = resolveGateContractStep(gateCfg);
    return contractStep * mult;
  }

  if (gateCfg.enableDecimal || gateCfg.quantityUnit === 'base') {
    return Number(gateCfg?.stepSize) || 0;
  }

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

function alignDecimalGateHedge({ baseQty, binanceCfg, gateCfg, round }) {
  const stepSize = Number(binanceCfg?.stepSize);
  const multiplier = Number(gateCfg?.quantoMultiplier);
  const contractStep = resolveGateContractStep(gateCfg);
  const baseUnit = contractStep * multiplier;

  const toMultiple = round === 'floor' ? floorToStepMultiple : ceilToStepMultiple;
  const toBinStep = round === 'floor' ? floorByStep : ceilByStep;
  const toContractStep = round === 'floor'
    ? (value, step) => floorByStep(value, step)
    : (value, step) => ceilByStep(value, step);

  let qty = toBinStep(baseQty, stepSize);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  if (baseUnit > 0) {
    qty = toMultiple(qty, baseUnit);
  }
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  let gateSize = qty / multiplier;
  gateSize = toContractStep(gateSize, contractStep);
  if (!(gateSize > 0)) return { qty: 0, gateSize: 0 };

  qty = gateSize * multiplier;
  qty = toBinStep(qty, stepSize);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  return { qty, gateSize };
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

  const multiplier = Number(gateCfg?.quantoMultiplier || 0);
  if (gateCfg?.enableDecimal && multiplier > 0) {
    return alignDecimalGateHedge({ baseQty, binanceCfg, gateCfg, round });
  }

  const toMultiple = round === 'floor' ? floorToStepMultiple : ceilToStepMultiple;
  const toBinStep = round === 'floor' ? floorByStep : ceilByStep;

  let qty = toBinStep(baseQty, stepSize);
  if (qty <= 0) return { qty: 0, gateSize: 0 };

  if (gateCfg?.quantityUnit === 'base') {
    const gateStep = Number(gateCfg?.stepSize) || stepSize;
    qty = toMultiple(qty, gateStep);
    if (qty <= 0) return { qty: 0, gateSize: 0 };
    return { qty, gateSize: qty };
  }

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
 * 币安侧最小基础币（仅 Binance 规则，不做 Gate 对齐）：
 *   1. orderUsd（如 5U）÷ 实时价，按 stepSize 向上取整
 *   2. 与 JSON 里 binance.minQty（API 合成最小量）取 max
 */
export function resolveBinanceMinBaseQty({ orderUsd, aPrice, binanceCfg, useLotMinQty }) {
  const stepSize = Number(binanceCfg?.stepSize);
  if (!Number.isFinite(stepSize) || stepSize <= 0) return 0;

  if (useLotMinQty) {
    const lotQty = Number(binanceCfg.lotMinQty ?? binanceCfg.minQty);
    if (!Number.isFinite(lotQty) || lotQty <= 0) return 0;
    return ceilByStep(lotQty, stepSize);
  }

  const minU = resolveEffectiveMinNotional(orderUsd, binanceCfg);
  if (minU <= 0 || !Number.isFinite(aPrice) || aPrice <= 0) return 0;

  let qty = ceilByStep(minU / aPrice, stepSize);
  const apiMin = resolveBinanceApiMinBaseQty(binanceCfg);
  if (apiMin > 0) qty = Math.max(qty, apiMin);
  return qty;
}

/**
 * 两腿最小对冲量（基础币 qty + Gate 张数 gateSize）：
 *   1. qBinance = resolveBinanceMinBaseQty（5U 与币安配置取大）
 *   2. qGate = Gate 最小张数 × multiplier（换算成基础币）
 *   3. rawQty = max(qBinance, qGate)
 *   4. alignHedgeBaseQty：
 *        - 币安小 → 抬到 Gate 最小张数对应的基础币
 *        - 币安大 → 向上对齐到 Gate 张数步进的整数倍，再反算 gateSize
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
