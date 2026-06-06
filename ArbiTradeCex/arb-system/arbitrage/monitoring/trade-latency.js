/**
 * 延迟 / 新鲜度（两套口径，与 ArbiTrade-1 对齐）
 *
 * 1) 本机收价→发单（ArbiTrade-1「总延迟(价格→下单)」）
 *    - oldPriceReceiveMs：决策 tick 本机收价时间（两腿 localTimestamp 取 max）
 *    - newPriceReceiveMs：发单前 fresh tick 本机收价时间
 *
 * 2) 官方 WS 事件时间→发单（交易所 E/t，通常比本机口径大 ~WS 传输延迟）
 *    - oldDataOfficialMs / newDataOfficialMs：两腿官方时间取 min（慢腿约束）
 */

function tickPriceReceiveMs(tick) {
  if (tick?.priceReceiveMs != null && Number.isFinite(Number(tick.priceReceiveMs))) {
    return Number(tick.priceReceiveMs);
  }
  if (tick?.localTimestamp != null && Number.isFinite(Number(tick.localTimestamp))) {
    return Number(tick.localTimestamp);
  }
  return null;
}

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
    oldPriceReceiveMs: tickPriceReceiveMs(tick),
    newPriceReceiveMs: null,
    oldDataOfficialMs: tickOfficialExchangeMs(tick),
    newDataOfficialMs: null,
    marks: {}
  };
}

export function setFreshTickOnLatencyTrace(trace, tick) {
  if (!trace) return trace;
  trace.newPriceReceiveMs = tickPriceReceiveMs(tick);
  trace.newDataOfficialMs = tickOfficialExchangeMs(tick);
  return trace;
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

/** 本机：决策收价 → 发单（≈ ArbiTrade-1 总延迟） */
export function latLocalOldToOrderMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const recvMs = trace?.oldPriceReceiveMs;
  if (orderMs == null || recvMs == null) return null;
  return Math.max(0, orderMs - recvMs);
}

/** 本机：发单前 fresh 收价 → 发单 */
export function latLocalNewToOrderMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const recvMs = trace?.newPriceReceiveMs;
  if (orderMs == null || recvMs == null) return null;
  return Math.max(0, orderMs - recvMs);
}

/** 官方：决策 tick 慢腿发送 → 发单 */
export function latOldDataFreshnessMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const oldMs = trace?.oldDataOfficialMs;
  if (orderMs == null || oldMs == null) return null;
  return Math.max(0, orderMs - oldMs);
}

/** 官方：fresh tick 慢腿发送 → 发单 */
export function latNewDataFreshnessMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const newMs = trace?.newDataOfficialMs;
  if (orderMs == null || newMs == null) return null;
  return Math.max(0, orderMs - newMs);
}

/** 本机收价：旧 → 新 推进了多少 */
export function localSpanOldToNewMs(trace) {
  const oldMs = trace?.oldPriceReceiveMs;
  const newMs = trace?.newPriceReceiveMs;
  if (oldMs == null || newMs == null) return null;
  return Math.max(0, newMs - oldMs);
}

/** 官方时间：旧 → 新 推进了多少 */
export function officialSpanOldToNewMs(trace) {
  const oldMs = trace?.oldDataOfficialMs;
  const newMs = trace?.newDataOfficialMs;
  if (oldMs == null || newMs == null) return null;
  return Math.max(0, newMs - oldMs);
}

/** @deprecated 等同 latOldDataFreshnessMs */
export function latSignalExchangeToOrderMs(trace) {
  return latOldDataFreshnessMs(trace);
}

/** @deprecated 等同 latNewDataFreshnessMs */
export function latFreshExchangeToOrderMs(trace) {
  return latNewDataFreshnessMs(trace);
}

/** @deprecated 等同 officialSpanOldToNewMs */
export function exchangeSpanSignalToFreshMs(trace) {
  return officialSpanOldToNewMs(trace);
}

/** 主延迟口径：本机收价→发单（与 ArbiTrade-1 一致） */
export function latToOrderMs(trace) {
  return latLocalOldToOrderMs(trace);
}

export function formatLatencyLogLines(trace) {
  const localOld = latLocalOldToOrderMs(trace);
  const localNew = latLocalNewToOrderMs(trace);
  const officialOld = latOldDataFreshnessMs(trace);
  const officialNew = latNewDataFreshnessMs(trace);
  if (localOld == null && localNew == null && officialOld == null) return [];

  const parts = [];
  if (localOld != null) {
    parts.push(`总延迟(收价→发单): ${Math.round(localOld)}ms`);
  }
  if (localNew != null && localNew !== localOld) {
    parts.push(`新收价→发单: ${Math.round(localNew)}ms`);
  }
  const localSpan = localSpanOldToNewMs(trace);
  if (localSpan != null && localSpan > 0) {
    parts.push(`收价推进(旧→新): ${Math.round(localSpan)}ms`);
  }
  if (officialOld != null) {
    parts.push(`官方旧→发单: ${Math.round(officialOld)}ms`);
  }
  if (officialNew != null && officialNew !== officialOld) {
    parts.push(`官方新→发单: ${Math.round(officialNew)}ms`);
  }
  return [`[延迟] ${parts.join(' · ')}`];
}

export function latencyCsvFields(trace) {
  return {
    lat_local_old_to_order_ms: latLocalOldToOrderMs(trace) ?? '',
    lat_local_new_to_order_ms: latLocalNewToOrderMs(trace) ?? '',
    lat_old_data_freshness_ms: latOldDataFreshnessMs(trace) ?? '',
    lat_new_data_freshness_ms: latNewDataFreshnessMs(trace) ?? '',
    local_span_old_to_new_ms: localSpanOldToNewMs(trace) ?? '',
    official_span_old_to_new_ms: officialSpanOldToNewMs(trace) ?? ''
  };
}

export default {
  tickOfficialExchangeMs,
  createTradeLatencyTrace,
  setFreshTickOnLatencyTrace,
  markLatency,
  latLocalOldToOrderMs,
  latLocalNewToOrderMs,
  latOldDataFreshnessMs,
  latNewDataFreshnessMs,
  localSpanOldToNewMs,
  officialSpanOldToNewMs,
  latSignalExchangeToOrderMs,
  latFreshExchangeToOrderMs,
  exchangeSpanSignalToFreshMs,
  latToOrderMs,
  formatLatencyLogLines,
  latencyCsvFields
};
