#!/usr/bin/env node
/**
 * 测量 placeOrder（真正提交到交易所）REST 往返耗时
 *
 * 用法:
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg a --rounds 3
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg gate --rounds 5 --confirm
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg b --confirm --reduce-only --side sell
 *   node scripts/bench-order-submit.js --symbol BTCUSDT --leg binance --rounds 5 --confirm --warmup
 *
 * 不加 --confirm 只预览参数，不会真下单。
 * 每次只测一个交易所：--leg a|b|<provider>（a/b 对应 config.json adapters）。
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CexManager } from '../cex/manager.js';
import { loadConfig, getRootDir } from '../config/global-config.js';
import { resolveAdapterPair } from '../cex/adapter-pair.js';
import { isContractQuantityUnit } from '../cex/utils/leg-order-context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ENV_BY_PROVIDER = {
  binance: ['BINANCE_API_KEY', 'BINANCE_API_SECRET'],
  gate: ['GATE_API_KEY', 'GATE_API_SECRET'],
  aster: ['ASTER_API_KEY', 'ASTER_API_SECRET']
};

function parseArgs(argv) {
  const out = {
    symbol: 'SIRENUSDT',
    leg: 'a',
    rounds: 1,
    confirm: false,
    reduceOnly: false,
    side: 'buy',
    warmup: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a === '--reduce-only') out.reduceOnly = true;
    else if (a === '--warmup') out.warmup = true;
    else if (a === '--symbol') out.symbol = String(argv[++i] || '').toUpperCase();
    else if (a === '--leg') out.leg = String(argv[++i] || 'a').toLowerCase();
    else if (a === '--rounds') out.rounds = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--side') out.side = String(argv[++i] || 'buy').toLowerCase();
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function compact(symbol) {
  return String(symbol).replace(/[-_]/g, '').toUpperCase();
}

function summarize(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((s, n) => s + n, 0);
  const mid = sorted[Math.floor(sorted.length / 2)];
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
    p50: Math.round(mid)
  };
}

async function loadSymbolEntry(symbol, minQtyJsonPath) {
  const text = await fs.readFile(minQtyJsonPath, 'utf8');
  const json = JSON.parse(text);
  const key = compact(symbol);
  const row = json.symbols?.[key];
  if (!row) throw new Error(`min-order-qty.json 无 ${key}`);
  return row;
}

function resolveLegLimits(entry, legKey, provider) {
  const v2 = entry?.legs?.[legKey]?.limits;
  if (v2) return v2;
  const fromProviders = entry?.providers?.[provider];
  if (fromProviders) return fromProviders;
  if (provider === 'binance' || legKey === 'A') return entry.binance || null;
  if (provider === 'gate') return entry.gate || null;
  if (provider === 'aster') return entry.aster || null;
  return entry[provider] || null;
}

function buildLegOrder({ legKey, provider, limits, symbol, side, reduceOnly }) {
  if (!limits) throw new Error(`leg ${legKey} limits missing`);

  const positionDirection = side === 'sell' ? '-a+b' : '+a-b';
  const binancePositionSide = positionDirection === '-a+b' ? 'SHORT' : 'LONG';
  const isLegA = legKey === 'A';

  if (isContractQuantityUnit(limits)) {
    const contracts = Number(limits.gateOrderSizeMin ?? limits.minQty ?? limits.stepSize) || 1;
    return {
      order: {
        symbol,
        side,
        type: 'market',
        amount: contracts,
        decimalSize: Boolean(limits.enableDecimal),
        reduceOnly
      },
      meta: { qty: contracts * (Number(limits.quantoMultiplier) || 1), orderAmount: contracts, unit: 'contract' }
    };
  }

  const qty = Number(limits.minQty ?? limits.stepSize) || 1;
  const order = {
    symbol,
    side,
    type: 'market',
    amount: qty,
    reduceOnly
  };

  if (isLegA && (provider === 'binance' || provider === 'aster')) {
    order.stepSize = limits.stepSize;
    order.positionDirection = positionDirection;
    order.positionSide = binancePositionSide;
  }

  return { order, meta: { qty, orderAmount: qty, unit: 'base' } };
}

function resolveLegTarget(legArg, pair) {
  const raw = String(legArg || 'a').toLowerCase();
  if (raw === 'both') {
    throw new Error('--leg both 已移除，请指定单个交易所：--leg a|--leg b|--leg binance 等');
  }
  if (raw === 'a') return { legKey: 'A', provider: pair.providerA };
  if (raw === 'b') return { legKey: 'B', provider: pair.providerB };
  if (raw === pair.providerA) return { legKey: 'A', provider: pair.providerA };
  if (raw === pair.providerB) return { legKey: 'B', provider: pair.providerB };
  if (raw === 'binance' || raw === 'gate' || raw === 'aster') {
    const legKey = raw === pair.providerA ? 'A' : raw === pair.providerB ? 'B' : (raw === 'binance' ? 'A' : 'B');
    return { legKey, provider: raw };
  }
  throw new Error(`--leg 无效: ${legArg}（当前 pair ${pair.providerA}/${pair.providerB}）`);
}

function assertEnvForProvider(provider) {
  const missing = [];
  for (const key of ENV_BY_PROVIDER[provider] || []) {
    if (!String(process.env[key] || '').trim()) missing.push(`${provider}:${key}`);
  }
  if (missing.length) {
    throw new Error(`缺少环境变量: ${missing.join(', ')}`);
  }
}

async function timedPlace(cex, exchange, orderData) {
  const t0 = Date.now();
  try {
    const order = await cex.placeOrder(exchange, orderData);
    return {
      ok: true,
      ms: Date.now() - t0,
      orderId: order.orderId,
      filled: order.filled,
      avgPrice: order.avgPrice,
      status: order.status
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: err.message
    };
  }
}

async function warmupProvider(cex, provider) {
  console.log(`预热 REST keep-alive: ${provider}`);
  try {
    await cex.getBalance(provider, { silent: true });
    console.log(`  [warmup] ${provider} getBalance ok`);
  } catch (err) {
    console.warn(`  [warmup] ${provider} skipped: ${err.message}`);
  }
  console.log('');
}

function printHelp() {
  console.log(`
测量 placeOrder REST 提交耗时（与实盘 OrderExecutor 同一 CexManager 接口）

选项:
  --symbol SIRENUSDT   交易对（默认 SIRENUSDT）
  --leg a|b|binance|gate|aster  测哪个交易所（默认 a）
  --rounds N           重复次数（默认 1）
  --side buy|sell      买卖方向（默认 buy）
  --reduce-only        只减仓（平仓）
  --warmup             正式测前拉一次 getBalance 预热 keep-alive
  --confirm            必须加才会真下单

示例（先预览）:
  node scripts/bench-order-submit.js --symbol SIRENUSDT --leg a --rounds 3
  node scripts/bench-order-submit.js --symbol SIRENUSDT --leg gate

示例（真下单，最小量）:
  node scripts/bench-order-submit.js --symbol SIRENUSDT --leg binance --rounds 3 --confirm --warmup
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const pair = resolveAdapterPair(config);
  const legTarget = resolveLegTarget(args.leg, pair);

  const rootDir = getRootDir();
  const minQtyPath = path.isAbsolute(config.strategy.minQtyJson)
    ? config.strategy.minQtyJson
    : path.resolve(rootDir, config.strategy.minQtyJson);

  const symbol = compact(args.symbol);
  const entry = await loadSymbolEntry(symbol, minQtyPath);

  const leg = buildLegOrder({
    legKey: legTarget.legKey,
    provider: legTarget.provider,
    limits: resolveLegLimits(entry, legTarget.legKey, legTarget.provider),
    symbol,
    side: args.side,
    reduceOnly: args.reduceOnly
  });

  console.log('=== placeOrder 提交耗时测试 ===');
  console.log(`pair=${pair.providerA}/${pair.providerB} symbol=${symbol} leg=${legTarget.provider} rounds=${args.rounds}`);
  console.log(`side=${args.side} reduceOnly=${args.reduceOnly}`);
  console.log(`${legTarget.provider}: unit=${leg.meta.unit} qty≈${leg.meta.qty} orderAmount=${leg.meta.orderAmount}`);
  console.log(args.confirm ? '模式: 真实下单' : '模式: 预览（加 --confirm 才会真下单）');
  console.log('');

  if (!args.confirm) {
    console.log('将发送的订单参数:');
    console.log(`  [${legTarget.provider}]`, JSON.stringify(leg.order));
    return;
  }

  assertEnvForProvider(legTarget.provider);

  const cex = await CexManager.createDefault(config.strategy, {
    providers: [legTarget.provider],
    enablePublicStream: false
  });

  if (args.warmup) {
    await warmupProvider(cex, legTarget.provider);
  }

  const samples = [];

  for (let i = 0; i < args.rounds; i += 1) {
    const res = await timedPlace(cex, legTarget.provider, leg.order);
    if (res.ok) samples.push(res.ms);
    console.log(
      `[round ${i + 1}] ${legTarget.provider} `
      + `${res.ok ? `${res.ms}ms id=${res.orderId} filled=${res.filled}` : `FAIL ${res.error}`}`
    );

    if (i < args.rounds - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log('\n=== 汇总 (ms) ===');
  if (samples.length) {
    const s = summarize(samples);
    console.log(`${legTarget.provider} placeOrder: min=${s.min} p50=${s.p50} avg=${s.avg} max=${s.max} (n=${s.count})`);
    if (s.count >= 2) {
      const rest = summarize(samples.slice(1));
      console.log(`  → 去掉第1单后 p50≈${rest.p50}ms（keep-alive 预热后通常更低）`);
    }
  }

  await cex.disconnectAll();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
