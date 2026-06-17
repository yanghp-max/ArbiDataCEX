/**
 * 生成 min-order-qty（A/B 两腿）：
 * - 兼容老结构：输出键仍为 binance / gate（分别对应 A / B）
 * - 支持 B=gate 或 B=aster（A 默认 binance）
 *
 * 说明：
 * - config/min-order-qty.json 是配置文件，不是可执行脚本。
 * - 你需要执行的是本脚本，生成/更新该 JSON，然后策略启动时读取它。
 *
 * 常用命令：
 * - node scripts/build-common-min-order-qty.js
 * - npm run build:symbols-min-qty
 * - npm run build:symbols-min-qty:binance-aster
 *
 * 策略读取位置（config.json）：
 * - strategy.minQtyJson: "config/min-order-qty.json"
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';
import { getRootDir, loadConfig } from '../config/global-config.js';
import { resolveBinanceOrderLimits } from '../common/utils/binance-order-limits.js';
import { isBinanceExchangeInfoStale, reconcileBinanceSymbolFilters } from '../common/utils/binance-symbol-info.js';
import { resolveGateOrderLimits } from '../common/utils/gate-contract-limits.js';
import { fetchGateContractsDecimal, mapWithConcurrency } from '../common/utils/fetch-market-metadata.js';

const DEFAULT_URLS = {
  binance: process.env.BINANCE_REST_URL || 'https://fapi.binance.com',
  gate: process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4',
  aster: process.env.ASTER_REST_URL || 'https://fapi.asterdex.com'
};

function isBinanceLikeProvider(provider) {
  return provider === 'binance' || provider === 'aster';
}

function binanceLikeApiVersion(provider) {
  return provider === 'aster' ? 'v3' : 'v1';
}

function binanceLikePath(provider, endpoint) {
  return `/fapi/${binanceLikeApiVersion(provider)}${endpoint}`;
}

function normalizeProvider(value, fallback) {
  const p = String(value || fallback || '').trim().toLowerCase();
  return p || fallback;
}

function resolveDefaultProviders() {
  let cfg = null;
  try {
    cfg = loadConfig();
  } catch {
    cfg = null;
  }
  return {
    providerA: normalizeProvider(cfg?.adapters?.A?.provider, 'binance'),
    providerB: normalizeProvider(cfg?.adapters?.B?.provider, 'gate')
  };
}

function parseArgs(argv) {
  const rootDir = getRootDir();
  const defaults = resolveDefaultProviders();
  const args = {
    top: null,
    outputMinQty: path.join(rootDir, 'config/min-order-qty.json'),
    skipErrors: false,
    providerA: defaults.providerA,
    providerB: defaults.providerB
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--top' && argv[i + 1] != null) {
      args.top = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--output-min-qty' && argv[i + 1]) {
      args.outputMinQty = path.resolve(rootDir, argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--provider-a' && argv[i + 1]) {
      args.providerA = normalizeProvider(argv[i + 1], args.providerA);
      i += 1;
      continue;
    }
    if (token === '--provider-b' && argv[i + 1]) {
      args.providerB = normalizeProvider(argv[i + 1], args.providerB);
      i += 1;
      continue;
    }
    if (token === '--skip-errors') {
      args.skipErrors = true;
      continue;
    }
  }

  if (args.top != null && (!Number.isFinite(args.top) || args.top < 0)) {
    throw new Error('--top must be a non-negative number (0 = all common symbols)');
  }
  if (!isBinanceLikeProvider(args.providerA)) {
    throw new Error(`providerA=${args.providerA} not supported yet (supported: binance, aster)`);
  }
  if (!(args.providerB === 'gate' || isBinanceLikeProvider(args.providerB))) {
    throw new Error(`providerB=${args.providerB} not supported yet (supported: gate, binance, aster)`);
  }
  return args;
}

function toGateContract(compactSymbol) {
  return `${compactSymbol.slice(0, -4)}_USDT`;
}

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_]/g, '').toUpperCase();
}

function buildPerpSetBinanceLike(exchangeInfo) {
  const out = new Set();
  for (const s of exchangeInfo.symbols || []) {
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
      out.add(String(s.symbol));
    }
  }
  return out;
}

function buildPerpSetGate(contracts) {
  const out = new Set();
  for (const c of contracts || []) {
    const name = c.name || c.contract;
    if (!name || !String(name).endsWith('_USDT')) continue;
    if (c.in_delisting === true) continue;
    out.add(String(name));
  }
  return out;
}

function buildInfoMap(items, keySelector) {
  const map = new Map();
  for (const item of items || []) {
    const key = String(keySelector(item) || '');
    if (key) map.set(key, item);
  }
  return map;
}

function buildQvMapBinanceLike(rows) {
  const out = new Map();
  for (const i of rows || []) {
    out.set(String(i.symbol), Number(i.quoteVolume || 0));
  }
  return out;
}

function buildQvMapGate(rows) {
  const out = new Map();
  for (const i of rows || []) {
    const c = String(i.contract || '');
    if (!c) continue;
    const v = Number(i.volume_24h_quote ?? i.volume_24h_usd ?? i.volume_24h ?? i.volume ?? 0) || 0;
    out.set(c, v);
  }
  return out;
}

function buildBookTickerMapBinanceLike(rows) {
  const map = new Map();
  for (const t of rows || []) {
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

function buildBookTickerMapGate(rows) {
  const map = new Map();
  for (const t of rows || []) {
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

function buildProviderBSymbolMap(providerBSet, providerB) {
  const map = new Map();
  for (const raw of providerBSet) {
    const key = providerB === 'gate' ? compactSymbol(raw) : String(raw);
    map.set(key, String(raw));
  }
  return map;
}

function buildCommonRows(setA, setB, qvA, qvB, providerB) {
  const rows = [];
  const bMap = buildProviderBSymbolMap(setB, providerB);
  for (const aSymbol of setA) {
    const symbolId = String(aSymbol);
    const bSymbol = bMap.get(symbolId);
    if (!bSymbol) continue;
    const av = Number(qvA.get(symbolId) || 0);
    const bv = Number(qvB.get(bSymbol) || 0);
    rows.push({
      symbol_id: symbolId,
      a_symbol: symbolId,
      b_symbol: bSymbol,
      a_quote_volume_24h: av,
      b_quote_volume_24h: bv,
      liquidity_score: Math.min(av, bv)
    });
  }
  rows.sort((x, y) => y.liquidity_score - x.liquidity_score || x.symbol_id.localeCompare(y.symbol_id));
  rows.forEach((r, idx) => { r.rank = idx + 1; });
  return rows;
}

function refPriceFromTicker(ticker) {
  return ticker?.bid ?? ticker?.mid ?? ticker?.ask ?? ticker?.last ?? null;
}

function toBinanceLikeGateEntry(symbol, limits, ticker, priceCollectedAt) {
  return {
    symbol,
    minQty: limits.minQty,
    stepSize: limits.stepSize,
    quantityUnit: 'base',
    enableDecimal: true,
    quantoMultiplier: 1,
    minBaseQty: limits.minQty,
    gateOrderSizeMin: null,
    gateOrderSizeRound: null,
    hedgeMinBaseQty: null,
    hedgeMinQtyByBinanceStep: null,
    priceRef: {
      collectedAt: priceCollectedAt,
      bid: ticker?.bid ?? null,
      ask: ticker?.ask ?? null,
      mid: ticker?.mid ?? null,
      last: ticker?.last ?? null
    }
  };
}

async function buildMinQtyEntry({
  symbolId,
  restA,
  providerA,
  restB,
  bSymbol,
  providerB,
  infoA,
  infoB,
  tickerA,
  tickerB,
  priceCollectedAt
}) {
  const refA = refPriceFromTicker(tickerA);
  const { symbolInfo: resolvedAInfo, refreshed } = await resolveBinanceLikeSymbolInfoForBuild(
    restA,
    providerA,
    symbolId,
    infoA,
    refA
  );
  const limitsA = resolveBinanceOrderLimits(resolvedAInfo, { refPrice: refA });

  let limitsBCompat;
  if (providerB === 'gate') {
    limitsBCompat = resolveGateOrderLimits(infoB, {
      binanceMinQty: limitsA.minQty,
      binanceStepSize: limitsA.stepSize,
      gateSymbol: bSymbol
    });
  } else {
    const refB = refPriceFromTicker(tickerB);
    const { symbolInfo: resolvedBInfo } = await resolveBinanceLikeSymbolInfoForBuild(
      restB,
      providerB,
      symbolId,
      infoB,
      refB
    );
    const limitsB = resolveBinanceOrderLimits(resolvedBInfo, { refPrice: refB });
    limitsBCompat = toBinanceLikeGateEntry(bSymbol, limitsB, tickerB, priceCollectedAt);
  }

  const legacyA = {
    symbol: symbolId,
    lotMinQty: limitsA.lotMinQty,
    minNotional: limitsA.minNotional,
    minQty: limitsA.minQty,
    stepSize: limitsA.stepSize,
    exchangeInfoRefreshed: refreshed,
    priceRef: {
      collectedAt: priceCollectedAt,
      bid: tickerA?.bid ?? null,
      ask: tickerA?.ask ?? null,
      mid: tickerA?.mid ?? null
    }
  };
  const legacyB = providerB === 'gate'
    ? {
      symbol: bSymbol,
      minQty: limitsBCompat.minQty,
      stepSize: limitsBCompat.stepSize,
      quantityUnit: limitsBCompat.quantityUnit,
      enableDecimal: limitsBCompat.enableDecimal,
      quantoMultiplier: limitsBCompat.quantoMultiplier,
      minBaseQty: limitsBCompat.minBaseQty,
      gateOrderSizeMin: limitsBCompat.gateOrderSizeMin,
      gateOrderSizeRound: limitsBCompat.gateOrderSizeRound,
      hedgeMinBaseQty: limitsBCompat.hedgeMinBaseQty ?? null,
      hedgeMinQtyByBinanceStep: limitsBCompat.hedgeMinQtyByBinanceStep ?? null,
      priceRef: {
        collectedAt: priceCollectedAt,
        bid: tickerB?.bid ?? null,
        ask: tickerB?.ask ?? null,
        mid: tickerB?.mid ?? null,
        last: tickerB?.last ?? null
      }
    }
    : limitsBCompat;

  return {
    // 兼容老代码：A 腿放 binance，B 腿放 gate
    binance: legacyA,
    gate: legacyB,
    // 通用结构：新代码优先读取 legs/providers
    legs: {
      A: {
        provider: providerA,
        limits: legacyA
      },
      B: {
        provider: providerB,
        limits: legacyB
      }
    },
    providers: {
      [providerA]: legacyA,
      [providerB]: legacyB
    }
  };
}

async function fetchBinanceLikeBundle(restUrl, provider) {
  const exchangeInfoPath = binanceLikePath(provider, '/exchangeInfo');
  const ticker24hPath = binanceLikePath(provider, '/ticker/24hr');
  const bookTickerPath = binanceLikePath(provider, '/ticker/bookTicker');
  const [exchangeInfo, ticker24h, bookTickers] = await Promise.all([
    axios.get(`${restUrl}${exchangeInfoPath}`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${restUrl}${ticker24hPath}`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${restUrl}${bookTickerPath}`, { timeout: 30000 }).then((r) => r.data)
  ]);
  return { exchangeInfo, ticker24h, bookTickers };
}

async function fetchBinanceLikeSymbolExchangeInfo(restUrl, provider, symbol) {
  const sym = String(symbol || '').toUpperCase();
  const { data } = await axios.get(`${restUrl}${binanceLikePath(provider, '/exchangeInfo')}`, {
    params: { symbol: sym },
    timeout: 15000
  });
  const row = Array.isArray(data?.symbols)
    ? data.symbols.find((s) => String(s.symbol) === sym)
    : null;
  if (!row) {
    throw new Error(`exchangeInfo missing symbol ${sym} on ${restUrl}`);
  }
  return row;
}

async function resolveBinanceLikeSymbolInfoForBuild(restUrl, provider, symbol, symbolInfo, refPrice) {
  let info = symbolInfo;
  let refreshed = false;
  if (info && isBinanceExchangeInfoStale(info, refPrice)) {
    info = await fetchBinanceLikeSymbolExchangeInfo(restUrl, provider, symbol);
    refreshed = true;
  }
  if (info && isBinanceExchangeInfoStale(info, refPrice)) {
    info = reconcileBinanceSymbolFilters(info, refPrice);
  }
  return { symbolInfo: info, refreshed };
}

async function main() {
  const args = parseArgs(process.argv);
  const restA = DEFAULT_URLS[args.providerA];
  const restB = DEFAULT_URLS[args.providerB];

  const bundleA = await fetchBinanceLikeBundle(restA, args.providerA);
  const setA = buildPerpSetBinanceLike(bundleA.exchangeInfo);
  const qvA = buildQvMapBinanceLike(bundleA.ticker24h);
  const infoMapA = buildInfoMap(bundleA.exchangeInfo.symbols || [], (s) => s.symbol);
  const tickerMapA = buildBookTickerMapBinanceLike(bundleA.bookTickers);

  let setB;
  let qvB;
  let infoMapB;
  let tickerMapB;
  if (args.providerB === 'gate') {
    const [contracts, tickers] = await Promise.all([
      fetchGateContractsDecimal(),
      axios.get(`${restB}/futures/usdt/tickers`, { timeout: 30000 }).then((r) => r.data)
    ]);
    setB = buildPerpSetGate(contracts);
    qvB = buildQvMapGate(tickers);
    infoMapB = buildInfoMap(contracts, (c) => c.name || c.contract);
    tickerMapB = buildBookTickerMapGate(tickers);
  } else {
    const bundleB = await fetchBinanceLikeBundle(restB, args.providerB);
    setB = buildPerpSetBinanceLike(bundleB.exchangeInfo);
    qvB = buildQvMapBinanceLike(bundleB.ticker24h);
    infoMapB = buildInfoMap(bundleB.exchangeInfo.symbols || [], (s) => s.symbol);
    tickerMapB = buildBookTickerMapBinanceLike(bundleB.bookTickers);
  }

  const allRows = buildCommonRows(setA, setB, qvA, qvB, args.providerB);
  const topN = args.top == null ? allRows.length : args.top;
  const selectedRows = topN === 0 ? allRows : allRows.slice(0, topN);
  const priceCollectedAt = new Date().toISOString();

  const minQtySymbols = {};
  const skipped = [];

  const builtRows = await mapWithConcurrency(selectedRows, 8, async (row) => {
    const symbolId = row.symbol_id;
    const bSymbol = row.b_symbol;
    try {
      const entry = await buildMinQtyEntry({
        symbolId,
        restA,
        providerA: args.providerA,
        restB,
        bSymbol,
        providerB: args.providerB,
        infoA: infoMapA.get(symbolId),
        infoB: infoMapB.get(bSymbol),
        tickerA: tickerMapA.get(symbolId) || null,
        tickerB: tickerMapB.get(bSymbol) || null,
        priceCollectedAt
      });
      return { symbolId, entry, error: null };
    } catch (err) {
      if (!args.skipErrors) throw err;
      return { symbolId, entry: null, error: err.message };
    }
  });

  for (const row of builtRows) {
    if (row.error) {
      skipped.push({ symbol: row.symbolId, error: row.error });
      continue;
    }
    minQtySymbols[row.symbolId] = row.entry;
  }

  const selectedSymbolIds = selectedRows.map((r) => r.symbol_id).filter((s) => minQtySymbols[s]);
  const payload = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sortRule: 'liquidity_score_desc_then_symbol_asc',
    totalCommonSymbols: allRows.length,
    selectedSymbolsCount: selectedSymbolIds.length,
    selectedSymbols: selectedSymbolIds,
    pair: {
      providerA: args.providerA,
      providerB: args.providerB
    },
    source: {
      providerA: args.providerA,
      providerB: args.providerB,
      aExchangeInfo: `${restA}${binanceLikePath(args.providerA, '/exchangeInfo')}`,
      aBookTicker: `${restA}${binanceLikePath(args.providerA, '/ticker/bookTicker')}`,
      a24h: `${restA}${binanceLikePath(args.providerA, '/ticker/24hr')}`,
      bExchangeInfo: args.providerB === 'gate'
        ? `${restB}/futures/usdt/contracts (X-Gate-Size-Decimal: 1)`
        : `${restB}${binanceLikePath(args.providerB, '/exchangeInfo')}`,
      bBookTicker: args.providerB === 'gate'
        ? `${restB}/futures/usdt/tickers`
        : `${restB}${binanceLikePath(args.providerB, '/ticker/bookTicker')}`,
      b24h: args.providerB === 'gate'
        ? `${restB}/futures/usdt/tickers`
        : `${restB}${binanceLikePath(args.providerB, '/ticker/24hr')}`
    },
    symbols: minQtySymbols
  };
  if (skipped.length > 0) payload.skipped = skipped;

  await fs.mkdir(path.dirname(args.outputMinQty), { recursive: true });
  await fs.writeFile(args.outputMinQty, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`written min-qty: ${args.outputMinQty}`);
  console.log(`pair: ${args.providerA}/${args.providerB}`);
  console.log(`common symbols: ${allRows.length}`);
  console.log(`selected: ${selectedSymbolIds.length}${topN < allRows.length ? ` (top ${topN})` : ''}`);
  if (selectedSymbolIds.length > 0) {
    console.log(`top 5: ${selectedSymbolIds.slice(0, 5).join(', ')}`);
  }
  if (skipped.length > 0) {
    console.warn(`skipped ${skipped.length} symbols (see output JSON "skipped")`);
  }
}

main().catch((err) => {
  console.error(`[build-common-min-order-qty] ${err.message}`);
  process.exit(1);
});
