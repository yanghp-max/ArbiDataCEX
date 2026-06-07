import assert from 'node:assert/strict';
import {
  isBinanceExchangeInfoStale,
  reconcileBinanceSymbolFilters
} from '../common/utils/binance-symbol-info.js';
import { resolveBinanceOrderLimits } from '../common/utils/binance-order-limits.js';
import { resolveGateOrderLimits } from '../common/utils/gate-contract-limits.js';
import {
  resolveGateMinBaseQty,
  resolveMinHedgeQty
} from '../common/utils/cross-exchange-order-qty.js';

// LAB 整包 exchangeInfo 滞后：价 ~13 但 stepSize=1
const staleLabInfo = {
  symbol: 'LABUSDT',
  filters: [
    { filterType: 'PRICE_FILTER', minPrice: '0.001', maxPrice: '400', tickSize: '0.001' },
    { filterType: 'LOT_SIZE', minQty: '1', stepSize: '1', maxQty: '6000000' },
    { filterType: 'MIN_NOTIONAL', notional: '5' }
  ]
};
assert.equal(isBinanceExchangeInfoStale(staleLabInfo, 13.14), true);

const reconciled = reconcileBinanceSymbolFilters(staleLabInfo, 13.14);
const binLimits = resolveBinanceOrderLimits(reconciled, { refPrice: 13.14 });
assert.ok(binLimits.minQty >= 3.788, `expected minQty>=3.788 got ${binLimits.minQty}`);
assert.equal(binLimits.minNotional, 50);

const gateLabDecimal = {
  name: 'LAB_USDT',
  enable_decimal: true,
  order_size_min: '0.1',
  order_size_round: '0.1',
  quanto_multiplier: '100'
};
const gateLimits = resolveGateOrderLimits(gateLabDecimal, {
  binanceMinQty: binLimits.minQty,
  binanceStepSize: binLimits.stepSize,
  gateSymbol: 'LAB_USDT'
});
assert.equal(gateLimits.gateOrderSizeMin, 0.1);
assert.equal(gateLimits.quantityUnit, 'contract');
assert.ok(gateLimits.minBaseQty >= 10, `LAB gate min base expected >=10 got ${gateLimits.minBaseQty}`);

const gateCfg = {
  minBaseQty: gateLimits.minBaseQty,
  minQty: gateLimits.minQty,
  gateOrderSizeMin: gateLimits.gateOrderSizeMin,
  enableDecimal: true,
  quantoMultiplier: 100,
  quantityUnit: 'contract'
};
assert.equal(resolveGateMinBaseQty(gateCfg), 10);

const sirenGateLimits = resolveGateOrderLimits({
  name: 'SIREN_USDT',
  enable_decimal: true,
  order_size_min: '0.1',
  quanto_multiplier: '100'
}, {
  binanceMinQty: 6,
  binanceStepSize: 1,
  gateSymbol: 'SIREN_USDT'
});
assert.equal(sirenGateLimits.minBaseQty, 10);
assert.equal(sirenGateLimits.minQty, 10);
assert.equal(sirenGateLimits.gateOrderSizeMin, 0.1);

const sirenHedge = resolveMinHedgeQty({
  orderUsd: 5,
  aPrice: 0.84,
  binanceCfg: { stepSize: 1, minQty: 6, minNotional: 5 },
  gateCfg: {
    enableDecimal: true,
    gateOrderSizeMin: 0.1,
    quantoMultiplier: 100,
    minBaseQty: 6,
    minQty: 6,
    stepSize: 1,
    quantityUnit: 'base'
  }
});
assert.equal(sirenHedge.qty, 10);
assert.equal(sirenHedge.gateSize, 0.1);
assert.equal(sirenHedge.qBinance, 6);
assert.equal(sirenHedge.qGate, 10);

const sirenBinanceLarger = resolveMinHedgeQty({
  orderUsd: 5,
  aPrice: 0.4,
  binanceCfg: { stepSize: 1, minQty: 6, minNotional: 5 },
  gateCfg: {
    enableDecimal: true,
    gateOrderSizeMin: 0.1,
    quantoMultiplier: 100,
    quantityUnit: 'contract'
  }
});
assert.equal(sirenBinanceLarger.qBinance, 13);
assert.equal(sirenBinanceLarger.qGate, 10);
assert.equal(sirenBinanceLarger.qty, 20);
assert.equal(sirenBinanceLarger.gateSize, 0.2);

console.log('test-min-order-limits OK', {
  labMinBaseQty: gateLimits.minBaseQty,
  sirenMinBaseQty: sirenGateLimits.minBaseQty,
  sirenHedgeQty: sirenHedge.qty,
  sirenGateSize: sirenHedge.gateSize
});
