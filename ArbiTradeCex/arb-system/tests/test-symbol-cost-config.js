import assert from 'node:assert/strict';
import {
  resolveCexCostConfigForSymbol,
  calcSpreads,
  DEFAULT_BINANCE_FEE_BPS,
  DEFAULT_GATE_FEE_BPS
} from '../arbitrage/services/spread-calculator.js';

const strategy = {
  binanceFeeBps: 5,
  gateFeeBps: 5,
  binanceSlippageBps: 1,
  gateSlippageBps: 1,
  symbolOverrides: {
    HOMEUSDT: {
      binanceFeeBps: 99,
      gateFeeBps: 99,
      binanceSlippageBps: 20,
      gateSlippageBps: 22
    }
  }
};

const homeCost = resolveCexCostConfigForSymbol(strategy, 'HOMEUSDT');
assert.equal(homeCost.binanceFeeBps, 5, 'override 内 fee 应被忽略');
assert.equal(homeCost.gateFeeBps, 5, 'override 内 fee 应被忽略');
assert.equal(homeCost.binanceSlippageBps, 20);
assert.equal(homeCost.gateSlippageBps, 22);
assert.equal(homeCost.binanceBpsPerLeg, 25);
assert.equal(homeCost.gateBpsPerLeg, 27);

const defaultCost = resolveCexCostConfigForSymbol(strategy, 'BTCUSDT');
assert.equal(defaultCost.binanceFeeBps, 5);
assert.equal(defaultCost.binanceBpsPerLeg, 6);

const legacy = resolveCexCostConfigForSymbol({
  binanceBpsPerLeg: 10,
  gateBpsPerLeg: 8
}, 'FOO');
assert.equal(legacy.binanceBpsPerLeg, 10);
assert.equal(legacy.binanceFeeBps, DEFAULT_BINANCE_FEE_BPS);
assert.equal(legacy.binanceSlippageBps, 5);

const tick = { aBid: 1, aAsk: 1.01, bBid: 0.99, bAsk: 1 };
const globalSpread = calcSpreads(tick, defaultCost);
const homeSpread = calcSpreads(tick, homeCost);
assert.ok(homeSpread.spreadAbAdj < globalSpread.spreadAbAdj, 'HOME 更高滑点应压低扣费后 spread');

const feeOnly = calcSpreads(tick, {
  binanceFeeBps: 5,
  gateFeeBps: 5,
  binanceSlippageBps: 0,
  gateSlippageBps: 0
});
const withSlip = calcSpreads(tick, {
  binanceFeeBps: 5,
  gateFeeBps: 5,
  binanceSlippageBps: 10,
  gateSlippageBps: 10
});
assert.ok(withSlip.spreadAbAdj < feeOnly.spreadAbAdj, '加滑点应进一步压低 spread');

console.log('test-symbol-cost-config: OK');
