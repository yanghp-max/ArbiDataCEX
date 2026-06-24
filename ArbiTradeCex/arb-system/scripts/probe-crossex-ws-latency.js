#!/usr/bin/env node
/**
 * CrossEx 公共 WS 推送延迟探测（对齐项目 wsDelayMs = localReceive - exchangeTs）
 *
 * Usage:
 *   node scripts/probe-crossex-ws-latency.js --min-qty
 *   node scripts/probe-crossex-ws-latency.js --min-qty config/min-order-qty.json --compare --duration 60
 *   node scripts/probe-crossex-ws-latency.js --symbols BTCUSDT,ETHUSDT --duration 30
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIN_QTY = path.join(__dirname, '..', 'config', 'min-order-qty.json');

const CROSSEX_WS = process.env.CROSSEX_WS_URL || 'wss://api.gateio.ws/ws/crossex/public';
const BINANCE_WS = process.env.BINANCE_WS_URL || 'wss://fstream.binance.com';
const OKX_WS = process.env.OKX_WS_URL || 'wss://ws.okx.com:8443/ws/v5/public';

function parseArgs(argv) {
  const args = {
    durationSec: 30,
    symbols: null,
    minQtyPath: null,
    compare: false,
    channel: 'ticker'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--duration' && argv[i + 1]) {
      args.durationSec = Math.max(5, Number(argv[i + 1]) || 30);
      i += 1;
    } else if (t === '--symbols' && argv[i + 1]) {
      args.symbols = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (t === '--min-qty') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        args.minQtyPath = path.resolve(next);
        i += 1;
      } else {
        args.minQtyPath = DEFAULT_MIN_QTY;
      }
    } else if (t === '--compare') {
      args.compare = true;
    } else if (t === '--channel' && argv[i + 1]) {
      args.channel = String(argv[i + 1]).trim();
      i += 1;
    }
  }
  return args;
}

function loadSelectedSymbols(minQtyPath) {
  const raw = fs.readFileSync(minQtyPath, 'utf8');
  const json = JSON.parse(raw);
  const list = Array.isArray(json.selectedSymbols) ? json.selectedSymbols : [];
  const symbols = list.map((s) => String(s).trim()).filter(Boolean);
  if (symbols.length === 0) {
    throw new Error(`min-order-qty 无 selectedSymbols: ${minQtyPath}`);
  }
  return { symbols, pair: json.pair || null, path: minQtyPath, count: symbols.length };
}

function compactSymbol(s) {
  return String(s || '').replace(/[-_]/g, '').toUpperCase();
}

function toCrossExFutureSymbol(symbol, venue) {
  const raw = String(symbol || '').trim();
  const s = compactSymbol(raw);
  const base = s.endsWith('USDT') ? s.slice(0, -4) : s;
  return `${venue}_FUTURE_${base}_USDT`;
}

function toOkxInstId(symbol) {
  const raw = String(symbol || '').trim();
  const s = compactSymbol(raw);
  const base = s.endsWith('USDT') ? s.slice(0, -4) : s;
  return `${base}-USDT-SWAP`;
}

function toBinanceStream(symbol) {
  return `${String(symbol || '').replace(/[-_]/g, '').toLowerCase()}@bookTicker`;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

class LatencyStats {
  constructor(label) {
    this.label = label;
    this.wsDelay = [];
    this.gatePushDelay = [];
    this.interArrival = [];
    this.count = 0;
    this._lastReceive = null;
  }

  record({ wsDelayMs, gatePushDelayMs = null }) {
    const now = Date.now();
    if (this._lastReceive != null) {
      this.interArrival.push(now - this._lastReceive);
    }
    this._lastReceive = now;
    if (wsDelayMs != null && Number.isFinite(wsDelayMs) && wsDelayMs >= 0 && wsDelayMs < 30_000) {
      this.wsDelay.push(wsDelayMs);
    }
    if (gatePushDelayMs != null && Number.isFinite(gatePushDelayMs) && gatePushDelayMs >= 0) {
      this.gatePushDelay.push(gatePushDelayMs);
    }
    this.count += 1;
  }

  summary() {
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    return {
      label: this.label,
      messages: this.count,
      wsDelay: {
        n: this.wsDelay.length,
        avg: avg(this.wsDelay),
        p50: pct(this.wsDelay, 50),
        p95: pct(this.wsDelay, 95),
        max: this.wsDelay.length ? Math.max(...this.wsDelay) : null
      },
      gateExtra: {
        n: this.gatePushDelay.length,
        avg: avg(this.gatePushDelay),
        p50: pct(this.gatePushDelay, 50),
        p95: pct(this.gatePushDelay, 95)
      },
      interArrival: {
        n: this.interArrival.length,
        avg: avg(this.interArrival),
        p50: pct(this.interArrival, 50)
      }
    };
  }
}

function fmtMs(v) {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)} ms`;
}

function printSummary(rows) {
  console.log('\n=== WS 延迟汇总 (wsDelay = 本机收到 − exchangeTs) ===\n');
  for (const s of rows) {
    console.log(`[${s.label}] 消息 ${s.messages}  有效 wsDelay 样本 ${s.wsDelay.n}`);
    console.log(`  wsDelay  avg ${fmtMs(s.wsDelay.avg)}  p50 ${fmtMs(s.wsDelay.p50)}  p95 ${fmtMs(s.wsDelay.p95)}  max ${fmtMs(s.wsDelay.max)}`);
    if (s.gateExtra.n > 0) {
      console.log(`  Gate层额外 (time_ms − ts)  avg ${fmtMs(s.gateExtra.avg)}  p50 ${fmtMs(s.gateExtra.p50)}  p95 ${fmtMs(s.gateExtra.p95)}`);
    }
    console.log(`  推送间隔     avg ${fmtMs(s.interArrival.avg)}  p50 ${fmtMs(s.interArrival.p50)}`);
    console.log('');
  }
}

function printCompactTable(rows) {
  console.log('=== 一览 (按 wsDelay p50 降序) ===\n');
  console.log('label'.padEnd(36), 'n'.padStart(5), 'p50'.padStart(8), 'p95'.padStart(8), '间隔p50'.padStart(10));
  const sorted = [...rows].sort((a, b) => (b.wsDelay.p50 ?? -1) - (a.wsDelay.p50 ?? -1));
  for (const s of sorted) {
    console.log(
      s.label.padEnd(36),
      String(s.wsDelay.n).padStart(5),
      fmtMs(s.wsDelay.p50).padStart(8),
      fmtMs(s.wsDelay.p95).padStart(8),
      fmtMs(s.interArrival.p50).padStart(10)
    );
  }
  console.log('');
}

function aggregateVenue(rows, prefix) {
  const matched = rows.filter((r) => r.label.startsWith(prefix));
  if (!matched.length) return null;
  const all = matched.flatMap((r) => {
    const st = new LatencyStats('tmp');
    // reconstruct not available - compute weighted from summaries only approx
    return [];
  });
  void all;
  const wsDelays = [];
  const intervals = [];
  for (const r of matched) {
    if (r.wsDelay.p50 != null) wsDelays.push(r.wsDelay.p50);
    if (r.interArrival.p50 != null) intervals.push(r.interArrival.p50);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    label: `${prefix}* (${matched.length} symbols, p50 avg)`,
    messages: matched.reduce((s, r) => s + r.messages, 0),
    wsDelay: { n: wsDelays.length, avg: avg(wsDelays), p50: avg(wsDelays), p95: null, max: null },
    gateExtra: { n: 0 },
    interArrival: { n: intervals.length, avg: avg(intervals), p50: avg(intervals) }
  };
}

function connectCrossEx({ symbols, channel, statsByKey }) {
  const ws = new WebSocket(CROSSEX_WS);
  const payload = [];
  for (const sym of symbols) {
    payload.push(toCrossExFutureSymbol(sym, 'BINANCE'));
    payload.push(toCrossExFutureSymbol(sym, 'OKX'));
  }

  ws.on('open', () => {
    ws.send(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      event: 'subscribe',
      channel,
      payload
    }));
    console.log(`[CrossEx] connected ${CROSSEX_WS}`);
    console.log(`[CrossEx] subscribe ${channel} x ${payload.length} (${symbols.length} 币种 × 2 所)`);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.event === 'subscribe') return;
      if (msg?.error) {
        console.warn('[CrossEx] error:', JSON.stringify(msg.error));
        return;
      }
      const r = msg?.result;
      if (!r?.s) return;
      const exchangeTs = Number(r.ts);
      const localTs = Date.now();
      const gateMs = Number(msg.time_ms);
      if (!Number.isFinite(exchangeTs)) return;

      const key = String(r.s);
      if (!statsByKey.has(key)) statsByKey.set(key, new LatencyStats(key));
      statsByKey.get(key).record({
        wsDelayMs: localTs - exchangeTs,
        gatePushDelayMs: Number.isFinite(gateMs) ? gateMs - exchangeTs : null
      });
    } catch {
      // ignore
    }
  });

  ws.on('error', (err) => console.warn('[CrossEx]', err.message));
  return ws;
}

function connectBinanceCombined(symbols, statsBySymbol) {
  const streams = symbols.map((s) => encodeURIComponent(toBinanceStream(s))).join('/');
  const url = `${BINANCE_WS.replace(/\/$/, '')}/stream?streams=${streams}`;
  const ws = new WebSocket(url);
  ws.on('open', () => console.log(`[Binance direct] combined ${symbols.length} streams`));
  ws.on('message', (raw) => {
    try {
      const wrap = JSON.parse(raw.toString());
      const p = wrap?.data || wrap;
      const sym = String(p?.s || '').toUpperCase();
      if (!sym) return;
      const exchangeTs = Number(p.E ?? p.T);
      if (!Number.isFinite(exchangeTs)) return;
      const label = `Binance ${sym}`;
      if (!statsBySymbol.has(label)) statsBySymbol.set(label, new LatencyStats(label));
      statsBySymbol.get(label).record({ wsDelayMs: Date.now() - exchangeTs });
    } catch { /* ignore */ }
  });
  ws.on('error', (e) => console.warn('[Binance direct]', e.message));
  return ws;
}

function connectOkxCombined(symbols, statsBySymbol) {
  const ws = new WebSocket(OKX_WS);
  ws.on('open', () => {
    const args = symbols.map((sym) => ({ channel: 'bbo-tbt', instId: toOkxInstId(sym) }));
    for (let i = 0; i < args.length; i += 50) {
      ws.send(JSON.stringify({ op: 'subscribe', args: args.slice(i, i + 50) }));
    }
    console.log(`[OKX direct] bbo-tbt x ${symbols.length}`);
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const row = msg?.data?.[0];
      const instId = String(row?.instId || msg?.arg?.instId || '');
      if (!instId || !row) return;
      const exchangeTs = Number(row.ts);
      if (!Number.isFinite(exchangeTs)) return;
      const label = `OKX ${compactSymbol(instId.replace('-SWAP', ''))}`;
      if (!statsBySymbol.has(label)) statsBySymbol.set(label, new LatencyStats(label));
      statsBySymbol.get(label).record({ wsDelayMs: Date.now() - exchangeTs });
    } catch { /* ignore */ }
  });
  ws.on('error', (e) => console.warn('[OKX direct]', e.message));
  return ws;
}

async function main() {
  const args = parseArgs(process.argv);
  let meta = null;
  if (args.minQtyPath) {
    meta = loadSelectedSymbols(args.minQtyPath);
    args.symbols = meta.symbols;
    if (args.durationSec === 30 && meta.count > 1) {
      args.durationSec = Math.max(45, Math.min(120, 30 + meta.count * 3));
    }
  }
  if (!args.symbols?.length) {
    args.symbols = ['BTCUSDT'];
  }

  console.log(`探测 ${args.durationSec}s  compare=${args.compare}  channel=${args.channel}`);
  if (meta) {
    console.log(`来源 ${meta.path}`);
    console.log(`pair ${meta.pair ? `${meta.pair.providerA}/${meta.pair.providerB}` : '—'}  selected=${meta.count}`);
  }
  console.log(`币种: ${args.symbols.join(', ')}`);

  const crossStats = new Map();
  const directBinance = new Map();
  const directOkx = new Map();

  const sockets = [
    connectCrossEx({ symbols: args.symbols, channel: args.channel, statsByKey: crossStats })
  ];
  if (args.compare) {
    sockets.push(connectBinanceCombined(args.symbols, directBinance));
    sockets.push(connectOkxCombined(args.symbols, directOkx));
  }

  await new Promise((r) => setTimeout(r, args.durationSec * 1000));

  for (const ws of sockets) {
    try { ws.close(); } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 500));

  const summaries = [];

  if (args.compare) {
    for (const [, st] of directOkx) summaries.push(st.summary());
    for (const [, st] of directBinance) summaries.push(st.summary());
  }
  for (const [, st] of crossStats) summaries.push(st.summary());
  summaries.sort((a, b) => a.label.localeCompare(b.label));

  printSummary(summaries);
  printCompactTable(summaries);

  const cxBin = aggregateVenue(summaries, 'BINANCE_FUTURE_');
  const cxOkx = aggregateVenue(summaries, 'OKX_FUTURE_');
  if (cxBin || cxOkx) {
    console.log('=== CrossEx venue 粗均 (各币 p50 平均) ===');
    if (cxOkx) console.log(`  ${cxOkx.label}: wsDelay p50 avg ${fmtMs(cxOkx.wsDelay.p50)}  间隔 p50 ${fmtMs(cxOkx.interArrival.p50)}`);
    if (cxBin) console.log(`  ${cxBin.label}: wsDelay p50 avg ${fmtMs(cxBin.wsDelay.p50)}  间隔 p50 ${fmtMs(cxBin.interArrival.p50)}`);
    console.log('');
  }

  const noMsg = summaries.filter((s) => s.wsDelay.n === 0).map((s) => s.label);
  if (noMsg.length) {
    console.log('⚠️ 无有效样本 (CrossEx 可能不支持或符号错误):');
    noMsg.forEach((l) => console.log(`   ${l}`));
    console.log('');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[probe-crossex-ws-latency]', err.message);
  process.exit(1);
});
