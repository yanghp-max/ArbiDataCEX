/**
 * 单笔交易延迟（基于交易所 WS 官方事件时间，非本机收包时间）
 *
 * - signalExchangeMs：决策时 tick 的官方时间 max(Binance E, Gate t)
 * - freshExchangeMs：发单前 freshTick 的官方时间
 * - order_send_start：本机发起下单时刻
 *
 * 两段延迟 + 中间推进：
 *   信号(官方)→发单、发单前(官方)→发单、官方时间推进(信号→发单前)
 */

export function tickOfficialExchangeMs(tick) {
  if (tick?.timestamp != null && Number.isFinite(Number(tick.timestamp))) {
    return Number(tick.timestamp);
  }
  return null;
}

export function createTradeLatencyTrace(tick) {
  return {
    signalExchangeMs: tickOfficialExchangeMs(tick),
    freshExchangeMs: null,
    marks: {}
  };
}

export function setFreshTickOnLatencyTrace(trace, tick) {
  if (!trace) return trace;
  trace.freshExchangeMs = tickOfficialExchangeMs(tick);
  return trace;
}

export function markLatency(trace, stage) {
  if (!trace || trace.marks[stage] != null) return trace;
  trace.marks[stage] = Date.now();
  return trace;
}

/** 决策信号 tick 官方时间 → 发单 */
export function latSignalExchangeToOrderMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const signalMs = trace?.signalExchangeMs;
  if (orderMs == null || signalMs == null) return null;
  return Math.max(0, orderMs - signalMs);
}

/** 发单前 fresh tick 官方时间 → 发单 */
export function latFreshExchangeToOrderMs(trace) {
  const orderMs = trace?.marks?.order_send_start;
  const freshMs = trace?.freshExchangeMs;
  if (orderMs == null || freshMs == null) return null;
  return Math.max(0, orderMs - freshMs);
}

/** 信号 tick → fresh tick 官方时间推进了多少（中间处理/等待） */
export function exchangeSpanSignalToFreshMs(trace) {
  const signalMs = trace?.signalExchangeMs;
  const freshMs = trace?.freshExchangeMs;
  if (signalMs == null || freshMs == null) return null;
  return Math.max(0, freshMs - signalMs);
}

/** @deprecated 兼容旧名：等同 latSignalExchangeToOrderMs */
export function latToOrderMs(trace) {
  return latSignalExchangeToOrderMs(trace);
}

export function formatLatencyLogLines(trace) {
  const signalToOrder = latSignalExchangeToOrderMs(trace);
  const freshToOrder = latFreshExchangeToOrderMs(trace);
  const exchangeSpan = exchangeSpanSignalToFreshMs(trace);
  if (signalToOrder == null && freshToOrder == null) return [];

  const parts = [];
  if (signalToOrder != null) {
    parts.push(`信号(官方)→发单: ${Math.round(signalToOrder)}ms`);
  }
  if (freshToOrder != null) {
    parts.push(`发单前(官方)→发单: ${Math.round(freshToOrder)}ms`);
  }
  if (exchangeSpan != null) {
    parts.push(`官方时间推进: ${Math.round(exchangeSpan)}ms`);
  }
  return [`[延迟] ${parts.join(' · ')}`];
}

export function latencyCsvFields(trace) {
  return {
    lat_signal_exchange_to_order_ms: latSignalExchangeToOrderMs(trace) ?? '',
    lat_fresh_exchange_to_order_ms: latFreshExchangeToOrderMs(trace) ?? '',
    exchange_span_signal_to_fresh_ms: exchangeSpanSignalToFreshMs(trace) ?? ''
  };
}

export default {
  tickOfficialExchangeMs,
  createTradeLatencyTrace,
  setFreshTickOnLatencyTrace,
  markLatency,
  latSignalExchangeToOrderMs,
  latFreshExchangeToOrderMs,
  exchangeSpanSignalToFreshMs,
  latToOrderMs,
  formatLatencyLogLines,
  latencyCsvFields
};
