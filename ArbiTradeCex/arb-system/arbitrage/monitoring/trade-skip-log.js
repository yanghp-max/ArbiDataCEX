/**
 * 拦单原因日志（按 symbol+阶段节流；仅控制台输出，不落盘）。
 */

const lastLogAt = new Map();
const latencyBurstAt = new Map();

function parseWsLatencyExceed(reason) {
  const text = String(reason || '');
  const m = text.match(/WS 传输延迟\s+(\d+)ms\s+>\s+上限(\d+)ms\s+\(超出(\d+)ms\)/);
  if (!m) return null;
  return {
    wsMs: Number(m[1]),
    limitMs: Number(m[2]),
    exceedMs: Number(m[3])
  };
}

export function logTradeSkip(symbol, stage, reason, options = {}) {
  if (options.enabled === false) return;
  const throttleMs = Number(options.throttleMs) || 10_000;
  const key = `${symbol}:${stage}`;
  const now = Date.now();
  if (!options.force && now - (lastLogAt.get(key) || 0) < throttleMs) return;
  lastLogAt.set(key, now);
  const mode = options.tradingEnabled ? 'live' : 'dry';
  const parsed = stage === '延迟·信号前' ? parseWsLatencyExceed(reason) : null;
  if (parsed) {
    const nowSec = Math.floor(now / 1000);
    const burst = latencyBurstAt.get(nowSec) || { count: 0, maxExceed: 0 };
    burst.count += 1;
    burst.maxExceed = Math.max(burst.maxExceed, parsed.exceedMs);
    latencyBurstAt.set(nowSec, burst);
    // 同 1 秒内大量 symbol 同时触发时，仅保留前几条细粒度日志，减少刷屏和 IO 压力。
    if (burst.count > 3 && !options.force) {
      return;
    }
  }
  const message = `[拦单·${stage}] [${mode}] ${symbol} ${reason}`;
  if (options.mirrorConsole) {
    console.warn(message);
  }

  if (parsed) {
    const nowSec = Math.floor(now / 1000);
    const burst = latencyBurstAt.get(nowSec);
    if (burst?.count === 4 && options.mirrorConsole) {
      console.warn(
        `[拦单·${stage}] [${mode}] 进入拥塞抑制：同秒多币延迟拦截（count>=4，当前最大超限${burst.maxExceed}ms）`
      );
    }
  }
}

export function resetTradeSkipLog() {
  lastLogAt.clear();
}

export default { logTradeSkip, resetTradeSkipLog };
