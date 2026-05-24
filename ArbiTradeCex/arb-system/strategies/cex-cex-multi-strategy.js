#!/usr/bin/env node
/**
 * CEX-CEX 多币种策略入口（对标 strategies/30-token-multi-strategy.js）
 */
import { startCexCexArbitrage } from '../arbitrage/task-manager/task-sdk.js';
import { loadConfig } from '../config/global-config.js';

function parseArgs(argv) {
  let mode = 'dry';
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--live') mode = 'live';
    else if (argv[i] === '--dry') mode = 'dry';
  }
  return { mode };
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig();
  const tradingEnabled = args.mode === 'live';
  const symbols = config.strategy.symbols || [];

  if (!symbols.length) {
    throw new Error(
      'no tradable symbols resolved; run npm run build:symbols-min-qty and ensure symbols_config.json intersects min-order-qty.json'
    );
  }

  if (tradingEnabled && config.strategy.useMockAccount) {
    throw new Error('useMockAccount is dry-run only; set useMockAccount=false in config.json before live');
  }

  if (tradingEnabled) {
    console.warn('[strategy] LIVE trading enabled');
  } else {
    console.log('[strategy] dry-run (simulated orders). Use npm run live for real orders.');
    if (config.strategy.useMockAccount) {
      const bal = Number(config.strategy.mockBalanceUsdt) || 10000;
      console.log(`[strategy] mock account enabled: ${bal} USDT per exchange (no API balance needed)`);
    }
  }

  console.log(`[strategy] symbols (${symbols.length}): ${symbols.join(', ')}`);

  const mgr = await startCexCexArbitrage({
    config,
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
