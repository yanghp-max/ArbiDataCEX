/**
 * 拦单原因日志（按 symbol+阶段节流，避免 52 币刷屏）
 */
const lastLogAt = new Map();

export function logTradeSkip(symbol, stage, reason, options = {}) {
  if (options.enabled === false) return;
  const throttleMs = Number(options.throttleMs) || 10_000;
  const key = `${symbol}:${stage}`;
  const now = Date.now();
  if (!options.force && now - (lastLogAt.get(key) || 0) < throttleMs) return;
  lastLogAt.set(key, now);
  const mode = options.tradingEnabled ? 'live' : 'dry';
  console.warn(`[拦单·${stage}] [${mode}] ${symbol} ${reason}`);
}

export function resetTradeSkipLog() {
  lastLogAt.clear();
}

export default { logTradeSkip, resetTradeSkipLog };
