import assert from 'node:assert/strict';
import { AccountCache } from '../arbitrage/cache/account-cache.js';

const cache = new AccountCache();
cache.setPosition('gate', 'SIRENUSDT', 10);

const cexManager = {
  async getBalance() {
    return [{ currency: 'USDT', total: 100, available: 100 }];
  },
  async getPositions() {
    throw new Error('network down');
  }
};

const res = await cache.refreshExchange(cexManager, 'gate', { force: true });
assert.equal(res.ok, false);
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10, 'REST 失败应保留旧持仓');

const cexOk = {
  async getBalance() {
    return [{ currency: 'USDT', total: 100, available: 100 }];
  },
  async getPositions() {
    return [{ symbol: 'SIRENUSDT', qty: 0 }];
  }
};

await cache.refreshExchange(cexOk, 'gate', { force: true, fullReplace: true });
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 0);

cache.setPosition('gate', 'SIRENUSDT', 10);
const cexPartial = {
  async getBalance() {
    return [{ currency: 'USDT', total: 100, available: 100 }];
  },
  async getPositions() {
    return [{ symbol: 'HOMEUSDT', qty: 800 }];
  }
};
await cache.refreshExchange(cexPartial, 'gate', { force: true, fullReplace: false });
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10, 'merge 模式：REST 未返回的 symbol 应保留');
assert.equal(cache.getPosition('gate', 'HOMEUSDT'), 800);

cache.setPosition('binance', 'HOMEUSDT', 200);
cache.setPosition('gate', 'HOMEUSDT', 0);
const oldTs = Date.now() - 60_000;
cache.positionCache.set('binance:HOMEUSDT', { qty: 200, updatedAtMs: oldTs });

const cexFlat = {
  async getPositions(exchange) {
    if (exchange === 'binance') return [];
    return [];
  }
};
await cache.reconcileSymbolPositions(cexFlat, 'HOMEUSDT', { graceMs: 5000 });
assert.equal(cache.getPosition('binance', 'HOMEUSDT'), 0, 'REST 无仓应清掉陈旧 Binance 缓存');
assert.equal(cache.getPosition('gate', 'HOMEUSDT'), 0);

cache.setPosition('gate', 'SIRENUSDT', 10);
const recentTs = Date.now() - 1000;
cache.positionCache.set('gate:SIRENUSDT', { qty: 10, updatedAtMs: recentTs });
const cexGateLag = {
  async getPositions(exchange) {
    if (exchange === 'binance') return [{ symbol: 'SIRENUSDT', qty: -10 }];
    return [];
  }
};
await cache.reconcileSymbolPositions(cexGateLag, 'SIRENUSDT', { graceMs: 8000 });
assert.equal(cache.getPosition('binance', 'SIRENUSDT'), -10);
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10, 'Gate REST 延迟时 grace 内保留本地腿');

cache.setPosition('binance', 'HOMEUSDT', 200);
const recentHomeTs = Date.now() - 1000;
cache.positionCache.set('binance:HOMEUSDT', { qty: 200, updatedAtMs: recentHomeTs });
const cexBothFlat = {
  async getPositions() {
    return [];
  }
};
const bothAbsent = await cache.reconcileSymbolPositions(cexBothFlat, 'HOMEUSDT', { graceMs: 8000 });
assert.equal(bothAbsent.bothAbsent, true);
assert.equal(cache.getPosition('binance', 'HOMEUSDT'), 0, '两腿 REST 皆无仓时无视 grace 强制清 0');

cache.setTrackedSymbols(['HOMEUSDT', 'SIRENUSDT']);
cache.setPosition('binance', 'HOMEUSDT', 200);
cache.positionCache.set('binance:HOMEUSDT', { qty: 200, updatedAtMs: Date.now() - 60_000 });
const cexMergeClear = {
  async getBalance() {
    return [{ currency: 'USDT', total: 100, available: 100 }];
  },
  async getPositions() {
    return [];
  }
};
await cache.refreshExchange(cexMergeClear, 'binance', { force: true, fullReplace: false });
assert.equal(cache.getPosition('binance', 'HOMEUSDT'), 0, 'merge 刷新应清掉监控币种陈旧持仓');

cache.setPosition('binance', 'SIRENUSDT', 0);
cache.setPosition('gate', 'SIRENUSDT', 0);
cache.applyFillToCache('SIRENUSDT', '-a+b', {
  simulated: false,
  aFilledQty: 10,
  bFilledQty: 10,
  aSide: 'sell',
  bSide: 'buy',
  legExposure: false
});
assert.equal(cache.getPosition('binance', 'SIRENUSDT'), -10);
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10);
await cache.reconcileSymbolPositions(cexGateLag, 'SIRENUSDT', { graceMs: 0 });
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10, '成交保护期内 Gate REST 缺席不应清腿');

const cexGateLagLate = {
  async getPositions(exchange) {
    if (exchange === 'binance') return [{ symbol: 'SIRENUSDT', qty: -10 }];
    if (exchange === 'gate') return [{ symbol: 'SIRENUSDT', qty: 10 }];
    return [];
  }
};
const syncRes = await cache.syncSymbolPositionsAfterFill(cexGateLagLate, 'SIRENUSDT', {
  retries: 2,
  delayMs: 10
});
assert.equal(syncRes.hedged, true);
assert.equal(cache.getPosition('binance', 'SIRENUSDT'), -10);
assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10);

cache.setPosition('binance', 'HUSDT', -40);
cache.setPosition('gate', 'HUSDT', 40);
cache.applyFillToCache('HUSDT', '-a+b', {
  aFilledQty: 0,
  bFilledQty: 20,
  aSide: 'sell',
  bSide: 'buy',
  legExposure: true
}, { action: 'add' });
assert.equal(cache.getPosition('binance', 'HUSDT'), -40, 'add 单腿不应改变对冲仓位');
assert.equal(cache.getPosition('gate', 'HUSDT'), 40);

cache.setPosition('binance', 'HUSDT', 0);
cache.setPosition('gate', 'HUSDT', 0);
cache.applyFillToCache('HUSDT', '-a+b', {
  aFilledQty: 0,
  bFilledQty: 20,
  aSide: 'sell',
  bSide: 'buy',
  legExposure: true
}, { action: 'open' });
assert.equal(cache.getPosition('binance', 'HUSDT'), 0, 'open 单腿不应写入对冲仓位');
assert.equal(cache.getPosition('gate', 'HUSDT'), 0);

console.log('test-account-cache-refresh: OK');
