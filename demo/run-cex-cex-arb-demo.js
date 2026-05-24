import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import axios from 'axios';
import { BinanceAdapter, GateAdapter } from '../collector/cex/index.js';

dotenvConfig();

const WINDOW_MINUTES = 60;
const Z_AB_OPEN = 4;
const Z_BA_OPEN = 1;
const TOTAL_COST_PCT = 0.08;
const TICK_KEEP = 5000;
const LOOP_SLEEP_MS = 1200;
const BINANCE_FAPI_REST = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const BINANCE_PAPI_REST = process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com';
const GATE_REST = process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4';

function parseArgs(argv) {
  const out = {
    symbol: '',
    minQtyJson: path.resolve(process.cwd(), 'demo/min-order-qty.json'),
    orderUsd: 100,
    dryRun: true
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--symbol' && argv[i + 1]) {
      out.symbol = argv[i + 1].trim().toUpperCase();
      i += 1;
      continue;
    }
    if (token === '--min_qty_json' && argv[i + 1]) {
      out.minQtyJson = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--order_usd' && argv[i + 1]) {
      out.orderUsd = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--live') {
      out.dryRun = false;
      continue;
    }
  }

  if (!out.symbol) {
    throw new Error('missing --symbol, example: --symbol BTCUSDT');
  }
  if (!Number.isFinite(out.orderUsd) || out.orderUsd <= 0) {
    throw new Error('invalid --order_usd');
  }
  return out;
}

function percentile50(values) {
  if (values.length === 0) return NaN;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

function computeMad(values, median) {
  const absDev = values.map((v) => Math.abs(v - median));
  return percentile50(absDev);
}

function floorByStep(value, step) {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return 0;
  const ratio = Math.floor(value / step);
  return ratio * step;
}

function getGateContractFromSymbol(symbol) {
  if (!symbol.endsWith('USDT')) {
    throw new Error(`only USDT symbol supported, got ${symbol}`);
  }
  return `${symbol.slice(0, -4)}_USDT`;
}

function normalizeForAdapter(symbol) {
  if (symbol.includes('-')) return symbol;
  if (symbol.endsWith('USDT')) return `${symbol.slice(0, -4)}-USDT`;
  return symbol;
}

class SlidingSignal {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.items = [];
  }

  add(ts, spreadAbAdj, spreadBaAdj) {
    this.items.push({ ts, spreadAbAdj, spreadBaAdj });
    this.evict(ts);
  }

  evict(nowTs) {
    const threshold = nowTs - this.windowMs;
    while (this.items.length && this.items[0].ts < threshold) {
      this.items.shift();
    }
  }

  isWindowReady() {
    if (this.items.length < 2) return false;
    const firstTs = this.items[0].ts;
    const lastTs = this.items[this.items.length - 1].ts;
    return (lastTs - firstTs) >= this.windowMs;
  }

  computeZ() {
    if (!this.isWindowReady()) {
      return { zAb: NaN, zBa: NaN, points: this.items.length, ready: false };
    }

    const ab = this.items.map((x) => x.spreadAbAdj).filter(Number.isFinite);
    const ba = this.items.map((x) => x.spreadBaAdj).filter(Number.isFinite);
    if (ab.length < 2 || ba.length < 2) {
      return { zAb: NaN, zBa: NaN, points: Math.min(ab.length, ba.length), ready: true };
    }

    const medianAb = percentile50(ab);
    const medianBa = percentile50(ba);
    const madAb = computeMad(ab, medianAb);
    const madBa = computeMad(ba, medianBa);

    if (!Number.isFinite(madAb) || !Number.isFinite(madBa) || madAb === 0 || madBa === 0) {
      return { zAb: NaN, zBa: NaN, points: Math.min(ab.length, ba.length), ready: true };
    }

    const last = this.items[this.items.length - 1];
    const zAb = (last.spreadAbAdj - medianAb) / madAb;
    const zBa = (last.spreadBaAdj - medianBa) / madBa;
    return { zAb, zBa, points: Math.min(ab.length, ba.length), ready: true };
  }
}

function computeOrderQty({ sidePrice, orderUsd, minQty, stepSize }) {
  const raw = orderUsd / sidePrice;
  let qty = floorByStep(raw, stepSize);
  if (qty < minQty) {
    qty = minQty;
  }
  qty = floorByStep(qty, stepSize);
  if (qty < minQty) return 0;
  return qty;
}

function computeGateContracts({ qtyBase, gateCfg }) {
  if (!Number.isFinite(qtyBase) || qtyBase <= 0) return 0;
  const minContracts = Number(gateCfg.minQty);
  const step = Number(gateCfg.stepSize || 1);
  const multiplier = Number(gateCfg.quantoMultiplier || 0);
  if (!Number.isFinite(minContracts) || minContracts <= 0) return 0;

  if (Number.isFinite(multiplier) && multiplier > 0) {
    const rawContracts = qtyBase / multiplier;
    let contracts = floorByStep(rawContracts, step);
    if (contracts < minContracts) contracts = minContracts;
    contracts = floorByStep(contracts, step);
    return contracts >= minContracts ? contracts : 0;
  }

  let contracts = floorByStep(qtyBase, step);
  if (contracts < minContracts) contracts = minContracts;
  contracts = floorByStep(contracts, step);
  return contracts >= minContracts ? contracts : 0;
}

async function readMinQtyConfig(filePath, symbol) {
  const text = await fs.readFile(filePath, 'utf8');
  const json = JSON.parse(text);
  const data = json?.symbols?.[symbol];
  if (!data) {
    throw new Error(`symbol ${symbol} not found in min qty json: ${filePath}`);
  }
  if (!data.binance || !data.gate) {
    throw new Error(`invalid min qty config for ${symbol}`);
  }
  return data;
}

function buildExecutionIntent({
  direction,
  symbol,
  binanceTicker,
  gateTicker,
  minCfg,
  orderUsd
}) {
  // -a+b: Binance short + Gate long; +a-b: Binance long + Gate short
  const binancePrice = direction === '-a+b' ? binanceTicker.bid : binanceTicker.ask;
  const binanceQty = computeOrderQty({
    sidePrice: binancePrice,
    orderUsd,
    minQty: Number(minCfg.binance.minQty),
    stepSize: Number(minCfg.binance.stepSize)
  });
  if (binanceQty <= 0) return null;

  const gateContracts = computeGateContracts({
    qtyBase: binanceQty,
    gateCfg: minCfg.gate
  });
  if (gateContracts <= 0) return null;

  const gateContract = getGateContractFromSymbol(symbol);
  return {
    direction,
    binance: {
      symbol,
      side: direction === '-a+b' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: binanceQty
    },
    gate: {
      contract: gateContract,
      type: 'MARKET',
      size: direction === '-a+b' ? gateContracts : -gateContracts
    }
  };
}

function signBinanceQuery(secret, query) {
  return crypto.createHmac('sha256', secret).update(query).digest('hex');
}

async function placeBinanceOrder(order) {
  const apiKey = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error('missing BINANCE_API_KEY or BINANCE_API_SECRET');
  }

  const params = new URLSearchParams({
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    quantity: String(order.quantity),
    timestamp: String(Date.now()),
    recvWindow: '5000'
  });
  const query = params.toString();
  const signature = signBinanceQuery(secret, query);
  const url = `${BINANCE_PAPI_REST}/papi/v1/um/order?${query}&signature=${signature}`;
  const resp = await axios.post(url, null, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 15000
  });
  return resp.data;
}

function sha512Hex(input) {
  return crypto.createHash('sha512').update(input).digest('hex');
}

function signGateV4({ method, pathWithPrefix, queryString, body, secret, timestamp }) {
  const bodyHash = sha512Hex(body || '');
  const signPayload = `${method}\n${pathWithPrefix}\n${queryString}\n${bodyHash}\n${timestamp}`;
  return crypto.createHmac('sha512', secret).update(signPayload).digest('hex');
}

async function placeGateOrder(order) {
  const key = process.env.GATE_API_KEY;
  const secret = process.env.GATE_API_SECRET;
  if (!key || !secret) {
    throw new Error('missing GATE_API_KEY or GATE_API_SECRET');
  }

  const method = 'POST';
  const pathWithPrefix = '/api/v4/futures/usdt/orders';
  const queryString = '';
  const bodyObj = {
    contract: order.contract,
    size: Number(order.size),
    price: '0',
    tif: 'ioc'
  };
  const body = JSON.stringify(bodyObj);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = signGateV4({
    method,
    pathWithPrefix,
    queryString,
    body,
    secret,
    timestamp
  });

  const resp = await axios.post(`${GATE_REST}/futures/usdt/orders`, bodyObj, {
    headers: {
      KEY: key,
      Timestamp: timestamp,
      SIGN: sign,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  return resp.data;
}

async function main() {
  const args = parseArgs(process.argv);
  const symbol = args.symbol.toUpperCase();
  const adapterSymbol = normalizeForAdapter(symbol);
  const minQtyCfg = await readMinQtyConfig(args.minQtyJson, symbol);

  const binance = new BinanceAdapter();
  const gate = new GateAdapter();

  const latest = {
    binance: null,
    gate: null
  };
  const window = new SlidingSignal(WINDOW_MINUTES * 60 * 1000);
  let lastOpenTs = 0;
  let warmupLogged = false;
  let readyLogged = false;

  binance.on('ticker', (t) => {
    latest.binance = t;
  });
  gate.on('ticker', (t) => {
    latest.gate = t;
  });

  await Promise.all([binance.connect(), gate.connect()]);
  await Promise.all([
    binance.subscribe([adapterSymbol], ['bookTicker']),
    gate.subscribe([adapterSymbol], ['book_ticker'])
  ]);

  console.log(`[arb-demo] start symbol=${symbol} window=${WINDOW_MINUTES}m z_ab=${Z_AB_OPEN} z_ba=${Z_BA_OPEN} dryRun=${args.dryRun}`);
  console.log(`[arb-demo] minQty config loaded from ${args.minQtyJson}`);
  console.log(`[arb-demo] binance minQty=${minQtyCfg.binance.minQty}, step=${minQtyCfg.binance.stepSize}`);
  console.log(`[arb-demo] gate minQty=${minQtyCfg.gate.minQty}, step=${minQtyCfg.gate.stepSize}, multiplier=${minQtyCfg.gate.quantoMultiplier}`);

  const shutdown = async (sig) => {
    console.log(`[arb-demo] ${sig} stopping...`);
    await Promise.all([binance.disconnect(), gate.disconnect()]);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (true) {
    await new Promise((r) => setTimeout(r, LOOP_SLEEP_MS));

    const bt = latest.binance;
    const gt = latest.gate;
    if (!bt || !gt) continue;
    if (![bt.bid, bt.ask, gt.bid, gt.ask].every(Number.isFinite)) continue;

    const ts = Date.now();
    const spreadAb = ((bt.bid - gt.ask) / gt.ask) * 100;
    const spreadBa = ((gt.bid - bt.ask) / bt.ask) * 100;
    const spreadAbAdj = spreadAb - TOTAL_COST_PCT;
    const spreadBaAdj = spreadBa - TOTAL_COST_PCT;
    window.add(ts, spreadAbAdj, spreadBaAdj);

    const { zAb, zBa, points, ready } = window.computeZ();
    if (!ready) {
      if (!warmupLogged) {
        warmupLogged = true;
        console.log(`[arb-demo] warming up: need full ${WINDOW_MINUTES} minutes realtime data before signals`);
      }
      continue;
    }
    if (!readyLogged) {
      readyLogged = true;
      console.log(`[arb-demo] window ready: full ${WINDOW_MINUTES} minutes collected, signal engine enabled`);
    }

    if (!Number.isFinite(zAb) || !Number.isFinite(zBa)) {
      continue;
    }

    const canOpenAb = zAb >= Z_AB_OPEN;
    const canOpenBa = zBa >= Z_BA_OPEN;
    if (!canOpenAb && !canOpenBa) {
      continue;
    }

    if (ts - lastOpenTs < TICK_KEEP) {
      continue;
    }
    lastOpenTs = ts;

    const direction = canOpenAb && canOpenBa ? (zAb >= zBa ? '-a+b' : '+a-b') : (canOpenAb ? '-a+b' : '+a-b');
    const intent = buildExecutionIntent({
      direction,
      symbol,
      binanceTicker: bt,
      gateTicker: gt,
      minCfg: minQtyCfg,
      orderUsd: args.orderUsd
    });
    if (!intent) {
      console.log(`[arb-demo] signal fired but qty is invalid after minQty/step filter`);
      continue;
    }

    console.log(
      `[arb-demo] signal direction=${direction} z_ab=${zAb.toFixed(3)} z_ba=${zBa.toFixed(3)} points=${points} ` +
      `spread_ab_adj=${spreadAbAdj.toFixed(4)} spread_ba_adj=${spreadBaAdj.toFixed(4)}`
    );
    console.log(`[arb-demo] order intent: ${JSON.stringify(intent)}`);

    if (!args.dryRun) {
      try {
        const [binanceRes, gateRes] = await Promise.all([
          placeBinanceOrder(intent.binance),
          placeGateOrder(intent.gate)
        ]);
        console.log(`[arb-demo] order placed. binance=${JSON.stringify(binanceRes)} gate=${JSON.stringify(gateRes)}`);
      } catch (orderErr) {
        console.error(`[arb-demo] order failed: ${orderErr.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(`[arb-demo] ${err.message}`);
  process.exit(1);
});
