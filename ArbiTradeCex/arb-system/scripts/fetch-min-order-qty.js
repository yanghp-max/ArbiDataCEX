/**
 * 拉取 Binance/Gate 最小下单量与精度，写入本项目 config/min-order-qty.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';
import { loadConfig, getRootDir } from '../config/global-config.js';
import { resolveBinanceOrderLimits } from '../common/utils/binance-order-limits.js';
import { resolveBinanceSymbolInfoForBuild } from '../common/utils/binance-symbol-info.js';
import { resolveGateOrderLimits } from '../common/utils/gate-contract-limits.js';
import { fetchGateContractsDecimal } from '../common/utils/fetch-market-metadata.js';

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
    throw new Error(
      'missing --symbols; pass --symbols LABUSDT or set selectedSymbols in config/min-order-qty.json'
    );
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

function binanceRefPrice(ticker) {
  return ticker?.bid ?? ticker?.mid ?? ticker?.ask ?? null;
}

async function fetchBinanceExchangeInfo() {
  const resp = await axios.get(`${BINANCE_REST}/fapi/v1/exchangeInfo`, { timeout: 15000 });
  return resp.data;
}

async function fetchGateContracts() {
  return fetchGateContractsDecimal();
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
      gate: `${GATE_REST}/futures/usdt/contracts (X-Gate-Size-Decimal: 1)`,
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

    const bTicker = binanceTickerMap.get(upper) || null;
    const gTicker = gateTickerMap.get(gateContract) || null;
    const refPrice = binanceRefPrice(bTicker);
    const { symbolInfo: resolvedBinanceInfo, refreshed } = await resolveBinanceSymbolInfoForBuild(
      upper,
      b,
      refPrice
    );
    const binanceLimits = resolveBinanceOrderLimits(resolvedBinanceInfo, {
      refPrice
    });

    const gateLimits = resolveGateOrderLimits(g, {
      binanceMinQty: binanceLimits.minQty,
      binanceStepSize: binanceLimits.stepSize,
      gateSymbol: gateContract
    });

    result.symbols[upper] = {
      binance: {
        symbol: upper,
        lotMinQty: binanceLimits.lotMinQty,
        minNotional: binanceLimits.minNotional,
        minQty: binanceLimits.minQty,
        stepSize: binanceLimits.stepSize,
        exchangeInfoRefreshed: refreshed,
        priceRef: {
          collectedAt: priceCollectedAt,
          bid: bTicker?.bid ?? null,
          ask: bTicker?.ask ?? null,
          mid: bTicker?.mid ?? null
        }
      },
      gate: {
        symbol: gateContract,
        minQty: gateLimits.minQty,
        stepSize: gateLimits.stepSize,
        quantityUnit: gateLimits.quantityUnit,
        enableDecimal: gateLimits.enableDecimal,
        quantoMultiplier: gateLimits.quantoMultiplier,
        minBaseQty: gateLimits.minBaseQty,
        gateOrderSizeMin: gateLimits.gateOrderSizeMin,
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
