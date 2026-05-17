/**
 * 单次同步验证脚本
 * 用法:
 *  node collector/sync/run-once.js
 *  node collector/sync/run-once.js BTCUSDT,ETHUSDT
 */
import syncService from './redis-sync-service.js';

async function main() {
  const arg = process.argv[2] || '';
  const targetSymbols = arg
    ? arg.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  try {
    await syncService.initialize();
    const result = await syncService.runOnce(targetSymbols);
    console.log('[SyncOnce] result:', result);
  } catch (error) {
    console.error('[SyncOnce] failed:', error);
    process.exitCode = 1;
  } finally {
    await syncService.shutdown();
  }
}

main();
