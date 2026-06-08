import assert from 'node:assert/strict';
import { QuoteAggregator } from '../arbitrage/services/quote-aggregator.js';

const agg = new QuoteAggregator();
const now = Date.now();

agg.onTicker('binance', {
  symbol: 'ALLO-USDT',
  bid: 0.39,
  ask: 0.391,
  timestamp: now - 300_000,
  serverTimestamp: now - 300_000,
  localTimestamp: now - 50,
  wsDelayMs: null
});
agg.onTicker('gate', {
  symbol: 'ALLO-USDT',
  bid: 0.396,
  ask: 0.397,
  timestamp: now - 20,
  serverTimestamp: now - 20,
  localTimestamp: now - 20,
  wsDelayMs: 12
});

const tick = agg.buildTick('ALLOUSDT');
assert.ok(tick);
assert.equal(tick.aLatencyMs, null);
assert.equal(tick.bLatencyMs, 12);
assert.equal(tick.maxWsLatencyMs, 12);
assert.ok(tick.aAgeMs <= 60, `aAgeMs should be receive-based (~50ms), got ${tick.aAgeMs}`);
assert.ok(tick.bAgeMs <= 30, `bAgeMs should be receive-based (~20ms), got ${tick.bAgeMs}`);
assert.ok(tick.legSkewMs <= 60, `legSkewMs should be receive delta, got ${tick.legSkewMs}`);
assert.ok(tick.priceAgeMs >= 45, `priceAgeMs should be stalest leg (~50ms), got ${tick.priceAgeMs}`);
assert.ok(tick.priceAgeMs <= 70, `priceAgeMs should be stalest leg (~50ms), got ${tick.priceAgeMs}`);

console.log('test-quote-aggregator-timing: OK');
