/**
 * 缓存预检：对齐 ArbiTrade-1，不发 REST
 */
import assert from 'node:assert/strict';
import { AccountCache } from '../arbitrage/cache/account-cache.js';
import { ReservationManager } from '../arbitrage/cache/reservation-manager.js';
import { checkOrderPreconditionsFromCache } from '../cex/utils/check-order-preconditions.js';

const cache = new AccountCache();
cache.seedMock({ balanceUsdt: 500 });
cache.setPosition('binance', 'SIRENUSDT', -10);
cache.setPosition('gate', 'SIRENUSDT', 10);

const rm = new ReservationManager({ accountCache: cache, ttlMs: 30000 });

// tryReserve 后：余额复检跳过，平仓持仓仍从缓存校验
const closeCheck = checkOrderPreconditionsFromCache(cache, {
  exchange: 'binance',
  symbol: 'SIRENUSDT',
  side: 'buy',
  amount: 6,
  reduceOnly: true,
  reservationManager: rm,
  trustReservation: true
});
assert.equal(closeCheck.overall, true, 'binance close buy against short');

const gateClose = checkOrderPreconditionsFromCache(cache, {
  exchange: 'gate',
  symbol: 'SIRENUSDT',
  side: 'sell',
  amount: 6,
  gateAmount: 0.06,
  quantoMultiplier: 100,
  reduceOnly: true,
  reservationManager: rm,
  trustReservation: true
});
assert.equal(gateClose.overall, true, 'gate close sell against long');

// 无缓存时应拒绝
const emptyCache = new AccountCache();
const noCache = checkOrderPreconditionsFromCache(emptyCache, {
  exchange: 'binance',
  symbol: 'BTCUSDT',
  side: 'sell',
  amount: 0.001,
  estimatedPrice: 90000,
  trustReservation: true
});
assert.equal(noCache.overall, false);
assert.match(noCache.balanceCheck.reason, /缓存未初始化/);

// 未预占时：按可用余额（扣预留）校验
const openCheck = checkOrderPreconditionsFromCache(cache, {
  exchange: 'gate',
  symbol: 'BTCUSDT',
  side: 'sell',
  amount: 1,
  gateAmount: 0.01,
  quantoMultiplier: 100,
  estimatedPrice: 1,
  reservationManager: rm,
  trustReservation: false
});
assert.equal(openCheck.overall, true, 'gate margin from cache without REST');

console.log('test-cache-preconditions: OK');
