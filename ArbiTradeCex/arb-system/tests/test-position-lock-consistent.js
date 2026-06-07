import assert from 'node:assert/strict';
import {
  isPositionLockConsistent,
  isOneSidedOrphan
} from '../arbitrage/services/spread-calculator.js';

assert.equal(isPositionLockConsistent('-a+b', 200, 0), false, 'A 多 200 与 -a+b 锁不一致');
assert.equal(isPositionLockConsistent('+a-b', -10, 0), false, 'A 空 与 +a-b 锁不一致');
assert.equal(isPositionLockConsistent('-a+b', -10, 0), true, '单腿空 A 仍与 -a+b 锁一致');
assert.equal(isPositionLockConsistent('+a-b', 10, 0), true, '单腿多 A 仍与 +a-b 锁一致');
assert.equal(isOneSidedOrphan(200, 0), true);

console.log('test-position-lock-consistent: OK');
