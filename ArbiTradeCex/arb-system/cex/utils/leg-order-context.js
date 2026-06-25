/**
 * B 腿下单单位 / 预检上下文（与 Gate 管道对齐，不限定 exchange 名称）
 */

export function isContractQuantityUnit(limits = {}) {
  if (!limits || typeof limits !== 'object') return false;
  if (limits.quantityUnit === 'contract') return true;
  if (limits.quantityUnit === 'base') return false;
  const sizeMin = Number(limits.gateOrderSizeMin);
  const sizeRound = Number(limits.gateOrderSizeRound);
  if ((Number.isFinite(sizeMin) && sizeMin > 0) || (Number.isFinite(sizeRound) && sizeRound > 0)) {
    if (limits.enableDecimal && Number(limits.quantoMultiplier) > 0) return true;
    return !limits.enableDecimal;
  }
  return false;
}

export default { isContractQuantityUnit };
