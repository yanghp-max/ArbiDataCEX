/**
 * 拦单原因日志（按 symbol+阶段节流；写入 strategy 文本日志 + 可选控制台）
 */
import { appendTextLog } from '../../common/monitoring/append-text-log.js';

const lastLogAt = new Map();

export function logTradeSkip(symbol, stage, reason, options = {}) {
  if (options.enabled === false) return;
  const throttleMs = Number(options.throttleMs) || 10_000;
  const key = `${symbol}:${stage}`;
  const now = Date.now();
  if (!options.force && now - (lastLogAt.get(key) || 0) < throttleMs) return;
  lastLogAt.set(key, now);
  const mode = options.tradingEnabled ? 'live' : 'dry';
  const message = `[拦单·${stage}] [${mode}] ${symbol} ${reason}`;
  appendTextLog(message, {
    level: 'warn',
    mirrorConsole: options.mirrorConsole
  });
}

export function resetTradeSkipLog() {
  lastLogAt.clear();
}

export default { logTradeSkip, resetTradeSkipLog };
