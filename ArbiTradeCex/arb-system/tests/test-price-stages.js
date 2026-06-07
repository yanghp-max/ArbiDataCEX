import assert from 'node:assert/strict';
import {
  createTradeLatencyTrace,
  setFreshTickOnLatencyTrace,
  attachFillPricesToTrace,
  priceStagesCsvFields,
  formatPriceStageLines,
  latencyCsvFields
} from '../arbitrage/monitoring/trade-latency.js';

const snap = {
  symbol: 'SIRENUSDT',
  aBid: 1.0,
  aAsk: 1.01,
  bBid: 0.99,
  bAsk: 1.0
};

const tick = {
  timestamp: Date.now(),
  priceReceiveMs: Date.now(),
  priceAgeMs: 5,
  aBid: 1.0,
  aAsk: 1.01,
  bBid: 0.99,
  bAsk: 1.001
};

const trace = createTradeLatencyTrace(tick, { direction: '-a+b', priceSnapshot: snap });
assert.equal(trace.priceStages.signal.aPrice, 1.0);
assert.equal(trace.priceStages.signal.bPrice, 1.0);

setFreshTickOnLatencyTrace(trace, tick);
assert.equal(trace.priceStages.send.aPrice, 1.0);
assert.equal(trace.priceStages.send.bPrice, 1.001);

attachFillPricesToTrace(trace, {
  aFilledQty: 10,
  bFilledQty: 10,
  aFillPrice: 0.999,
  bFillPrice: 1.002
});
assert.equal(trace.priceStages.fill.aPrice, 0.999);
assert.equal(trace.priceStages.fill.bPrice, 1.002);

const csv = priceStagesCsvFields(trace);
assert.equal(csv.accept_a_price, 1.0);
assert.equal(csv.send_b_price, 1.001);

const lines = formatPriceStageLines(trace);
assert.equal(lines.length, 1);
assert.match(lines[0], /接受 A=1\.00000000 B=1\.00000000/);
assert.match(lines[0], /成交 A=0\.99900000 B=1\.00200000/);

const lat = latencyCsvFields(trace);
assert.equal(lat.accept_a_price, 1.0);
assert.equal(lat.send_b_price, 1.001);

console.log('test-price-stages: OK');
