import assert from 'node:assert/strict';
import { PrecisionChecker } from '../arbitrage/risk/risk-manager.js';

const husdtCfg = {
  binance: { stepSize: 1, minQty: 1, minNotional: 5 },
  gate: {
    enableDecimal: false,
    gateOrderSizeMin: 1,
    quantoMultiplier: 1,
    minBaseQty: 1,
    minQty: 1,
    stepSize: 1,
    quantityUnit: 'base'
  }
};

const checker = new PrecisionChecker({ HUSDT: husdtCfg });
const tick = { symbol: 'HUSDT', aBid: 0.3, aAsk: 0.31, bBid: 0.29, bAsk: 0.295 };

const fullTier = checker.finalizeCloseOrder({
  direction: '+a-b',
  tick,
  configQty: 20,
  holdA: 60,
  holdB: -60
});
assert.equal(fullTier.qty, 20, '持仓 60 时应平配置档位 20');

const tail = checker.finalizeCloseOrder({
  direction: '+a-b',
  tick,
  configQty: 20,
  holdA: 10,
  holdB: -10
});
assert.equal(tail.qty, 10, '尾仓 10 时应全平剩余 10');

const imbalanced = checker.finalizeCloseOrder({
  direction: '+a-b',
  tick,
  configQty: 20,
  holdA: 30,
  holdB: -10
});
assert.equal(imbalanced.qty, 10, '失衡时按较小腿 min(20,30,10)=10');

const empty = checker.finalizeCloseOrder({
  direction: '+a-b',
  tick,
  configQty: 20,
  holdA: 0,
  holdB: 0
});
assert.equal(empty, null, '空仓应返回 null');

console.log('test-finalize-close-order OK');
