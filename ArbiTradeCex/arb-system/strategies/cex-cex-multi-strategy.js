#!/usr/bin/env node
/**
 * CEX-CEX 多币种策略入口（对标 strategies/30-token-multi-strategy.js）
 */
import { startCexCexArbitrage } from '../arbitrage/task-manager/task-sdk.js';
import { loadConfig, getRootDir } from '../config/global-config.js';
import { startProcessLifecycleLogging } from '../common/monitoring/process-lifecycle.js';

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
  const strat = config.strategy;
  const tradingEnabled = args.mode === 'live';
  const symbols = strat.symbols || [];

  const lifecycle = startProcessLifecycleLogging({
    rootDir: getRootDir(),
    logPath: strat.processHealthLog || 'logs/process-health.jsonl',
    lastExitPath: strat.processLastExitJson || 'logs/last-exit.json',
    intervalMs: strat.processHealthIntervalMs ?? 30000,
    persistHeartbeat: strat.processHealthHeartbeat === true,
    meta: { mode: args.mode, symbolCount: symbols.length }
  });

  if (!symbols.length) {
    throw new Error(
      'no tradable symbols resolved; run npm run build:symbols-min-qty to generate config/min-order-qty.json'
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
    lifecycle.logEvent('SHUTDOWN_BEGIN', { signal: sig });
    await mgr.stop();
    lifecycle.markShutdown({ signal: sig });
    process.exit(0);
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch((e) => console.error('[strategy] shutdown:', e)); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch((e) => console.error('[strategy] shutdown:', e)); });
}

main().catch((err) => {
  console.error('[strategy] fatal:', err);
  process.exit(1);
});
