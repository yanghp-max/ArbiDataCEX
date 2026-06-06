/**
 * 单笔交易全链路延迟追踪（基准 = tick.priceReceiveMs，即 WS 较晚一侧到达本机）
 */

export function createTradeLatencyTrace(tick) {
  const originMs = Number(tick?.priceReceiveMs ?? tick?.localTimestamp ?? Date.now());
  return {
    originMs,
    tickMeta: {
      wsA: tick?.aLatencyMs ?? null,
      wsB: tick?.bLatencyMs ?? null,
      wsMax: tick?.maxWsLatencyMs ?? null,
      priceAgeMs: tick?.priceAgeMs ?? null,
      legSkewMs: tick?.legSkewMs ?? null
    },
    marks: {},
    legs: {
      binance: { placeMs: null, pollMs: null },
      gate: { placeMs: null, pollMs: null }
    }
  };
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

export function setLegLatency(trace, exchange, { placeMs = null, pollMs = null } = {}) {
  if (!trace?.legs) return trace;
  const leg = trace.legs[exchange];
  if (!leg) return trace;
  if (placeMs != null) leg.placeMs = placeMs;
  if (pollMs != null) leg.pollMs = pollMs;
  return trace;
}

function sinceOrigin(trace, stage) {
  const t = trace?.marks?.[stage];
  if (t == null || trace?.originMs == null) return null;
  return Math.max(0, t - trace.originMs);
}

function segment(trace, from, to) {
  const a = trace?.marks?.[from];
  const b = trace?.marks?.[to];
  if (a == null || b == null) return null;
  return Math.max(0, b - a);
}

export function finalizeTradeLatency(trace) {
  markLatency(trace, 'trade_done');
  return trace;
}

/** 终端多行日志 */
export function formatLatencyLogLines(trace) {
  if (!trace) return [];
  const lines = ['[延迟] 基准=WS收价 (priceReceiveMs)'];
  const { tickMeta } = trace;
  if (tickMeta.wsA != null || tickMeta.wsB != null) {
    lines.push(
      `  WS传输: Binance=${fmtMs(tickMeta.wsA)} Gate=${fmtMs(tickMeta.wsB)}`
      + ` max=${fmtMs(tickMeta.wsMax)}`
    );
  }
  lines.push(
    `  行情: 年龄=${fmtMs(tickMeta.priceAgeMs)} 两腿skew=${fmtMs(tickMeta.legSkewMs)}`
  );

  const decisionMs = sinceOrigin(trace, 'trade_plan');
  if (decisionMs != null) {
    lines.push(`  收价→决策: ${decisionMs}ms (含信号/Z分数/筛选)`);
  }

  const stages = [
    ['trade_plan', '信号→决策通过'],
    ['order_built', '算量/风控'],
    ['pre_order_gate', 'signalMaxAge检查'],
    ['account_fresh', '余额刷新'],
    ['reserve_done', '预占资源'],
    ['execute_start', '进入异步执行'],
    ['recheck_pass', '执行前复核'],
    ['order_send_start', '发单开始'],
    ['order_place_done', '下单API返回'],
    ['order_poll_done', '成交轮询完成'],
    ['pos_refresh', '持仓刷新'],
    ['trade_done', '成交记录完成']
  ];

  for (const [key, label] of stages) {
    const cum = sinceOrigin(trace, key);
    if (cum == null) continue;
    const prevIdx = stages.findIndex(([k]) => k === key) - 1;
    let seg = null;
    if (prevIdx >= 0) {
      seg = segment(trace, stages[prevIdx][0], key);
    } else {
      seg = segment(trace, 'trade_plan', key);
    }
    const segPart = seg != null ? ` (+${seg}ms)` : '';
    lines.push(`  ${label}: 累计 ${cum}ms${segPart}`);
  }

  const bn = trace.legs?.binance ?? {};
  const gt = trace.legs?.gate ?? {};
  if (bn.placeMs != null || gt.placeMs != null) {
    lines.push(
      `  下单API耗时: Binance=${fmtMs(bn.placeMs)} Gate=${fmtMs(gt.placeMs)}`
      + ` 并行max=${fmtMs(Math.max(bn.placeMs ?? 0, gt.placeMs ?? 0))}`
    );
  }
  if (bn.pollMs != null || gt.pollMs != null) {
    lines.push(
      `  成交轮询: Binance=${fmtMs(bn.pollMs)} Gate=${fmtMs(gt.pollMs)}`
    );
  }

  const total = sinceOrigin(trace, 'trade_done');
  if (total != null) {
    lines.push(`  总耗时(收价→成交确认): ${total}ms`);
  }
  return lines;
}

export function latencyCsvFields(trace) {
  if (!trace) return {};
  const bn = trace.legs?.binance ?? {};
  const gt = trace.legs?.gate ?? {};
  const placeMax = Math.max(bn.placeMs ?? 0, gt.placeMs ?? 0) || null;
  return {
    lat_ws_a_ms: trace.tickMeta?.wsA ?? '',
    lat_ws_b_ms: trace.tickMeta?.wsB ?? '',
    lat_ws_max_ms: trace.tickMeta?.wsMax ?? '',
    lat_price_age_ms: trace.tickMeta?.priceAgeMs ?? '',
    lat_leg_skew_ms: trace.tickMeta?.legSkewMs ?? '',
    lat_decision_ms: sinceOrigin(trace, 'trade_plan') ?? '',
    lat_order_build_ms: segment(trace, 'trade_plan', 'order_built') ?? '',
    lat_pre_order_ms: sinceOrigin(trace, 'pre_order_gate') ?? '',
    lat_account_fresh_ms: segment(trace, 'pre_order_gate', 'account_fresh') ?? '',
    lat_reserve_ms: segment(trace, 'account_fresh', 'reserve_done') ?? '',
    lat_async_queue_ms: segment(trace, 'reserve_done', 'execute_start') ?? '',
    lat_recheck_ms: segment(trace, 'execute_start', 'recheck_pass') ?? '',
    lat_order_place_binance_ms: bn.placeMs ?? '',
    lat_order_place_gate_ms: gt.placeMs ?? '',
    lat_order_place_max_ms: placeMax ?? '',
    lat_order_poll_binance_ms: bn.pollMs ?? '',
    lat_order_poll_gate_ms: gt.pollMs ?? '',
    lat_pos_refresh_ms: segment(trace, 'order_poll_done', 'pos_refresh') ?? '',
    lat_total_ms: sinceOrigin(trace, 'trade_done') ?? ''
  };
}

function fmtMs(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return `${Math.round(Number(v))}ms`;
}

export default {
  createTradeLatencyTrace,
  markLatency,
  setLegLatency,
  finalizeTradeLatency,
  formatLatencyLogLines,
  latencyCsvFields
};
