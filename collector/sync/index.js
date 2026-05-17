/**
 * 同步服务入口（常驻）
 */
import syncService from './redis-sync-service.js';

async function main() {
  try {
    await syncService.initialize();
    const first = await syncService.runOnce();
    console.log(`[Sync] first run synced=${first.synced}, trimmed=${first.trimmed}`);
    syncService.start();
  } catch (error) {
    console.error('[Sync] fatal:', error);
    process.exit(1);
  }
}

async function shutdown(sig) {
  console.log(`[${sig}] stopping sync service...`);
  await syncService.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main();
