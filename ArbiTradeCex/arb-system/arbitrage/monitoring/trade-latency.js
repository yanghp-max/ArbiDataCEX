/**
 * 单笔交易延迟：WS 收价 (priceReceiveMs) → 发单开始 (order_send_start)
 */

export function createTradeLatencyTrace(tick) {
  return {
    originMs: Number(tick?.priceReceiveMs ?? tick?.localTimestamp ?? Date.now()),
    marks: {}
  };
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

/** 收价 → 发起交易（发单前一刻） */
export function latToOrderMs(trace) {
  const t = trace?.marks?.order_send_start;
  if (t == null || trace?.originMs == null) return null;
  return Math.max(0, t - trace.originMs);
}

export function formatLatencyLogLines(trace) {
  const ms = latToOrderMs(trace);
  if (ms == null) return [];
  return [`[延迟] 收价→发单: ${Math.round(ms)}ms`];
}

export function latencyCsvFields(trace) {
  const ms = latToOrderMs(trace);
  return { lat_to_order_ms: ms ?? '' };
}

export default {
  createTradeLatencyTrace,
  markLatency,
  latToOrderMs,
  formatLatencyLogLines,
  latencyCsvFields
};
