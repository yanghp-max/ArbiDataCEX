/**
 * 延迟链路：WS 推送时间 → 本机接收 → 各处理阶段 → 发单
 * 行情锚点用发单前 fresh tick（较新腿官方时间 = WS 推送基准）
 */
import { legPricesForDirection } from '../services/spread-calculator.js';

const PROCESS_STAGES = [
  ['trace_start', 'prep_done', '算量'],
  ['prep_done', 'account_fresh_done', '刷账户'],
  ['account_fresh_done', 'reserve_done', '预占'],
  ['reserve_done', 'exec_async_start', '排队'],
  ['exec_async_start', 'fresh_tick_done', '拉新价'],
  ['fresh_tick_done', 'pre_order_done', '预检'],
  ['pre_order_done', 'order_send_start', '待发'],
  ['order_send_start', 'order_send_done', '发单提交']
];

function tickPriceReceiveMs(tick) {
  if (tick?.priceReceiveMs != null && Number.isFinite(Number(tick.priceReceiveMs))) {
    return Number(tick.priceReceiveMs);
  }
  if (tick?.localTimestamp != null && Number.isFinite(Number(tick.localTimestamp))) {
    return Number(tick.localTimestamp);
  }
  return null;
}

/** 两腿较新者官方时间（WS 推送/E） */
export function tickOfficialExchangeMs(tick) {
  if (tick?.timestamp != null && Number.isFinite(Number(tick.timestamp))) {
    return Number(tick.timestamp);
  }
  return null;
}

function snapshotQuoteTiming(tick) {
  if (!tick) return null;
  const wsPushMs = tickOfficialExchangeMs(tick);
  const receiveMs = tickPriceReceiveMs(tick);
  let wsTransitMs = null;
  if (wsPushMs != null && receiveMs != null) {
    wsTransitMs = Math.max(0, receiveMs - wsPushMs);
  }
  return {
    wsPushMs,
    receiveMs,
    wsTransitMs,
    priceAgeMs: Number.isFinite(Number(tick.priceAgeMs)) ? Number(tick.priceAgeMs) : null,
    aAgeMs: Number.isFinite(Number(tick.aAgeMs)) ? Number(tick.aAgeMs) : null,
    bAgeMs: Number.isFinite(Number(tick.bAgeMs)) ? Number(tick.bAgeMs) : null,
    legSkewMs: Number.isFinite(Number(tick.legSkewMs)) ? Number(tick.legSkewMs) : null,
    aLatencyMs: Number.isFinite(Number(tick.aLatencyMs)) ? Number(tick.aLatencyMs) : null,
    bLatencyMs: Number.isFinite(Number(tick.bLatencyMs)) ? Number(tick.bLatencyMs) : null,
    aWsTransitMs: legWsTransitMs(tick.aServerTimestamp ?? tick.aExchangeTimestampMs, tick.aLocalTimestamp),
    bWsTransitMs: legWsTransitMs(tick.bServerTimestamp ?? tick.bExchangeTimestampMs, tick.bLocalTimestamp)
  };
}

function legWsTransitMs(serverTs, localTs) {
  const serverMs = normalizeServerMs(serverTs);
  const localMs = Number(localTs);
  if (serverMs == null || !Number.isFinite(localMs)) return null;
  return Math.max(0, localMs - serverMs);
}

function normalizeServerMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  return n > 1e12 ? n : n * 1000;
}

function quoteLegPrices(direction, src) {
  if (!src || !direction) return null;
  const { aPrice, bPrice } = legPricesForDirection(direction, src);
  return {
    aBid: src.aBid,
    aAsk: src.aAsk,
    bBid: src.bBid,
    bAsk: src.bAsk,
    aPrice,
    bPrice
  };
}

export function createTradeLatencyTrace(tick, { direction = null, priceSnapshot = null } = {}) {
  const now = Date.now();
  return {
    signalQuote: snapshotQuoteTiming(tick),
    orderQuote: null,
    priceStages: {
      direction,
      signal: quoteLegPrices(direction, priceSnapshot),
      send: null,
      fill: null
    },
    marks: {
      trace_start: now
    }
  };
}

export function setFreshTickOnLatencyTrace(trace, tick) {
  if (!trace) return trace;
  trace.orderQuote = snapshotQuoteTiming(tick);
  if (trace.priceStages?.direction) {
    trace.priceStages.send = quoteLegPrices(trace.priceStages.direction, tick);
  }
  return trace;
}

/** 成交后写入第三阶段价格（真实 fill） */
export function attachFillPricesToTrace(trace, fill) {
  if (!trace?.priceStages || !fill) return trace;
  trace.priceStages.fill = {
    aPrice: fill.aFilledQty > 0
      ? (fill.aFillPrice ?? fill.aPrice ?? fill.aPriceUsed ?? null)
      : null,
    bPrice: fill.bFilledQty > 0
      ? (fill.bFillPrice ?? fill.bPrice ?? fill.bPriceUsed ?? null)
      : null
  };
  return trace;
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

function markDelta(trace, fromMark, toMark) {
  const fromMs = trace?.marks?.[fromMark];
  const toMs = trace?.marks?.[toMark];
  if (fromMs == null || toMs == null) return null;
  return Math.max(0, toMs - fromMs);
}

function anchorToOrder(trace, anchorMs) {
  const orderMs = trace?.marks?.order_send_start;
  if (anchorMs == null || orderMs == null) return null;
  return Math.max(0, orderMs - anchorMs);
}

export function latencyProcessStages(trace) {
  const out = [];
  for (const [from, to, label] of PROCESS_STAGES) {
    const ms = markDelta(trace, from, to);
    if (ms != null) {
      out.push({ label, ms, from, to });
    }
  }
  return out;
}

/** WS 推送(最新) → 发单 */
export function latWsPushToOrderMs(trace) {
  const push = trace?.orderQuote?.wsPushMs ?? trace?.signalQuote?.wsPushMs;
  return anchorToOrder(trace, push);
}

/** 本机接收 → 发单 */
export function latReceiveToOrderMs(trace) {
  const recv = trace?.orderQuote?.receiveMs ?? trace?.signalQuote?.receiveMs;
  return anchorToOrder(trace, recv);
}

/** WS 传输：推送 → 本机接收 */
export function latWsTransitMs(trace) {
  const q = trace?.orderQuote ?? trace?.signalQuote;
  return q?.wsTransitMs ?? null;
}

/** @deprecated 决策收价→发单 */
export function latLocalOldToOrderMs(trace) {
  return anchorToOrder(trace, trace?.signalQuote?.receiveMs);
}

/** fresh 收价→发单 */
export function latLocalNewToOrderMs(trace) {
  return latReceiveToOrderMs(trace);
}

/** @deprecated 决策官方→发单 */
export function latOldDataFreshnessMs(trace) {
  return anchorToOrder(trace, trace?.signalQuote?.wsPushMs);
}

/** fresh 官方→发单 */
export function latNewDataFreshnessMs(trace) {
  return latWsPushToOrderMs(trace);
}

export function latPriceAgeAtOrderMs(trace) {
  return trace?.orderQuote?.priceAgeMs ?? null;
}

export function localSpanOldToNewMs(trace) {
  const oldMs = trace?.signalQuote?.receiveMs;
  const newMs = trace?.orderQuote?.receiveMs;
  if (oldMs == null || newMs == null) return null;
  return Math.max(0, newMs - oldMs);
}

export function officialSpanOldToNewMs(trace) {
  const oldMs = trace?.signalQuote?.wsPushMs;
  const newMs = trace?.orderQuote?.wsPushMs;
  if (oldMs == null || newMs == null) return null;
  return Math.max(0, newMs - oldMs);
}

export function latSignalExchangeToOrderMs(trace) {
  return latOldDataFreshnessMs(trace);
}

export function latFreshExchangeToOrderMs(trace) {
  return latNewDataFreshnessMs(trace);
}

export function exchangeSpanSignalToFreshMs(trace) {
  return officialSpanOldToNewMs(trace);
}

/** 信号触发 → 发单（各处理阶段之和的端到端） */
export function latDecisionToOrderMs(trace) {
  return markDelta(trace, 'trace_start', 'order_send_start');
}

/** 信号决策 → placeOrder 全部返回 */
export function latDecisionToSubmitDoneMs(trace) {
  return markDelta(trace, 'trace_start', 'order_send_done');
}

function anchorToSubmitDone(trace, anchorMs) {
  const doneMs = trace?.marks?.order_send_done;
  if (anchorMs == null || doneMs == null) return null;
  return Math.max(0, doneMs - anchorMs);
}

/** WS 推送 → placeOrder 全部返回 */
export function latWsPushToSubmitDoneMs(trace) {
  const push = trace?.orderQuote?.wsPushMs ?? trace?.signalQuote?.wsPushMs;
  return anchorToSubmitDone(trace, push);
}

/** 本机接收 → placeOrder 全部返回 */
export function latReceiveToSubmitDoneMs(trace) {
  const recv = trace?.orderQuote?.receiveMs ?? trace?.signalQuote?.receiveMs;
  return anchorToSubmitDone(trace, recv);
}

export function latToOrderMs(trace) {
  return latDecisionToOrderMs(trace) ?? latWsPushToOrderMs(trace);
}

function roundMs(ms) {
  return ms == null ? null : Math.round(ms);
}

export function formatLatencyLogLines(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const quote = trace?.orderQuote ?? trace?.signalQuote;
  const stages = latencyProcessStages(trace);
  if (!quote && orderMs == null && stages.length === 0) return [];

  const parts = [];

  const wsTransit = latWsTransitMs(trace);
  if (wsTransit != null) {
    parts.push(`WS传输(推送→接收) ${roundMs(wsTransit)}ms`);
  }

  const submitStage = stages.find((s) => s.from === 'order_send_start' && s.to === 'order_send_done');
  const otherStages = stages.filter((s) => s.from !== 'order_send_start' || s.to !== 'order_send_done');
  const stageText = otherStages
    .filter((s) => s.ms > 0)
    .map((s) => `${s.label} ${roundMs(s.ms)}ms`);
  if (stageText.length > 0) {
    parts.push(...stageText);
  }

  const submitMs = trace?.orderSubmitMs;
  if (submitStage?.ms > 0 || submitMs) {
    const parallel = roundMs(submitStage?.ms ?? submitMs?.parallel);
    let submitLine = `发单提交(placeOrder) 并行${parallel}ms`;
    if (submitMs?.binance != null && submitMs?.gate != null) {
      submitLine += ` [Binance ${roundMs(submitMs.binance)}ms Gate ${roundMs(submitMs.gate)}ms]`;
    }
    parts.push(submitLine);
  }

  const totalDecision = latDecisionToOrderMs(trace);
  const totalDecisionDone = latDecisionToSubmitDoneMs(trace);
  const totalPush = latWsPushToOrderMs(trace);
  const totalPushDone = latWsPushToSubmitDoneMs(trace);
  const totalRecv = latReceiveToOrderMs(trace);
  const totalRecvDone = latReceiveToSubmitDoneMs(trace);
  if (totalDecision != null) {
    parts.push(`总计(信号→发单开始) ${roundMs(totalDecision)}ms`);
  }
  if (totalDecisionDone != null) {
    parts.push(`总计(信号→提交完成) ${roundMs(totalDecisionDone)}ms`);
  }
  if (totalPush != null) {
    parts.push(`总计(推送→发单开始) ${roundMs(totalPush)}ms`);
  }
  if (totalPushDone != null && totalPushDone !== totalPush) {
    parts.push(`总计(推送→提交完成) ${roundMs(totalPushDone)}ms`);
  }
  if (totalRecv != null && totalRecv !== totalPush) {
    parts.push(`总计(接收→发单开始) ${roundMs(totalRecv)}ms`);
  }
  if (totalRecvDone != null && totalRecvDone !== totalRecv && totalRecvDone !== totalPushDone) {
    parts.push(`总计(接收→提交完成) ${roundMs(totalRecvDone)}ms`);
  }

  const priceAge = latPriceAgeAtOrderMs(trace);
  const oq = trace?.orderQuote ?? {};
  if (oq.aAgeMs != null || oq.bAgeMs != null) {
    parts.push(
      `腿龄 A=${roundMs(oq.aAgeMs) ?? '-'}ms B=${roundMs(oq.bAgeMs) ?? '-'}ms`
      + (oq.legSkewMs != null ? ` 差${roundMs(oq.legSkewMs)}ms` : '')
    );
  }
  if (priceAge != null) {
    parts.push(`发单时最旧腿 ${roundMs(priceAge)}ms`);
  }

  if (parts.length === 0) return [];
  return [`[延迟] ${parts.join(' · ')}`];
}

export function priceStagesCsvFields(trace) {
  const ps = trace?.priceStages;
  if (!ps) {
    return {
      accept_a_price: '',
      accept_b_price: '',
      send_a_price: '',
      send_b_price: ''
    };
  }
  return {
    accept_a_price: ps.signal?.aPrice ?? '',
    accept_b_price: ps.signal?.bPrice ?? '',
    send_a_price: ps.send?.aPrice ?? '',
    send_b_price: ps.send?.bPrice ?? ''
  };
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(Number(v))) return '-';
  return Number(v).toFixed(8);
}

/** 三阶段执行价：接受(决策快照) → 发单(fresh tick) → 成交 */
export function formatPriceStageLines(trace) {
  const ps = trace?.priceStages;
  if (!ps?.signal) return [];
  return [
    `[价格] 接受 A=${fmtPrice(ps.signal.aPrice)} B=${fmtPrice(ps.signal.bPrice)}`
    + ` · 发单 A=${fmtPrice(ps.send?.aPrice)} B=${fmtPrice(ps.send?.bPrice)}`
    + ` · 成交 A=${fmtPrice(ps.fill?.aPrice)} B=${fmtPrice(ps.fill?.bPrice)}`
  ];
}

export function latencyCsvFields(trace) {
  const stages = latencyProcessStages(trace);
  const byLabel = Object.fromEntries(stages.map((s) => [s.label, s.ms]));
  const quote = trace?.orderQuote ?? trace?.signalQuote ?? {};
  return {
    lat_ws_push_ms: quote.wsPushMs ?? '',
    lat_receive_ms: quote.receiveMs ?? '',
    lat_ws_transit_ms: latWsTransitMs(trace) ?? '',
    lat_decision_to_order_ms: latDecisionToOrderMs(trace) ?? '',
    lat_ws_push_to_order_ms: latWsPushToOrderMs(trace) ?? '',
    lat_receive_to_order_ms: latReceiveToOrderMs(trace) ?? '',
    lat_price_age_at_order_ms: latPriceAgeAtOrderMs(trace) ?? '',
    lat_a_age_ms: quote.aAgeMs ?? '',
    lat_b_age_ms: quote.bAgeMs ?? '',
    lat_leg_skew_ms: quote.legSkewMs ?? '',
    lat_a_ws_transit_ms: quote.aWsTransitMs ?? '',
    lat_b_ws_transit_ms: quote.bWsTransitMs ?? '',
    lat_local_old_to_order_ms: latLocalOldToOrderMs(trace) ?? '',
    lat_local_new_to_order_ms: latLocalNewToOrderMs(trace) ?? '',
    lat_old_data_freshness_ms: latOldDataFreshnessMs(trace) ?? '',
    lat_new_data_freshness_ms: latNewDataFreshnessMs(trace) ?? '',
    local_span_old_to_new_ms: localSpanOldToNewMs(trace) ?? '',
    official_span_old_to_new_ms: officialSpanOldToNewMs(trace) ?? '',
    lat_stage_calc_ms: byLabel['算量'] ?? '',
    lat_stage_account_ms: byLabel['刷账户'] ?? '',
    lat_stage_reserve_ms: byLabel['预占'] ?? '',
    lat_stage_queue_ms: byLabel['排队'] ?? '',
    lat_stage_fresh_tick_ms: byLabel['拉新价'] ?? '',
    lat_stage_precheck_ms: byLabel['预检'] ?? '',
    lat_stage_presend_ms: byLabel['待发'] ?? '',
    lat_stage_order_send_ms: byLabel['发单提交'] ?? '',
    lat_decision_to_submit_done_ms: latDecisionToSubmitDoneMs(trace) ?? '',
    ...priceStagesCsvFields(trace)
  };
}

export default {
  tickOfficialExchangeMs,
  createTradeLatencyTrace,
  setFreshTickOnLatencyTrace,
  markLatency,
  latencyProcessStages,
  latWsPushToOrderMs,
  latReceiveToOrderMs,
  latWsTransitMs,
  latLocalOldToOrderMs,
  latLocalNewToOrderMs,
  latOldDataFreshnessMs,
  latNewDataFreshnessMs,
  latPriceAgeAtOrderMs,
  localSpanOldToNewMs,
  officialSpanOldToNewMs,
  latSignalExchangeToOrderMs,
  latFreshExchangeToOrderMs,
  exchangeSpanSignalToFreshMs,
  latDecisionToOrderMs,
  latDecisionToSubmitDoneMs,
  latWsPushToSubmitDoneMs,
  latReceiveToSubmitDoneMs,
  latToOrderMs,
  formatLatencyLogLines,
  formatPriceStageLines,
  priceStagesCsvFields,
  attachFillPricesToTrace,
  latencyCsvFields
};
