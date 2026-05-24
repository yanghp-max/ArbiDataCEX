#!/usr/bin/env node
/**
 * CEX-CEX 多币种策略入口（对标 strategies/30-token-multi-strategy.js）
 */
import { startCexCexArbitrage } from '../arbitrage/task-manager/task-sdk.js';
import { loadConfig } from '../config/global-config.js';

function parseArgs(argv) {
  const out = { live: false, symbols: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--live') out.live = true;
    if (argv[i] === '--symbols' && argv[i + 1]) {
      out.symbols = argv[i + 1].split(',').map((s) => s.trim().toUpperCase());
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const tradingEnabled = args.live || process.env.TRADING_ENABLED === 'true';

  if (tradingEnabled && config.strategy.useMockAccount) {
    throw new Error('useMockAccount is dry-run only; disable it before --live');
  }

  if (tradingEnabled) {
    console.warn('[strategy] LIVE trading enabled');
  } else {
    console.log('[strategy] dry-run (simulated orders). Use --live for real orders.');
    if (config.strategy.useMockAccount) {
      const bal = Number(config.strategy.mockBalanceUsdt) || 10000;
      console.log(`[strategy] mock account enabled: ${bal} USDT per exchange (no API balance needed)`);
    }
  }

  const mgr = await startCexCexArbitrage({
    config,
    symbols: args.symbols || undefined,
    tradingEnabled
  });

  const shutdown = async (sig) => {
    console.log(`[strategy] ${sig} stopping...`);
    await mgr.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[strategy] fatal:', err);
  process.exit(1);
});
