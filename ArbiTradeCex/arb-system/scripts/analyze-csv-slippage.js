#!/usr/bin/env node
import fs from 'node:fs';
import { calcLegSlippageBps, formatSlippageBps } from '../arbitrage/monitoring/trade-slippage.js';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/analyze-csv-slippage.js <trades.csv>');
  process.exit(1);
}

const text = fs.readFileSync(csvPath, 'utf8');
const lines = text.trim().split(/\r?\n/);
const header = lines[0].split(',');
const idx = (name) => header.indexOf(name);

function slip(side, nominal, fill) {
  return calcLegSlippageBps({ side, nominal, fill });
}

const rows = [];
for (let i = 1; i < lines.length; i += 1) {
  const p = lines[i].split(',');
  if (p.length < header.length) continue;
  const get = (name) => p[idx(name)];
  rows.push({
    time: get('timestamp_iso')?.slice(11, 19),
    symbol: get('symbol'),
    action: get('action'),
    direction: get('direction'),
    aSide: get('a_side'),
    aNom: Number(get('a_price_nominal')),
    aSend: Number(get('send_a_price')),
    aFill: Number(get('a_fill_price')),
    bSide: get('b_side'),
    bNom: Number(get('b_price_nominal')),
    bSend: Number(get('send_b_price')),
    bFill: Number(get('b_fill_price')),
    netPnl: Number(get('net_pnl')),
    aPos: get('a_pos_qty'),
    bPos: get('b_pos_qty')
  });
}

const bySym = {};

console.log('时间 | 币对 | 动作 | A腿滑点 | B腿滑点 | 两腿合计 | 净利');
console.log('-'.repeat(85));

for (const r of rows) {
  const aSlip = slip(r.aSide, r.aNom, r.aFill);
  const bSlip = slip(r.bSide, r.bNom, r.bFill);
  const aSendSlip = slip(r.aSide, r.aSend, r.aFill);
  const bSendSlip = slip(r.bSide, r.bSend, r.bFill);
  const combo = (aSlip ?? 0) + (bSlip ?? 0);
  r.aSlip = aSlip;
  r.bSlip = bSlip;
  r.combo = combo;

  console.log(
    `${r.time} | ${r.symbol} | ${r.action} | `
    + `A(${r.aSide}) ${formatSlippageBps(aSlip)} | B(${r.bSide}) ${formatSlippageBps(bSlip)} | `
    + `${combo.toFixed(2)} bps | ${r.netPnl.toFixed(4)}`
  );

  if (!bySym[r.symbol]) bySym[r.symbol] = { a: [], b: [], combo: [], n: 0 };
  bySym[r.symbol].a.push(aSlip ?? 0);
  bySym[r.symbol].b.push(bSlip ?? 0);
  bySym[r.symbol].combo.push(combo);
  bySym[r.symbol].n += 1;
}

function stats(arr) {
  const sum = arr.reduce((s, n) => s + n, 0);
  return {
    avg: sum / arr.length,
    max: Math.max(...arr),
    min: Math.min(...arr)
  };
}

console.log('\n=== 汇总（相对发单名义价：卖@bid / 买@ask，+ = 不利）===');
for (const [sym, s] of Object.entries(bySym)) {
  const a = stats(s.a);
  const b = stats(s.b);
  const c = stats(s.combo);
  console.log(
    `${sym} (${s.n}笔): `
    + `Binance(A) 均${a.avg.toFixed(2)} 最大${a.max.toFixed(2)} bps | `
    + `Gate(B) 均${b.avg.toFixed(2)} 最大${b.max.toFixed(2)} bps | `
    + `两腿合计 均${c.avg.toFixed(2)} 最大${c.max.toFixed(2)} bps`
  );
}

const home = rows.filter((r) => r.symbol === 'HOMEUSDT');
const allo = rows.filter((r) => r.symbol === 'ALLOUSDT');

console.log('\n=== HOME 开仓/加仓：几乎全是 Binance 卖滑点 ===');
for (const r of home.filter((x) => x.action === 'open' || x.action === 'add')) {
  console.log(`  ${r.action} A卖 ${formatSlippageBps(r.aSlip)} B买 ${formatSlippageBps(r.bSlip)}`);
}

console.log('\n=== ALLO 平仓：Binance 买腿滑点明显偏大 ===');
for (const r of allo.filter((x) => x.action === 'close')) {
  console.log(`  ${r.action} A买 ${formatSlippageBps(r.aSlip)} B卖 ${formatSlippageBps(r.bSlip)}`);
}
