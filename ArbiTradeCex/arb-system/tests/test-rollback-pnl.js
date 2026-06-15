import assert from 'node:assert/strict';
import { mergeOpenAddRollbackPnl, calcTradePnlFromLegs } from '../arbitrage/execution/cex-leg-pnl.js';

const openFill = {
  legExposure: true,
  failedLeg: 'binance',
  aFilledQty: 0,
  bFilledQty: 20,
  aSide: 'sell',
  bSide: 'buy',
  aLeg: { filled: false, usdtChange: 0, fee: 0, pnlComplete: false },
  bLeg: {
    filled: true,
    side: 'buy',
    filledQty: 20,
    usdtChange: -4.81,
    fee: 0.01,
    quoteVolume: 4.8,
    pnlComplete: true
  }
};

const rollbackFill = {
  aFilledQty: 0,
  bFilledQty: 20,
  bFillPrice: 0.241,
  bLeg: {
    filled: true,
    side: 'sell',
    filledQty: 20,
    usdtChange: 4.81,
    fee: 0.01,
    quoteVolume: 4.82,
    pnlComplete: true
  }
};

const merged = mergeOpenAddRollbackPnl(openFill, rollbackFill);
assert.equal(merged.rollbackApplied, true);
assert.equal(merged.legExposure, false);
assert.equal(merged.bLeg.usdtChange, 0);
assert.equal(calcTradePnlFromLegs(merged), 0);

const rollbackFillLoss = {
  ...rollbackFill,
  bLeg: {
    ...rollbackFill.bLeg,
    usdtChange: 4.75,
    quoteVolume: 4.76,
    fee: 0.01
  }
};
const mergedLoss = mergeOpenAddRollbackPnl(openFill, rollbackFillLoss);
assert.ok(Math.abs(mergedLoss.bLeg.usdtChange - (-0.06)) < 1e-9);
assert.ok(Math.abs(calcTradePnlFromLegs(mergedLoss) - (-0.06)) < 1e-9);

console.log('test-rollback-pnl OK');
