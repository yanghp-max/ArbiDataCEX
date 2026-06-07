#!/usr/bin/env node
/**
 * 验证 PnL 与 ArbiTrade-1 一致：net = legA.usdtChange + legB.usdtChange，gross = net + fees
 */
import assert from 'node:assert/strict';
import {
  buildLegPnl,
  calcTradePnlFromLegs,
  calcTradeGrossFromLegs,
  sumLegFees
} from '../arbitrage/execution/cex-leg-pnl.js';
import { assertLegPnlConsistency } from '../arbitrage/execution/result-reporter.js';

function makeFill({ aSide, bSide, qty, aPx, bPx, aFee, bFee }) {
  const aQuote = qty * aPx;
  const bQuote = qty * bPx;
  const aLeg = buildLegPnl({
    exchange: 'binance',
    side: aSide,
    filledQty: qty,
    order: { cumQuote: aQuote, avgPrice: aPx },
    trades: [{ quoteQty: aQuote, qty, fee: aFee, feeAsset: 'USDT' }]
  });
  const bLeg = buildLegPnl({
    exchange: 'gate',
    side: bSide,
    filledQty: qty,
    order: { cumQuote: bQuote, avgPrice: bPx },
    trades: [{ quoteQty: bQuote, baseQty: qty, fee: bFee, feeAsset: 'USDT' }]
  });
  return { aLeg, bLeg, aFilledQty: qty, bFilledQty: qty, pnlComplete: true };
}

// BTW open -a+b（用户 CSV 旧列 gross=0.0186 fee=0.015735 net=0.002865）
{
  const fill = makeFill({
    aSide: 'sell',
    bSide: 'buy',
    qty: 200,
    aPx: 0.043756,
    bPx: 0.043663,
    aFee: 0.0035,
    bFee: 0.0122
  });
  const net = calcTradePnlFromLegs(fill);
  const gross = calcTradeGrossFromLegs(fill);
  const fees = sumLegFees(fill);
  assert.ok(Math.abs(net - 0.0029) < 0.0002, `net ${net}`);
  assert.ok(Math.abs(gross - 0.0186) < 0.0002, `gross ${gross}`);
  assert.ok(Math.abs(fees - 0.0157) < 0.0002, `fees ${fees}`);
  assert.ok(Math.abs((fill.aLeg.usdtChange + fill.bLeg.usdtChange) - net) < 1e-9);
  assert.ok(Math.abs(gross - fees - net) < 1e-9);
  assert.equal(assertLegPnlConsistency(fill, net).ok, true);
}

// BTW close +a-b（用户 CSV 旧列 gross=-0.0404 fee=0.015743 net=-0.056143）
{
  const fill = makeFill({
    aSide: 'buy',
    bSide: 'sell',
    qty: 200,
    aPx: 0.043831,
    bPx: 0.043629,
    aFee: 0.0035,
    bFee: 0.0122
  });
  const net = calcTradePnlFromLegs(fill);
  const gross = calcTradeGrossFromLegs(fill);
  assert.ok(Math.abs(net + 0.0561) < 0.0002, `net ${net}`);
  assert.ok(Math.abs(gross + 0.0404) < 0.0002, `gross ${gross}`);
  assert.ok(Math.abs((fill.aLeg.usdtChange + fill.bLeg.usdtChange) - net) < 1e-9);
  assert.equal(assertLegPnlConsistency(fill, net).ok, true);
}

console.log('test-cex-leg-pnl: OK');
