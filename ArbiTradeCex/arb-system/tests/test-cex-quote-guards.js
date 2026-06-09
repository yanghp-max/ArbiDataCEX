import assert from 'node:assert/strict';
import {
  tickEachLegAgePass,
  tickLatencyPass,
  resolveLatencyLimits
} from '../arbitrage/risk/risk-manager.js';

const limits = resolveLatencyLimits({ maxPriceAgeMs: 1000 }, true);

assert.equal(tickEachLegAgePass({ aAgeMs: 20, bAgeMs: 800, priceAgeMs: 800 }, 1000), true);
assert.equal(tickEachLegAgePass({ aAgeMs: 20, bAgeMs: 1200, priceAgeMs: 1200 }, 1000), false);

const alignedTick = {
  aBid: 0.0325,
  aAsk: 0.03252,
  bBid: 0.03249,
  bAsk: 0.03251,
  aAgeMs: 30,
  bAgeMs: 25,
  priceAgeMs: 30,
  legSkewMs: 5,
  aLatencyMs: 10,
  bLatencyMs: 8,
  maxWsLatencyMs: 10
};
assert.equal(tickLatencyPass(alignedTick, limits), true, '对齐行情应通过延迟检查');

const staleLegTick = {
  ...alignedTick,
  bAgeMs: 1200,
  priceAgeMs: 1200
};
assert.equal(tickLatencyPass(staleLegTick, limits), false, '单腿过旧应不通过');

console.log('test-cex-quote-guards: OK');
