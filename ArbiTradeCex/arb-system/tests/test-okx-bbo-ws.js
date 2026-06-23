import assert from 'node:assert/strict';
import { parseOkxWsBookPayload, OKX_BBO_WS_CHANNEL } from '../cex/adapters/okx-adapter.js';

assert.equal(OKX_BBO_WS_CHANNEL, 'bbo-tbt');

const bbo = parseOkxWsBookPayload({
  arg: { channel: 'bbo-tbt', instId: 'BTC-USDT-SWAP' },
  data: [{
    asks: [['50001', '10', '0', '1']],
    bids: [['50000', '12', '0', '1']],
    ts: '1670324386802'
  }]
});
assert.equal(bbo.instId, 'BTC-USDT-SWAP');
assert.equal(bbo.bid, 50000);
assert.equal(bbo.ask, 50001);
assert.equal(bbo.bidQty, 12);
assert.equal(bbo.serverTs, 1670324386802);

const tickers = parseOkxWsBookPayload({
  arg: { channel: 'tickers', instId: 'ETH-USDT-SWAP' },
  data: [{
    instId: 'ETH-USDT-SWAP',
    bidPx: '3000.1',
    askPx: '3000.2',
    ts: '1670324386802'
  }]
});
assert.equal(tickers.bid, 3000.1);
assert.equal(tickers.ask, 3000.2);

console.log('test-okx-bbo-ws: ok');
