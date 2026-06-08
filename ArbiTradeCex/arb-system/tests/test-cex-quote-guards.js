import assert from 'node:assert/strict';
import {
  tickEachLegAgePass,
  tickCrossLegMidPass,
  tickLatencyPass,
  resolveLatencyLimits
} from '../arbitrage/risk/risk-manager.js';

const limits = resolveLatencyLimits({ maxCrossLegMidBps: 50 }, true);

assert.equal(tickEachLegAgePass({ aAgeMs: 20, bAgeMs: 800, priceAgeMs: 800 }, 1000), true);
assert.equal(tickEachLegAgePass({ aAgeMs: 20, bAgeMs: 1200, priceAgeMs: 1200 }, 1000), false);

assert.equal(
  tickCrossLegMidPass({ aBid: 0.03286, aAsk: 0.03288, bBid: 0.0325, bAsk: 0.03253 }, 50),
  false,
  'HOME 假价差应被跨腿检查拦住'
);
assert.equal(
  tickCrossLegMidPass({ aBid: 0.0325, aAsk: 0.03252, bBid: 0.03249, bAsk: 0.03251 }, 50),
  true
);

const staleBinance = {
  aBid: 0.03286,
  aAsk: 0.03288,
  bBid: 0.0325,
  bAsk: 0.03253,
  aAgeMs: 30,
  bAgeMs: 25,
  priceAgeMs: 30,
  legSkewMs: 5,
  aLatencyMs: 10,
  bLatencyMs: 8,
  maxWsLatencyMs: 10
};
assert.equal(tickLatencyPass(staleBinance, limits), false, '跨腿 mid 超阈应不通过');

console.log('test-cex-quote-guards: OK');
