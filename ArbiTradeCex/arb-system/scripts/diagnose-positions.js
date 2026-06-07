#!/usr/bin/env node
/**
 * 诊断 Binance/Gate 持仓与 accountCache 是否一致
 * 用法: node scripts/diagnose-positions.js [SIRENUSDT]
 */
import 'dotenv/config';
import { CexManager } from '../cex/manager.js';
import { AccountCache } from '../arbitrage/cache/account-cache.js';
import { loadConfig } from '../config/global-config.js';

function compact(symbol) {
  return String(symbol).replace(/[-_]/g, '');
}

async function main() {
  const filter = process.argv[2] ? compact(process.argv[2]) : null;
  const config = loadConfig();
  const cex = await CexManager.createDefault(config.strategy);

  console.log('=== REST 原始持仓 ===');
  for (const ex of ['binance', 'gate']) {
    const rows = await cex.getPositions(ex, { silent: true });
    const list = (rows || []).filter((p) => !filter || compact(p.symbol) === filter);
    console.log(`\n[${ex}] ${list.length} 条${filter ? ` (${filter})` : ''}`);
    for (const p of list) {
      console.log(
        `  ${p.symbol} qty=${p.qty} contracts=${p.contracts ?? 'n/a'}`
        + ` side=${p.side} entry=${p.entryPrice}`
      );
    }
    if (filter && list.length === 0) {
      console.log(`  (无 ${filter} 持仓)`);
    }
  }

  const cache = new AccountCache();
  await cache.refreshFromCexManager(cex);
  console.log('\n=== accountCache 刷新后 ===');
  const symbols = filter ? [filter] : (config.strategy.symbols || []).map(compact);
  for (const sym of symbols) {
    const a = cache.getPosition('binance', sym);
    const b = cache.getPosition('gate', sym);
    if (Math.abs(a) < 1e-12 && Math.abs(b) < 1e-12) continue;
    console.log(`  ${sym}: binance=${a} gate=${b}`);
  }

  await cex.disconnectAll();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
