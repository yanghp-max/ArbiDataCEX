/**
 * 拉取 Binance/Gate 最小下单量与精度，写入本项目 config/min-order-qty.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';
import { loadConfig, getRootDir } from '../config/global-config.js';

const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const GATE_REST = process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4';

function parseArgs(argv) {
  const rootDir = getRootDir();
  const args = {
    symbols: [],
    output: path.join(rootDir, 'config/min-order-qty.json')
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--symbols' && argv[i + 1]) {
      args.symbols = parseSymbolsInput(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--output' && argv[i + 1]) {
      args.output = path.resolve(rootDir, argv[i + 1]);
      i += 1;
      continue;
    }
  }

  if (args.symbols.length === 0) {
    args.symbols = loadConfig().strategy.symbols || [];
  }
  if (args.symbols.length === 0) {
    throw new Error('missing --symbols or config.strategy.symbols in config.json');
  }
  return args;
}

function parseSymbolsInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  if (text.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new Error(`invalid --symbols JSON array: ${text}`);
    }
    if (!Array.isArray(arr)) {
      throw new Error('--symbols JSON value must be an array');
    }
    return normalizeSymbols(arr);
  }

  return normalizeSymbols(text.split(','));
}

function normalizeSymbols(items) {
  const out = [];
  for (const item of items) {
    const symbol = String(item || '').trim().toUpperCase();
    if (!symbol) continue;
    if (!/^[A-Z0-9]+USDT$/.test(symbol)) {
      throw new Error(`invalid symbol "${symbol}", require XXXUSDT format for perpetual`);
    }
    out.push(symbol);
  }
  return [...new Set(out)];
}

function toGateContract(binanceStyleSymbol) {
  if (!binanceStyleSymbol.endsWith('USDT')) {
    throw new Error(`only USDT symbols are supported, got: ${binanceStyleSymbol}`);
  }
  return `${binanceStyleSymbol.slice(0, -4)}_USDT`;
}

function getBinanceLotFilter(symbolInfo) {
  return (symbolInfo.filters || []).find((f) => f.filterType === 'LOT_SIZE') || null;
}

async function fetchBinanceExchangeInfo() {
  const resp = await axios.get(`${BINANCE_REST}/fapi/v1/exchangeInfo`, { timeout: 15000 });
  return resp.data;
}

async function fetchGateContracts() {
  const resp = await axios.get(`${GATE_REST}/futures/usdt/contracts`, { timeout: 15000 });
  return resp.data;
}

async function fetchBinanceBookTickers() {
  const resp = await axios.get(`${BINANCE_REST}/fapi/v1/ticker/bookTicker`, { timeout: 15000 });
  return resp.data;
}

async function fetchGateTickers() {
  const resp = await axios.get(`${GATE_REST}/futures/usdt/tickers`, { timeout: 15000 });
  return resp.data;
}

function buildBinanceMap(exchangeInfo) {
  const map = new Map();
  for (const s of exchangeInfo.symbols || []) {
    map.set(String(s.symbol), s);
  }
  return map;
}

function buildGateMap(contracts) {
  const map = new Map();
  for (const c of contracts || []) {
    const key = String(c.name || c.contract || '');
    if (key) map.set(key, c);
  }
  return map;
}

function buildBinanceTickerMap(bookTickers) {
  const map = new Map();
  for (const t of bookTickers || []) {
    const symbol = String(t.symbol || '');
    if (!symbol) continue;
    const bid = Number(t.bidPrice);
    const ask = Number(t.askPrice);
    map.set(symbol, {
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      mid: Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null
    });
  }
  return map;
}

function buildGateTickerMap(tickers) {
  const map = new Map();
  for (const t of tickers || []) {
    const contract = String(t.contract || '');
    if (!contract) continue;
    const bid = Number(t.highest_bid);
    const ask = Number(t.lowest_ask);
    const last = Number(t.last);
    map.set(contract, {
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      last: Number.isFinite(last) ? last : null,
      mid: Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null
    });
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv);
  const [binanceInfo, gateContracts, binanceBookTickers, gateTickers] = await Promise.all([
    fetchBinanceExchangeInfo(),
    fetchGateContracts(),
    fetchBinanceBookTickers(),
    fetchGateTickers()
  ]);

  const binanceMap = buildBinanceMap(binanceInfo);
  const gateMap = buildGateMap(gateContracts);
  const binanceTickerMap = buildBinanceTickerMap(binanceBookTickers);
  const gateTickerMap = buildGateTickerMap(gateTickers);
  const priceCollectedAt = new Date().toISOString();
  const result = {
    generatedAt: new Date().toISOString(),
    source: {
      binance: `${BINANCE_REST}/fapi/v1/exchangeInfo`,
      gate: `${GATE_REST}/futures/usdt/contracts`,
      binanceTicker: `${BINANCE_REST}/fapi/v1/ticker/bookTicker`,
      gateTicker: `${GATE_REST}/futures/usdt/tickers`
    },
    symbols: {}
  };

  for (const symbol of args.symbols) {
    const upper = symbol.toUpperCase();
    const gateContract = toGateContract(upper);

    const b = binanceMap.get(upper);
    const g = gateMap.get(gateContract);

    if (!b) {
      throw new Error(`symbol not found on Binance futures: ${upper}`);
    }
    if (!g) {
      throw new Error(`symbol not found on Gate futures: ${gateContract}`);
    }

    const lot = getBinanceLotFilter(b);
    if (!lot) {
      throw new Error(`LOT_SIZE filter missing on Binance for ${upper}`);
    }

    const minQty = Number(lot.minQty);
    const stepSize = Number(lot.stepSize);
    const gateMinContracts = Number(g.order_size_min);
    const gateOrderSizeRound = Number(g.order_size_round || 0);
    const gateQuantoMultiplier = Number(g.quanto_multiplier || 0);
    const bTicker = binanceTickerMap.get(upper) || null;
    const gTicker = gateTickerMap.get(gateContract) || null;

    if (!Number.isFinite(minQty) || !Number.isFinite(stepSize)) {
      throw new Error(`invalid Binance minQty/stepSize for ${upper}`);
    }
    if (!Number.isFinite(gateMinContracts) || gateMinContracts <= 0) {
      throw new Error(`invalid Gate order_size_min for ${gateContract}`);
    }

    result.symbols[upper] = {
      binance: {
        symbol: upper,
        minQty,
        stepSize,
        priceRef: {
          collectedAt: priceCollectedAt,
          bid: bTicker?.bid ?? null,
          ask: bTicker?.ask ?? null,
          mid: bTicker?.mid ?? null
        }
      },
      gate: {
        symbol: gateContract,
        minQty: gateMinContracts,
        stepSize: gateOrderSizeRound > 0 ? gateOrderSizeRound : 1,
        quantityUnit: 'contract',
        quantoMultiplier: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
          ? gateQuantoMultiplier
          : null,
        minBaseQty: Number.isFinite(gateQuantoMultiplier) && gateQuantoMultiplier > 0
          ? gateMinContracts * gateQuantoMultiplier
          : null,
        priceRef: {
          collectedAt: priceCollectedAt,
          bid: gTicker?.bid ?? null,
          ask: gTicker?.ask ?? null,
          mid: gTicker?.mid ?? null,
          last: gTicker?.last ?? null
        }
      }
    };
  }

  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`written: ${args.output}`);
  console.log(`symbols: ${Object.keys(result.symbols).join(', ')}`);
}

main().catch((err) => {
  console.error(`[fetch-min-order-qty] ${err.message}`);
  process.exit(1);
});
