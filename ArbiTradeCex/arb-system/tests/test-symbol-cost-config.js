import assert from 'node:assert/strict';
import {
  resolveCexCostConfigForSymbol,
  calcSpreads
} from '../arbitrage/services/spread-calculator.js';

const strategy = {
  binanceBpsPerLeg: 6,
  gateBpsPerLeg: 4,
  symbolOverrides: {
    HOMEUSDT: { binanceBpsPerLeg: 22, gateBpsPerLeg: 24 }
  }
};

const homeCost = resolveCexCostConfigForSymbol(strategy, 'HOMEUSDT');
assert.equal(homeCost.binanceBpsPerLeg, 22);
assert.equal(homeCost.gateBpsPerLeg, 24);

const defaultCost = resolveCexCostConfigForSymbol(strategy, 'BTCUSDT');
assert.equal(defaultCost.binanceBpsPerLeg, 6);
assert.equal(defaultCost.gateBpsPerLeg, 4);

const tick = { aBid: 1, aAsk: 1.01, bBid: 0.99, bAsk: 1 };
const globalSpread = calcSpreads(tick, defaultCost);
const homeSpread = calcSpreads(tick, homeCost);
assert.ok(homeSpread.spreadAbAdj < globalSpread.spreadAbAdj, 'HOME 更高 bps 应压低扣费后 spread');

console.log('test-symbol-cost-config: OK');
