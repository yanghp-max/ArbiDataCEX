import assert from 'node:assert';
import { RollingSignalEngine } from '../arbitrage/calculator/rolling-signal-engine.js';

const engine = new RollingSignalEngine({ windowSeconds: 10, minDataPoints: 3 });
const baseTs = 1_700_000_000_000;

for (let i = 0; i < 12; i += 1) {
  engine.updateAndCalc({
    timestamp: baseTs + i * 1000,
    spreadAb: 0.1 + i * 0.01,
    spreadBa: -0.1 - i * 0.01,
    spreadAbAdj: 0.1 + i * 0.01,
    spreadBaAdj: -0.1 - i * 0.01
  });
}

assert.ok(engine.buckets.size <= 11, `buckets should be window-bounded, got ${engine.buckets.size}`);
assert.ok(engine.windowReady, 'window should be ready');

const last = engine.updateAndCalc({
  timestamp: baseTs + 12_000,
  spreadAb: 0.5,
  spreadBa: -0.5,
  spreadAbAdj: 0.5,
  spreadBaAdj: -0.5
});
assert.equal(last.windowReady, true);
assert.ok(Number.isFinite(last.openZAb) || Number.isFinite(last.openZBa));

console.log('test-rolling-signal-engine: OK');
