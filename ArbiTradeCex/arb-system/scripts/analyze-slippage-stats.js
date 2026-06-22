#!/usr/bin/env node
import fs from 'node:fs';
import { calcLegSlippageBps } from '../arbitrage/monitoring/trade-slippage.js';

const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/analyze-slippage-stats.js <trades.csv>');
  process.exit(1);
}

const csv = fs.readFileSync(csvPath, 'utf8');
const lines = csv.trim().split(/\r?\n/);
const h = lines[0].split(',');
const ix = (n) => h.indexOf(n);
const num = (r, n) => {
  const v = Number(r[ix(n)]);
  return Number.isFinite(v) ? v : null;
};
const str = (r, n) => r[ix(n)] || '';

function slip(side, nom, fill) {
  if (!nom || !fill || fill <= 0) return null;
  return calcLegSlippageBps({ side, nominal: nom, fill });
}

const rows = [];
for (let i = 1; i < lines.length; i += 1) {
  const r = lines[i].split(',');
  if (r.length < h.length) continue;
  const aF = num(r, 'a_filled_qty');
  const bF = num(r, 'b_filled_qty');
  const aSl = aF > 0 ? slip(str(r, 'a_side'), num(r, 'send_a_price'), num(r, 'a_fill_price')) : null;
  const bSl = bF > 0 ? slip(str(r, 'b_side'), num(r, 'send_b_price'), num(r, 'b_fill_price')) : null;
  rows.push({
    sym: str(r, 'symbol'),
    action: str(r, 'action'),
    dir: str(r, 'direction'),
    aSl,
    bSl,
    combo: (aSl ?? 0) + (bSl ?? 0),
    bAge: num(r, 'lat_b_age_ms'),
    aAge: num(r, 'lat_a_age_ms'),
    skew: num(r, 'lat_leg_skew_ms'),
    orderSend: num(r, 'lat_stage_order_send_ms'),
    aSide: str(r, 'a_side'),
    bSide: str(r, 'b_side'),
    net: num(r, 'net_pnl'),
    legExp: str(r, 'leg_exposure') === 'true',
    spreadAb: num(r, 'spread_ab_pct'),
    spreadBa: num(r, 'spread_ba_pct')
  });
}

const avg = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const aSlips = rows.map((r) => r.aSl).filter((x) => x != null);
const bSlips = rows.map((r) => r.bSl).filter((x) => x != null);

console.log('=== 总体 ===');
console.log('笔数', rows.length);
console.log('A腿滑点 均', avg(aSlips).toFixed(2), '最大', Math.max(...aSlips).toFixed(2));
console.log('B腿滑点 均', avg(bSlips).toFixed(2), '最大', Math.max(...bSlips).toFixed(2));

const byAction = {};
for (const r of rows) {
  if (!byAction[r.action]) byAction[r.action] = { a: [], b: [] };
  if (r.aSl != null) byAction[r.action].a.push(r.aSl);
  if (r.bSl != null) byAction[r.action].b.push(r.bSl);
}
console.log('\n=== 按动作 ===');
for (const [k, v] of Object.entries(byAction)) {
  console.log(k, 'A均', avg(v.a).toFixed(2), 'B均', avg(v.b).toFixed(2), 'n', v.a.length);
}

const bySym = {};
for (const r of rows) {
  if (!bySym[r.sym]) bySym[r.sym] = { a: [], b: [], n: 0 };
  bySym[r.sym].n += 1;
  if (r.aSl != null) bySym[r.sym].a.push(r.aSl);
  if (r.bSl != null) bySym[r.sym].b.push(r.bSl);
}
console.log('\n=== 按币种 B腿滑点 TOP ===');
Object.entries(bySym)
  .sort((x, y) => avg(y[1].b) - avg(x[1].b))
  .slice(0, 10)
  .forEach(([s, v]) => console.log(s, 'n=' + v.n, 'A均', avg(v.a).toFixed(1), 'B均', avg(v.b).toFixed(1)));

console.log('\n=== B腿龄 vs B滑点 ===');
for (const [lo, hi, label] of [[0, 100, '0-100ms'], [100, 500, '100-500ms'], [500, 1000, '500-1000ms'], [1000, 1e9, '1000ms+']]) {
  const subset = rows.filter((r) => r.bSl != null && r.bAge >= lo && r.bAge < hi);
  if (!subset.length) continue;
  console.log(label, 'n=' + subset.length, 'B滑点均', avg(subset.map((r) => r.bSl)).toFixed(2));
}

console.log('\n=== 发单耗时 vs B滑点 ===');
for (const [lo, hi, label] of [[0, 100, '0-100ms'], [100, 300, '100-300ms'], [300, 600, '300-600ms'], [600, 1e9, '600ms+']]) {
  const subset = rows.filter((r) => r.bSl != null && r.orderSend >= lo && r.orderSend < hi);
  if (!subset.length) continue;
  console.log(label, 'n=' + subset.length, 'B滑点均', avg(subset.map((r) => r.bSl)).toFixed(2));
}

console.log('\n=== 两腿合计滑点 TOP10 ===');
rows
  .filter((r) => r.aSl != null && r.bSl != null)
  .sort((a, b) => b.combo - a.combo)
  .slice(0, 10)
  .forEach((r) => {
    console.log(
      r.sym,
      r.action,
      'A',
      r.aSl.toFixed(1),
      'B',
      r.bSl.toFixed(1),
      'combo',
      r.combo.toFixed(1),
      'bAge',
      r.bAge,
      'send',
      r.orderSend
    );
  });

const bSell = rows.filter((r) => r.bSide === 'sell' && r.bSl != null);
const bBuy = rows.filter((r) => r.bSide === 'buy' && r.bSl != null);
console.log('\n=== B腿方向 ===');
console.log('B sell 均', avg(bSell.map((r) => r.bSl)).toFixed(2), 'n', bSell.length);
console.log('B buy 均', avg(bBuy.map((r) => r.bSl)).toFixed(2), 'n', bBuy.length);

console.log('\n=== 有利滑点(<=0)占比 ===');
console.log('A', aSlips.filter((x) => x <= 0).length + '/' + aSlips.length);
console.log('B', bSlips.filter((x) => x <= 0).length + '/' + bSlips.length);

// correlation: high bAge trades
const stale = rows.filter((r) => r.bAge >= 1000 && r.bSl != null);
const fresh = rows.filter((r) => r.bAge < 100 && r.bSl != null);
console.log('\n=== B腿龄对比 ===');
console.log('B腿龄>=1000ms', 'n=' + stale.length, 'B滑点均', avg(stale.map((r) => r.bSl)).toFixed(2));
console.log('B腿龄<100ms', 'n=' + fresh.length, 'B滑点均', avg(fresh.map((r) => r.bSl)).toFixed(2));

// net pnl vs combo slippage
const badSlip = rows.filter((r) => r.aSl != null && r.bSl != null && r.combo > 50);
console.log('\n=== 合计滑点>50bps 的笔数 ===', badSlip.length, '净利均', avg(badSlip.map((r) => r.net)).toFixed(4));
