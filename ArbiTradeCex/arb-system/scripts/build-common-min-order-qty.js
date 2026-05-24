/**
 * 拉取 Binance/Gate 共有 USDT 永续币种，按流动性排序后生成精度配置。
 *
 * 排序规则（与 collector/scripts/build-symbol-config.js 一致）：
 *   liquidity_score = min(binance_24h_qv, gate_24h_qv)，降序；同分按 symbol_id 升序
 *
 * 输出：
 *   config/symbols_config.json  — 币种列表、rank、流动性
 *   config/min-order-qty.json   — 各 symbol 最小下单量/步进（供 PrecisionChecker）
 *
 * 用法：
 *   node scripts/build-common-min-order-qty.js
 *   node scripts/build-common-min-order-qty.js --top 52
 *   node scripts/build-common-min-order-qty.js --top 0          # 0 表示全部共有币种
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import axios from 'axios';
import { getRootDir } from '../config/global-config.js';

const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const GATE_REST = process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4';

function parseArgs(argv) {
  const rootDir = getRootDir();
  const args = {
    top: null,
    outputSymbols: path.join(rootDir, 'config/symbols_config.json'),
    outputMinQty: path.join(rootDir, 'config/min-order-qty.json'),
    skipErrors: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--top' && argv[i + 1] != null) {
      args.top = Number(argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--output-symbols' && argv[i + 1]) {
      args.outputSymbols = path.resolve(rootDir, argv[i + 1]);
      i += 1;
      continue;
    }
    if (token === '--output-min-qty' && argv[i + 1]) {
      args.outputMinQty = path.resolve(rootDir, argv[i + 1]);
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
  return args;
}

function toGateContract(binanceStyleSymbol) {
  return `${binanceStyleSymbol.slice(0, -4)}_USDT`;
}

function getBinanceLotFilter(symbolInfo) {
  return (symbolInfo.filters || []).find((f) => f.filterType === 'LOT_SIZE') || null;
}

function buildBinancePerpSet(exchangeInfo) {
  const out = new Set();
  for (const s of exchangeInfo.symbols || []) {
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
      out.add(String(s.symbol));
    }
  }
  return out;
}

function buildGatePerpSet(contracts) {
  const out = new Set();
  for (const c of contracts || []) {
    const name = c.name || c.contract;
    if (!name || !String(name).endsWith('_USDT')) continue;
    if (c.in_delisting === true) continue;
    out.add(String(name));
  }
  return out;
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

function buildBinanceQvMap(ticker24hr) {
  const out = new Map();
  for (const i of ticker24hr || []) {
    out.set(String(i.symbol), Number(i.quoteVolume || 0));
  }
  return out;
}

function buildGateQvMap(tickers) {
  const out = new Map();
  for (const i of tickers || []) {
    const c = String(i.contract || '');
    if (!c) continue;
    const v = Number(i.volume_24h_quote ?? i.volume_24h_usd ?? i.volume_24h ?? i.volume ?? 0) || 0;
    out.set(c, v);
  }
  return out;
}

function buildBinanceBookTickerMap(bookTickers) {
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

function buildGateBookTickerMap(tickers) {
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

function buildCommonSymbolRows(bnSet, gtSet, bnQv, gtQv) {
  const gateNorm = new Map();
  for (const g of gtSet) gateNorm.set(g.replace('_', ''), g);

  const rows = [];
  for (const bn of bnSet) {
    const gt = gateNorm.get(bn);
    if (!gt) continue;
    const bnv = Number(bnQv.get(bn) || 0);
    const gtv = Number(gtQv.get(gt) || 0);
    rows.push({
      symbol_id: bn,
      binance_symbol: bn,
      gate_symbol: gt,
      binance_quote_volume_24h: bnv,
      gate_quote_volume_24h: gtv,
      liquidity_score: Math.min(bnv, gtv)
    });
  }

  rows.sort((a, b) => b.liquidity_score - a.liquidity_score || a.symbol_id.localeCompare(b.symbol_id));
  rows.forEach((r, idx) => {
    r.rank = idx + 1;
  });
  return rows;
}

function buildMinQtyEntry({ symbolId, gateSymbol, binanceInfo, gateInfo, bTicker, gTicker, priceCollectedAt }) {
  const lot = getBinanceLotFilter(binanceInfo);
  if (!lot) {
    throw new Error(`LOT_SIZE filter missing on Binance for ${symbolId}`);
  }

  const minQty = Number(lot.minQty);
  const stepSize = Number(lot.stepSize);
  const gateMinContracts = Number(gateInfo.order_size_min);
  const gateOrderSizeRound = Number(gateInfo.order_size_round || 0);
  const gateQuantoMultiplier = Number(gateInfo.quanto_multiplier || 0);

  if (!Number.isFinite(minQty) || !Number.isFinite(stepSize)) {
    throw new Error(`invalid Binance minQty/stepSize for ${symbolId}`);
  }
  if (!Number.isFinite(gateMinContracts) || gateMinContracts <= 0) {
    throw new Error(`invalid Gate order_size_min for ${gateSymbol}`);
  }

  return {
    binance: {
      symbol: symbolId,
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
      symbol: gateSymbol,
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

async function main() {
  const args = parseArgs(process.argv);

  const [
    binanceExchangeInfo,
    gateContracts,
    binance24hr,
    gateTickers,
    binanceBookTickers
  ] = await Promise.all([
    axios.get(`${BINANCE_REST}/fapi/v1/exchangeInfo`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${GATE_REST}/futures/usdt/contracts`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${BINANCE_REST}/fapi/v1/ticker/24hr`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${GATE_REST}/futures/usdt/tickers`, { timeout: 30000 }).then((r) => r.data),
    axios.get(`${BINANCE_REST}/fapi/v1/ticker/bookTicker`, { timeout: 30000 }).then((r) => r.data)
  ]);

  const bnSet = buildBinancePerpSet(binanceExchangeInfo);
  const gtSet = buildGatePerpSet(gateContracts);
  const bnQv = buildBinanceQvMap(binance24hr);
  const gtQv = buildGateQvMap(gateTickers);
  const allRows = buildCommonSymbolRows(bnSet, gtSet, bnQv, gtQv);

  const topN = args.top == null ? allRows.length : args.top;
  const selectedRows = topN === 0 ? allRows : allRows.slice(0, topN);

  const binanceMap = buildBinanceMap(binanceExchangeInfo);
  const gateMap = buildGateMap(gateContracts);
  const binanceTickerMap = buildBinanceBookTickerMap(binanceBookTickers);
  const gateTickerMap = buildGateBookTickerMap(gateTickers);
  const priceCollectedAt = new Date().toISOString();

  const minQtySymbols = {};
  const skipped = [];

  for (const row of selectedRows) {
    const symbolId = row.symbol_id;
    const gateSymbol = row.gate_symbol;
    try {
      minQtySymbols[symbolId] = buildMinQtyEntry({
        symbolId,
        gateSymbol,
        binanceInfo: binanceMap.get(symbolId),
        gateInfo: gateMap.get(gateSymbol),
        bTicker: binanceTickerMap.get(symbolId) || null,
        gTicker: gateTickerMap.get(gateSymbol) || null,
        priceCollectedAt
      });
    } catch (err) {
      if (args.skipErrors) {
        skipped.push({ symbol: symbolId, error: err.message });
        continue;
      }
      throw err;
    }
  }

  const selectedSymbolIds = selectedRows
    .map((r) => r.symbol_id)
    .filter((s) => minQtySymbols[s]);

  const symbolsPayload = {
    generated_at: Date.now(),
    source: 'binance_futures + gate_futures_usdt',
    sort_rule: 'liquidity_score_desc_then_symbol_asc',
    top_n: topN,
    total_common_symbols: allRows.length,
    selected_symbols_count: selectedSymbolIds.length,
    selected_symbols: selectedSymbolIds,
    symbols: selectedRows.filter((r) => minQtySymbols[r.symbol_id])
  };

  const minQtyPayload = {
    generatedAt: new Date().toISOString(),
    sortRule: 'liquidity_score_desc_then_symbol_asc',
    totalCommonSymbols: allRows.length,
    selectedSymbolsCount: selectedSymbolIds.length,
    selectedSymbols: selectedSymbolIds,
    source: {
      binance: `${BINANCE_REST}/fapi/v1/exchangeInfo`,
      gate: `${GATE_REST}/futures/usdt/contracts`,
      binanceTicker: `${BINANCE_REST}/fapi/v1/ticker/bookTicker`,
      gateTicker: `${GATE_REST}/futures/usdt/tickers`,
      binance24h: `${BINANCE_REST}/fapi/v1/ticker/24hr`,
      gate24h: `${GATE_REST}/futures/usdt/tickers`
    },
    symbols: minQtySymbols
  };

  if (skipped.length > 0) {
    minQtyPayload.skipped = skipped;
    symbolsPayload.skipped = skipped;
  }

  await fs.mkdir(path.dirname(args.outputSymbols), { recursive: true });
  await fs.mkdir(path.dirname(args.outputMinQty), { recursive: true });
  await fs.writeFile(args.outputSymbols, `${JSON.stringify(symbolsPayload, null, 2)}\n`, 'utf8');
  await fs.writeFile(args.outputMinQty, `${JSON.stringify(minQtyPayload, null, 2)}\n`, 'utf8');

  console.log(`written symbols: ${args.outputSymbols}`);
  console.log(`written min-qty: ${args.outputMinQty}`);
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
