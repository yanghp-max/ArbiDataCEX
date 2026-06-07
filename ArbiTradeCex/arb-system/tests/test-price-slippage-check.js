import assert from 'node:assert/strict';
import {
  tickPriceSlippagePass,
  legPriceSlippageOk,
  tickPriceSnapshotMatch
} from '../arbitrage/risk/risk-manager.js';

const snap = {
  symbol: 'SIRENUSDT',
  aBid: 1.0,
  aAsk: 1.01,
  bBid: 0.99,
  bAsk: 1.0
};

assert.equal(
  tickPriceSnapshotMatch(snap, { ...snap }).valueOf() !== false,
  true
);

const within = tickPriceSlippagePass(snap, { ...snap }, '-a+b', {
  binanceSlippageBps: 10,
  gateSlippageBps: 10
});
assert.equal(within.ok, true, '快照一致应通过');

const binanceSellBad = tickPriceSlippagePass(
  snap,
  { ...snap, aBid: 0.998 },
  '-a+b',
  { binanceSlippageBps: 10, gateSlippageBps: 10 }
);
assert.equal(binanceSellBad.ok, false, 'Binance 卖价下滑超 10bps 应拒绝');
assert.match(binanceSellBad.reason, /Binance.*卖价下滑/);

const gateBuyBad = tickPriceSlippagePass(
  snap,
  { ...snap, bAsk: 1.002 },
  '-a+b',
  { binanceSlippageBps: 10, gateSlippageBps: 10 }
);
assert.equal(gateBuyBad.ok, false, 'Gate 买价上涨超 10bps 应拒绝');
assert.match(gateBuyBad.reason, /Gate.*买价上涨/);

const binanceSellOk = tickPriceSlippagePass(
  snap,
  { ...snap, aBid: 0.999 },
  '-a+b',
  { binanceSlippageBps: 10, gateSlippageBps: 10 }
);
assert.equal(binanceSellOk.ok, true, 'Binance 卖价下滑 10bps 内应通过');

const plusDir = tickPriceSlippagePass(
  snap,
  { ...snap, aAsk: 1.011, bBid: 0.988 },
  '+a-b',
  { binanceSlippageBps: 10, gateSlippageBps: 10 }
);
assert.equal(plusDir.ok, false, '+a-b 两腿不利变动超阈应拒绝');

const favorable = legPriceSlippageOk({
  side: 'sell',
  snapPrice: 1.0,
  freshPrice: 1.005,
  slippageBps: 4,
  legLabel: 'Binance'
});
assert.equal(favorable.ok, true, '卖价上涨（有利）应通过');

console.log('test-price-slippage-check: OK');
