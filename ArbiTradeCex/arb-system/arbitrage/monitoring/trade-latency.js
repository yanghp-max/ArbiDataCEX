/**
 * 数据新鲜度：交易所 WS 官方事件时间(E/t) → 本机发单
 *
 * - oldDataOfficialMs：决策时 tick 最旧腿官方发送时间（套利受慢腿约束）
 * - newDataOfficialMs：发单前 freshTick 最旧腿官方发送时间
 * - order_send_start：发单时刻
 *
 * 两个新鲜度 = 发单时刻 − 对应官方时间（越大越「旧」）
 */

/** 套利 tick 新鲜度基准：两腿官方时间中较旧者 */
export function tickOfficialExchangeMs(tick) {
  if (tick?.oldestLegExchangeMs != null && Number.isFinite(Number(tick.oldestLegExchangeMs))) {
    return Number(tick.oldestLegExchangeMs);
  }
  if (tick?.timestamp != null && Number.isFinite(Number(tick.timestamp))) {
    return Number(tick.timestamp);
  }
  return null;
}

export function createTradeLatencyTrace(tick) {
  return {
    oldDataOfficialMs: tickOfficialExchangeMs(tick),
    newDataOfficialMs: null,
    marks: {}
  };
}

export function setFreshTickOnLatencyTrace(trace, tick) {
  if (!trace) return trace;
  trace.newDataOfficialMs = tickOfficialExchangeMs(tick);
  return trace;
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

/** 旧数据新鲜度：决策 tick 官方发送 → 发单 */
export function latOldDataFreshnessMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const oldMs = trace?.oldDataOfficialMs;
  if (orderMs == null || oldMs == null) return null;
  return Math.max(0, orderMs - oldMs);
}

/** 新数据新鲜度：发单前 fresh tick 官方发送 → 发单 */
export function latNewDataFreshnessMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const newMs = trace?.newDataOfficialMs;
  if (orderMs == null || newMs == null) return null;
  return Math.max(0, orderMs - newMs);
}

/** 官方时间：旧 → 新 推进了多少 */
export function officialSpanOldToNewMs(trace) {
  const oldMs = trace?.oldDataOfficialMs;
  const newMs = trace?.newDataOfficialMs;
  if (oldMs == null || newMs == null) return null;
  return Math.max(0, newMs - oldMs);
}

/** @deprecated */
export function latSignalExchangeToOrderMs(trace) {
  return latOldDataFreshnessMs(trace);
}

/** @deprecated */
export function latFreshExchangeToOrderMs(trace) {
  return latNewDataFreshnessMs(trace);
}

/** @deprecated */
export function exchangeSpanSignalToFreshMs(trace) {
  return officialSpanOldToNewMs(trace);
}

export function latToOrderMs(trace) {
  return latOldDataFreshnessMs(trace);
}

export function formatLatencyLogLines(trace) {
  const oldFresh = latOldDataFreshnessMs(trace);
  const newFresh = latNewDataFreshnessMs(trace);
  const officialSpan = officialSpanOldToNewMs(trace);
  if (oldFresh == null && newFresh == null) return [];

  const parts = [];
  if (oldFresh != null) {
    parts.push(`旧数据新鲜度: ${Math.round(oldFresh)}ms`);
  }
  if (newFresh != null) {
    parts.push(`新数据新鲜度: ${Math.round(newFresh)}ms`);
  }
  if (officialSpan != null && officialSpan > 0) {
    parts.push(`官方推进(旧→新): ${Math.round(officialSpan)}ms`);
  }
  return [`[新鲜度] ${parts.join(' · ')}`];
}

export function latencyCsvFields(trace) {
  return {
    lat_old_data_freshness_ms: latOldDataFreshnessMs(trace) ?? '',
    lat_new_data_freshness_ms: latNewDataFreshnessMs(trace) ?? '',
    official_span_old_to_new_ms: officialSpanOldToNewMs(trace) ?? ''
  };
}

export default {
  tickOfficialExchangeMs,
  createTradeLatencyTrace,
  setFreshTickOnLatencyTrace,
  markLatency,
  latOldDataFreshnessMs,
  latNewDataFreshnessMs,
  officialSpanOldToNewMs,
  latSignalExchangeToOrderMs,
  latFreshExchangeToOrderMs,
  exchangeSpanSignalToFreshMs,
  latToOrderMs,
  formatLatencyLogLines,
  latencyCsvFields
};
