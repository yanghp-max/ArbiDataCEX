import assert from 'node:assert/strict';
import {
  isBinanceExchangeInfoStale,
  reconcileBinanceSymbolFilters
} from '../common/utils/binance-symbol-info.js';
import { resolveBinanceOrderLimits } from '../common/utils/binance-order-limits.js';
import { resolveGateOrderLimits } from '../common/utils/gate-contract-limits.js';
import { resolveGateMinBaseQty } from '../common/utils/cross-exchange-order-qty.js';

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
assert.ok(gateLimits.minBaseQty >= 3.788);

const gateCfg = {
  minBaseQty: gateLimits.minBaseQty,
  gateOrderSizeMin: gateLimits.gateOrderSizeMin,
  enableDecimal: true,
  quantoMultiplier: 100
};
assert.equal(resolveGateMinBaseQty(gateCfg), gateLimits.minBaseQty);

console.log('test-min-order-limits OK', {
  minBaseQty: gateLimits.minBaseQty,
  gateOrderSizeMin: gateLimits.gateOrderSizeMin
});
