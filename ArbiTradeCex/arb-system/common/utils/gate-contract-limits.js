/**
 * Gate 合约最小量/步进解析。
 * enable_decimal 合约 order_size_min 为 0，最小量按 Binance base qty 对齐。
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

  if (enableDecimal) {
    if (!Number.isFinite(binanceMinQty) || binanceMinQty <= 0) {
      throw new Error(`invalid Binance minQty for decimal Gate contract ${name}`);
    }
    if (!Number.isFinite(binanceStepSize) || binanceStepSize <= 0) {
      throw new Error(`invalid Binance stepSize for decimal Gate contract ${name}`);
    }
    return {
      minQty: binanceMinQty,
      stepSize: binanceStepSize,
      quantityUnit: 'base',
      enableDecimal: true,
      quantoMultiplier: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
        ? gateQuantoMultiplier
        : null,
      minBaseQty: binanceMinQty
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
      : null
  };
}

export default { resolveGateOrderLimits };
