#!/usr/bin/env node
/**
 * 从 live-trades.csv 生成逐笔交易分析 Markdown（滑点 + 延迟）
 * Usage: node scripts/analyze-csv-trades-md.js <trades.csv> [output.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { calcLegSlippageBps, formatSlippageBps } from '../arbitrage/monitoring/trade-slippage.js';

const csvPath = process.argv[2];
const outPath = process.argv[3];
if (!csvPath) {
  console.error('Usage: node scripts/analyze-csv-trades-md.js <trades.csv> [output.md]');
  process.exit(1);
}

const ACTION_CN = { open: '开仓', close: '平仓', add: '加仓', force_close: '强平' };
const LEG_A = 'Binance(A腿)';
const LEG_B = 'Aster(B腿)';

const text = fs.readFileSync(csvPath, 'utf8');
const lines = text.trim().split(/\r?\n/);
const header = lines[0].split(',');
const idx = (name) => header.indexOf(name);

const hasPerLegSubmit = idx('lat_a_order_send_ms') >= 0 && idx('lat_b_order_send_ms') >= 0;

function num(row, name) {
  if (idx(name) < 0) return null;
  const v = Number(row[idx(name)]);
  return Number.isFinite(v) ? v : null;
}

function str(row, name) {
  if (idx(name) < 0) return null;
  const v = row[idx(name)];
  return v == null || v === '' ? null : v;
}

function ms(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
  return `${Math.round(Number(v))} ms`;
}

function slip(side, nominal, fill) {
  if (nominal == null || fill == null) return null;
  return calcLegSlippageBps({ side, nominal, fill });
}

function fmtSlip(bps) {
  const s = formatSlippageBps(bps);
  return s ?? '—';
}

const rows = [];
for (let i = 1; i < lines.length; i += 1) {
  const p = lines[i].split(',');
  if (p.length < header.length) continue;
  rows.push(p);
}

const summary = {
  n: rows.length,
  aSlips: [],
  bSlips: [],
  legExposure: 0,
  wsTransit: [],
  decisionToSubmit: [],
  orderSend: [],
  aOrderSend: [],
  bOrderSend: []
};

const schemaNote = hasPerLegSubmit
  ? ''
  : '\n> ⚠️ 当前 CSV **无** `lat_a_order_send_ms` / `lat_b_order_send_ms` 列（旧版导出）。发单提交仅显示并行耗时；重新跑实盘后新生成的 CSV 会含 A/B 分腿耗时。\n';

let md = `# live-trades 逐笔交易分析报告

> 数据源：\`${path.basename(csvPath)}\`  
> 生成时间：${new Date().toISOString()}  
> 共 **${rows.length}** 笔成交记录${schemaNote}

## 字段说明

| 类别 | 字段 | 含义 |
|------|------|------|
| 滑点 | 相对**发单名义价**（买@ask / 卖@bid） | **+ bps = 对该腿不利**；0 或负 = 有利或持平 |
| WS延迟 | WS传输(合计) | 较新腿：交易所推送时间 → 本机接收时间（单包网络耗时） |
| WS延迟 | 发单时A/B腿龄 | 发单瞬间，该腿报价距**本机最后一次收到**已过多久（越大越旧） |
| WS延迟 | A/B腿WS传输 | 各腿 bookTicker 推送 → 本机接收 |
| 处理延迟 | 算量 / 刷账户 / 预占 / 排队 / 拉新价 / 预检 / 待发 | 信号触发到发单前的各阶段耗时 |
| 发单 | A/B腿提交完成 | 各腿 \`placeOrder\` API 返回耗时（两腿并行发出） |
| 发单 | 发单提交(并行) | max(A腿, B腿)，即较慢腿耗时 |
| 端到端 | 信号→发单开始 / 信号→提交完成 | 从策略收到信号到开始发单 / 两腿 API 均返回 |

---

`;

for (let i = 0; i < rows.length; i += 1) {
  const r = rows[i];
  const n = i + 1;
  const time = str(r, 'timestamp_iso') ?? '';
  const symbol = str(r, 'symbol') ?? '';
  const action = ACTION_CN[str(r, 'action')] ?? str(r, 'action');
  const direction = str(r, 'direction') ?? '';
  const legExp = str(r, 'leg_exposure') === 'true';
  const failedLeg = str(r, 'failed_leg');
  const failReason = str(r, 'fail_reason');

  const aSide = str(r, 'a_side');
  const bSide = str(r, 'b_side');
  const aSend = num(r, 'send_a_price');
  const bSend = num(r, 'send_b_price');
  const aFill = num(r, 'a_fill_price');
  const bFill = num(r, 'b_fill_price');
  const aFilled = num(r, 'a_filled_qty');
  const bFilled = num(r, 'b_filled_qty');

  const aSlip = aFilled > 0 ? slip(aSide, aSend, aFill) : null;
  const bSlip = bFilled > 0 ? slip(bSide, bSend, bFill) : null;
  if (aSlip != null) summary.aSlips.push(aSlip);
  if (bSlip != null) summary.bSlips.push(bSlip);
  if (legExp) summary.legExposure += 1;

  const wsTransit = num(r, 'lat_ws_transit_ms');
  const decisionDone = num(r, 'lat_decision_to_submit_done_ms');
  const orderSend = num(r, 'lat_stage_order_send_ms');
  const aOrderSend = num(r, 'lat_a_order_send_ms');
  const bOrderSend = num(r, 'lat_b_order_send_ms');
  if (wsTransit != null) summary.wsTransit.push(wsTransit);
  if (decisionDone != null) summary.decisionToSubmit.push(decisionDone);
  if (orderSend != null) summary.orderSend.push(orderSend);
  if (aOrderSend != null) summary.aOrderSend.push(aOrderSend);
  if (bOrderSend != null) summary.bOrderSend.push(bOrderSend);

  const stageParts = [
    ['算量', num(r, 'lat_stage_calc_ms')],
    ['刷账户', num(r, 'lat_stage_account_ms')],
    ['预占', num(r, 'lat_stage_reserve_ms')],
    ['排队', num(r, 'lat_stage_queue_ms')],
    ['拉新价', num(r, 'lat_stage_fresh_tick_ms')],
    ['预检', num(r, 'lat_stage_precheck_ms')],
    ['待发', num(r, 'lat_stage_presend_ms')]
  ].filter(([, v]) => v != null && v > 0)
    .map(([label, v]) => `${label} ${ms(v)}`)
    .join(' · ');

  const netPnl = num(r, 'net_pnl');
  const tag = legExp ? ' ⚠️ **单腿**' : '';

  const perLegSubmitRows = hasPerLegSubmit
    ? `| ${LEG_A}提交完成 | **${ms(aOrderSend)}** |
| ${LEG_B}提交完成 | **${ms(bOrderSend)}** |
`
    : `| ${LEG_A}提交完成 | —（旧CSV无分腿字段） |
| ${LEG_B}提交完成 | —（旧CSV无分腿字段） |
`;

  md += `## ${n}. ${symbol} · ${action} · ${direction}${tag}

| 项目 | 值 |
|------|-----|
| 时间(UTC) | ${time} |
| 锁定方向 | ${str(r, 'locked_direction') ?? '—'} |
| 数量 | ${str(r, 'qty') ?? '—'}（A成交 ${aFilled ?? 0} / B成交 ${bFilled ?? 0}） |
| 净利(USDT) | ${netPnl != null ? netPnl.toFixed(4) : '—'} |
${legExp ? `| 单腿说明 | 失败腿=${failedLeg ?? '?'}；${failReason ?? '—'} |\n` : ''}
### 滑点（相对发单名义价，+ = 不利）

| 交易所 | 方向 | 发单价 | 成交价 | 滑点 |
|--------|------|--------|--------|------|
| ${LEG_A} | ${aSide ?? '—'} | ${aSend ?? '—'} | ${aFilled > 0 ? aFill : '未成交'} | **${aFilled > 0 ? fmtSlip(aSlip) : '—'}** |
| ${LEG_B} | ${bSide ?? '—'} | ${bSend ?? '—'} | ${bFilled > 0 ? bFill : '未成交'} | **${bFilled > 0 ? fmtSlip(bSlip) : '—'}** |
| 两腿合计 | — | — | — | **${aSlip != null && bSlip != null ? `${(aSlip + bSlip).toFixed(2)} bps` : '—'}** |

### WS 推送 → 本机接收

| 指标 | 耗时 |
|------|------|
| WS传输(较新腿合计) | ${ms(num(r, 'lat_ws_transit_ms'))} |
| A腿WS传输 | ${ms(num(r, 'lat_a_ws_transit_ms'))} |
| B腿WS传输 | ${ms(num(r, 'lat_b_ws_transit_ms'))} |
| 发单时A腿龄 | ${ms(num(r, 'lat_a_age_ms'))} |
| 发单时B腿龄 | ${ms(num(r, 'lat_b_age_ms'))} |
| 两腿延迟差 | ${ms(num(r, 'lat_leg_skew_ms'))} |
| 发单时最旧腿龄 | ${ms(num(r, 'lat_price_age_at_order_ms'))} |

### 中间处理过程

| 阶段 | 耗时 |
|------|------|
| ${stageParts || '（各阶段均为 0 或未记录）'} | |
| **处理小计(信号→发单开始)** | **${ms(num(r, 'lat_decision_to_order_ms'))}** |

### 发单提交

| 指标 | 耗时 |
|------|------|
${perLegSubmitRows}| 发单提交(并行·较慢腿) | **${ms(orderSend)}** |
| 信号→提交完成(含发单) | ${ms(num(r, 'lat_decision_to_submit_done_ms'))} |
| WS推送→发单开始 | ${ms(num(r, 'lat_ws_push_to_order_ms'))} |
| 本机接收→发单开始 | ${ms(num(r, 'lat_receive_to_order_ms'))} |

---

`;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, n) => s + n, 0) / arr.length;
}

function statLine(arr, unit = '') {
  if (!arr.length) return '—';
  const a = avg(arr);
  const mx = Math.max(...arr);
  const mn = Math.min(...arr);
  return `均 ${a.toFixed(1)}${unit} · 最大 ${mx.toFixed(0)}${unit} · 最小 ${mn.toFixed(0)}${unit}（${arr.length}笔）`;
}

md += `## 汇总统计

| 指标 | ${LEG_A} | ${LEG_B} | 其他 |
|------|----------|----------|------|
| 滑点(均值) | ${summary.aSlips.length ? `${avg(summary.aSlips).toFixed(2)} bps` : '—'} | ${summary.bSlips.length ? `${avg(summary.bSlips).toFixed(2)} bps` : '—'} | 单腿成交 **${summary.legExposure}** 笔 |
| 发单提交完成 | ${statLine(summary.aOrderSend, ' ms')} | ${statLine(summary.bOrderSend, ' ms')} | 并行(较慢腿) ${statLine(summary.orderSend, ' ms')} |
| WS传输延迟 | — | — | ${statLine(summary.wsTransit, ' ms')} |
| 信号→提交完成 | — | — | ${statLine(summary.decisionToSubmit, ' ms')} |

`;

const defaultOut = path.join(path.dirname(csvPath), 'live-trades-analysis.md');
const target = outPath || defaultOut;
fs.writeFileSync(target, md, 'utf8');
console.log(`Written: ${target} (${rows.length} trades)`);
