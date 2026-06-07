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

console.log('test-account-cache-refresh: OK');
