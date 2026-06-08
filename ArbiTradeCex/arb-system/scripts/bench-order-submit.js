#!/usr/bin/env node
/**
 * 测量 placeOrder（真正提交到交易所）REST 往返耗时
 *
 * 用法:
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg both --rounds 3
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg binance --rounds 5 --confirm
 *   node scripts/bench-order-submit.js --symbol SIRENUSDT --leg both --confirm --reduce-only --side sell
 *
 * 不加 --confirm 只预览参数，不会真下单。
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CexManager } from '../cex/manager.js';
import { loadConfig, getRootDir } from '../config/global-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    symbol: 'SIRENUSDT',
    leg: 'both',
    rounds: 1,
    confirm: false,
    reduceOnly: false,
    side: 'buy'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--confirm') out.confirm = true;
    else if (a === '--reduce-only') out.reduceOnly = true;
    else if (a === '--symbol') out.symbol = String(argv[++i] || '').toUpperCase();
    else if (a === '--leg') out.leg = String(argv[++i] || 'both').toLowerCase();
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

async function loadSymbolLimits(symbol, minQtyJsonPath) {
  const text = await fs.readFile(minQtyJsonPath, 'utf8');
  const json = JSON.parse(text);
  const key = compact(symbol);
  const row = json.symbols?.[key];
  if (!row) throw new Error(`min-order-qty.json 无 ${key}`);
  return row;
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

function buildOrders({ symbol, limits, side, reduceOnly }) {
  const binanceQty = Number(limits.binance?.minQty) || Number(limits.binance?.stepSize) || 1;
  const gateSize = Number(limits.gate?.gateOrderSizeMin) || Number(limits.gate?.stepSize) || 1;
  const gateDecimal = Boolean(limits.gate?.enableDecimal);
  const positionDirection = side === 'sell' ? '-a+b' : '+a-b';
  const binancePositionSide = positionDirection === '-a+b' ? 'SHORT' : 'LONG';

  return {
    binance: {
      symbol,
      side,
      type: 'market',
      amount: binanceQty,
      stepSize: limits.binance?.stepSize,
      reduceOnly,
      positionDirection,
      positionSide: binancePositionSide
    },
    gate: {
      symbol,
      side,
      type: 'market',
      amount: gateSize,
      decimalSize: gateDecimal,
      reduceOnly
    },
    meta: { binanceQty, gateSize, gateDecimal }
  };
}

function printHelp() {
  console.log(`
测量 placeOrder REST 提交耗时（与实盘 OrderExecutor 同一接口）

选项:
  --symbol SIRENUSDT   交易对（默认 SIRENUSDT）
  --leg binance|gate|both  测哪条腿（默认 both，并行同实盘）
  --rounds N           重复次数（默认 1）
  --side buy|sell      买卖方向（默认 buy）
  --reduce-only        只减仓（平仓）
  --confirm            必须加才会真下单

示例（先预览）:
  node scripts/bench-order-submit.js --symbol SIRENUSDT --leg both --rounds 3

示例（真下单，最小量）:
  node scripts/bench-order-submit.js --symbol SIRENUSDT --leg both --rounds 3 --confirm
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const rootDir = getRootDir();
  const minQtyPath = path.isAbsolute(config.strategy.minQtyJson)
    ? config.strategy.minQtyJson
    : path.resolve(rootDir, config.strategy.minQtyJson);

  const symbol = compact(args.symbol);
  const limits = await loadSymbolLimits(symbol, minQtyPath);
  const orders = buildOrders({
    symbol,
    limits,
    side: args.side,
    reduceOnly: args.reduceOnly
  });

  console.log('=== placeOrder 提交耗时测试 ===');
  console.log(`symbol=${symbol} leg=${args.leg} rounds=${args.rounds} side=${args.side} reduceOnly=${args.reduceOnly}`);
  console.log(`Binance qty=${orders.meta.binanceQty}  Gate size=${orders.meta.gateSize} decimal=${orders.meta.gateDecimal}`);
  console.log(args.confirm ? '模式: 真实下单' : '模式: 预览（加 --confirm 才会真下单）');
  console.log('');

  if (!args.confirm) {
    console.log('将发送的订单参数:');
    if (args.leg === 'binance' || args.leg === 'both') {
      console.log('  [binance]', JSON.stringify(orders.binance));
    }
    if (args.leg === 'gate' || args.leg === 'both') {
      console.log('  [gate]', JSON.stringify(orders.gate));
    }
    return;
  }

  if (!process.env.BINANCE_API_KEY || !process.env.GATE_API_KEY) {
    throw new Error('需要 .env 中配置 BINANCE_API_KEY / GATE_API_KEY');
  }

  const cex = await CexManager.createDefault(config.strategy);
  const binanceSamples = [];
  const gateSamples = [];
  const parallelSamples = [];

  for (let i = 0; i < args.rounds; i += 1) {
    if (args.leg === 'both') {
      const wall0 = Date.now();
      const [aRes, bRes] = await Promise.all([
        timedPlace(cex, 'binance', orders.binance),
        timedPlace(cex, 'gate', orders.gate)
      ]);
      const wallMs = Date.now() - wall0;
      parallelSamples.push(wallMs);
      if (aRes.ok) binanceSamples.push(aRes.ms);
      else console.warn(`[round ${i + 1}] Binance 失败 ${aRes.ms}ms: ${aRes.error}`);
      if (bRes.ok) gateSamples.push(bRes.ms);
      else console.warn(`[round ${i + 1}] Gate 失败 ${bRes.ms}ms: ${bRes.error}`);
      console.log(
        `[round ${i + 1}] 并行墙钟 ${wallMs}ms`
        + ` | Binance ${aRes.ok ? `${aRes.ms}ms id=${aRes.orderId} filled=${aRes.filled}` : `FAIL ${aRes.error}`}`
        + ` | Gate ${bRes.ok ? `${bRes.ms}ms id=${bRes.orderId} filled=${bRes.filled}` : `FAIL ${bRes.error}`}`
      );
    } else if (args.leg === 'binance') {
      const res = await timedPlace(cex, 'binance', orders.binance);
      if (res.ok) binanceSamples.push(res.ms);
      console.log(`[round ${i + 1}] Binance ${res.ok ? `${res.ms}ms id=${res.orderId}` : `FAIL ${res.error}`}`);
    } else if (args.leg === 'gate') {
      const res = await timedPlace(cex, 'gate', orders.gate);
      if (res.ok) gateSamples.push(res.ms);
      console.log(`[round ${i + 1}] Gate ${res.ok ? `${res.ms}ms id=${res.orderId}` : `FAIL ${res.error}`}`);
    }
    if (i < args.rounds - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log('\n=== 汇总 (ms) ===');
  if (parallelSamples.length) {
    const s = summarize(parallelSamples);
    console.log(`并行墙钟(两腿同时): min=${s.min} p50=${s.p50} avg=${s.avg} max=${s.max} (n=${s.count})`);
  }
  if (binanceSamples.length) {
    const s = summarize(binanceSamples);
    console.log(`Binance placeOrder: min=${s.min} p50=${s.p50} avg=${s.avg} max=${s.max} (n=${s.count})`);
  }
  if (gateSamples.length) {
    const s = summarize(gateSamples);
    console.log(`Gate placeOrder: min=${s.min} p50=${s.p50} avg=${s.avg} max=${s.max} (n=${s.count})`);
  }

  await cex.disconnectAll();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
