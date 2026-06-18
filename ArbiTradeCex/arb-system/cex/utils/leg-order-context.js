/**
 * B 腿下单单位 / 预检 / PnL 聚合上下文（与 Gate 管道对齐，不限定 exchange 名称）
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

export function resolveBLegQuantityUnit(limits) {
  return isContractQuantityUnit(limits) ? 'contract' : 'base';
}

/**
 * @returns {{ quantityUnit: 'contract'|'base', orderQty: number, contracts: number|null, baseQty: number }}
 */
export function resolveLegOrderQty({
  quantityUnit = 'base',
  amount,
  orderAmount = null,
  quantoMultiplier = 1
} = {}) {
  const mult = Number(quantoMultiplier);
  const m = Number.isFinite(mult) && mult > 0 ? mult : 1;
  const baseAmt = Number(amount);
  const rawOrder = orderAmount != null ? Number(orderAmount) : baseAmt;

  if (quantityUnit === 'contract') {
    const contracts = Number.isFinite(rawOrder) && rawOrder > 0 ? rawOrder : baseAmt;
    const baseQty = contracts * m;
    return { quantityUnit, orderQty: contracts, contracts, baseQty };
  }

  const baseQty = Number.isFinite(rawOrder) && rawOrder > 0 ? rawOrder : baseAmt;
  return { quantityUnit, orderQty: baseQty, contracts: null, baseQty };
}

export function resolveBLegLimitsFromOrder(order) {
  return order?.cfg?.gate
    || order?.cfg?.legs?.B?.limits
    || null;
}

export function resolveBLegOrderContextFromOrder(order) {
  const limits = resolveBLegLimitsFromOrder(order);
  const quantityUnit = resolveBLegQuantityUnit(limits);
  const quantoMultiplier = Number(order?.gateQuantoMultiplier ?? limits?.quantoMultiplier) || 1;
  const gateSize = Number(order?.gateSize ?? order?.qty);
  const qty = Number(order?.qty);
  return {
    limits,
    quantityUnit,
    quantoMultiplier,
    tradeFormat: quantityUnit === 'contract' ? 'gate-contract' : 'binance-like',
    ...resolveLegOrderQty({
      quantityUnit,
      amount: qty,
      orderAmount: gateSize,
      quantoMultiplier
    })
  };
}

export function inferPrecheckQuantityUnit({
  exchange,
  amount,
  gateAmount,
  quantoMultiplier,
  quantityUnit,
  legRole
} = {}) {
  if (quantityUnit === 'contract' || quantityUnit === 'base') return quantityUnit;
  const ex = String(exchange || '').toLowerCase();
  const mult = Number(quantoMultiplier);
  const hasOrderAmt = gateAmount != null && Number.isFinite(Number(gateAmount));
  if (legRole === 'B' && hasOrderAmt && mult > 0 && Math.abs(Number(amount) - Number(gateAmount)) > 1e-12) {
    return 'contract';
  }
  if (ex === 'gate' && hasOrderAmt) return 'contract';
  return 'base';
}

export function resolvePrecheckQtyContext(params = {}) {
  const quantityUnit = inferPrecheckQuantityUnit(params);
  const qty = resolveLegOrderQty({
    quantityUnit,
    amount: params.amount,
    orderAmount: params.gateAmount,
    quantoMultiplier: params.quantoMultiplier
  });
  const ex = String(params.exchange || '').toLowerCase();
  const strictFuturesMargin = params.legRole === 'B' || ex === 'gate';
  return { quantityUnit, strictFuturesMargin, ...qty };
}

export default {
  isContractQuantityUnit,
  resolveBLegQuantityUnit,
  resolveLegOrderQty,
  resolveBLegOrderContextFromOrder,
  inferPrecheckQuantityUnit,
  resolvePrecheckQtyContext
};
