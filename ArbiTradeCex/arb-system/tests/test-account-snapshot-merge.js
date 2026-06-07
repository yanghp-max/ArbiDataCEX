import assert from 'node:assert/strict';
import { AccountCache } from '../arbitrage/cache/account-cache.js';
import { buildAccountSnapshot } from '../arbitrage/services/account-snapshot.js';

class MockQuoteAggregator {
  buildTick() {
    return null;
  }
}

const cache = new AccountCache();
cache.setTrackedSymbols(['SIRENUSDT']);
cache.setPosition('binance', 'SIRENUSDT', -10);
cache.setPosition('gate', 'SIRENUSDT', 10);
cache.setBalance('binance', { total: 100, available: 100 });
cache.setBalance('gate', { total: 100, available: 100 });

let fullReplaceUsed = false;
const cexManager = {
  getBalance: async () => [{ currency: 'USDT', total: 100, available: 100 }],
  getPositions: async (exchange) => {
    if (exchange === 'binance') {
      return [{ symbol: 'SIRENUSDT', qty: -10 }];
    }
    return [];
  },
  refreshFromCexManager: null
};

const origRefresh = AccountCache.prototype.refreshFromCexManager;
AccountCache.prototype.refreshFromCexManager = async function refreshMock(_cex, { fullReplace } = {}) {
  fullReplaceUsed = fullReplace;
  await this.refreshExchange(cexManager, 'binance', { force: true, fullReplace: false });
  await this.refreshExchange(cexManager, 'gate', { force: true, fullReplace: false });
};

try {
  await buildAccountSnapshot({
    accountCache: cache,
    cexManager,
    quoteAggregator: new MockQuoteAggregator(),
    symbols: ['SIRENUSDT'],
    forceRefresh: true
  });

  assert.equal(fullReplaceUsed, false, 'Dashboard 刷新应使用 merge 而非 fullReplace');
  assert.equal(cache.getPosition('binance', 'SIRENUSDT'), -10);
  assert.equal(cache.getPosition('gate', 'SIRENUSDT'), 10, 'Gate REST 缺席时不应被清 0');

  console.log('test-account-snapshot-merge: OK');
} finally {
  AccountCache.prototype.refreshFromCexManager = origRefresh;
}
