/**
 * 生成 CEX-CEX 币种配置（JS 版替代 Python）
 * 输出: config/symbols_config.json
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

const BINANCE_REST = 'https://fapi.binance.com';
const GATE_REST = 'https://api.gateio.ws/api/v4';

async function fetchBinancePerps() {
  const { data } = await axios.get(`${BINANCE_REST}/fapi/v1/exchangeInfo`, { timeout: 15000 });
  const out = new Set();
  for (const s of data.symbols || []) {
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING') {
      out.add(String(s.symbol));
    }
  }
  return out;
}

async function fetchGatePerps() {
  const { data } = await axios.get(`${GATE_REST}/futures/usdt/contracts`, { timeout: 15000 });
  const out = new Set();
  for (const c of data || []) {
    const name = c.name || c.contract;
    if (!name || !String(name).endsWith('_USDT')) continue;
    if (c.in_delisting === true) continue;
    out.add(String(name));
  }
  return out;
}

async function fetchBinanceQv() {
  const { data } = await axios.get(`${BINANCE_REST}/fapi/v1/ticker/24hr`, { timeout: 15000 });
  const out = new Map();
  for (const i of data || []) out.set(String(i.symbol), Number(i.quoteVolume || 0));
  return out;
}

async function fetchGateQv() {
  const { data } = await axios.get(`${GATE_REST}/futures/usdt/tickers`, { timeout: 15000 });
  const out = new Map();
  for (const i of data || []) {
    const c = String(i.contract || '');
    if (!c) continue;
    const v =
      Number(i.volume_24h_quote ?? i.volume_24h_usd ?? i.volume_24h ?? i.volume ?? 0) || 0;
    out.set(c, v);
  }
  return out;
}

async function main() {
  const topN = Number(process.argv[2] || 52);
  const [bnSet, gtSet, bnQv, gtQv] = await Promise.all([
    fetchBinancePerps(),
    fetchGatePerps(),
    fetchBinanceQv(),
    fetchGateQv()
  ]);

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

  const payload = {
    generated_at: Date.now(),
    source: 'binance_futures + gate_futures_usdt',
    sort_rule: 'liquidity_score_desc_then_symbol_asc',
    top_n: topN,
    total_common_symbols: rows.length,
    selected_symbols_count: Math.min(topN, rows.length),
    selected_symbols: rows.slice(0, topN).map((r) => r.symbol_id),
    symbols: rows
  };

  const output = path.resolve('config/symbols_config.json');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(payload, null, 2), 'utf-8');

  console.log(`Generated: ${output}`);
  console.log(`Common symbols: ${rows.length}`);
  console.log(`Selected top ${Math.min(topN, rows.length)} symbols.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
