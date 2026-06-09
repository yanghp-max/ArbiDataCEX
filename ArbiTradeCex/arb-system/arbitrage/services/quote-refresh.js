/**
 * 发单前可选 REST 补价（strategy.restRefreshBeforeOrder=true 时启用）。
 * 默认用 QuoteAggregator 内 WS 缓存 buildTick，避免多 symbol 并发 REST 超时。
 */

import { compactSymbol } from './quote-aggregator.js';

function emitRestTicker(aggregator, source, payload) {
  if (!payload) return;
  aggregator.onTicker(source, {
    symbol: payload.symbol,
    bid: payload.bid,
    ask: payload.ask,
    timestamp: payload.timestamp ?? Date.now(),
    serverTimestamp: payload.serverTimestamp ?? null,
    localTimestamp: Date.now(),
    wsDelayMs: null,
    source,
    viaRest: true,
    restReason: payload.restReason ?? 'pre_order'
  });
}

/**
 * 并行 REST bookTicker → 写入 QuoteAggregator → buildTick
 * @returns {Promise<import('./quote-aggregator.js').QuoteAggregator['buildTick'] extends (...args: any[]) => infer R ? R : never>}
 */
export async function refreshTickFromRest(cexManager, aggregator, symbol, options = {}) {
  const sym = compactSymbol(symbol);
  const timeoutMs = Number(options.timeoutMs) || 3000;

  const [binance, gate] = await Promise.all([
    cexManager.getBookTicker('binance', sym, { timeoutMs }).catch(() => null),
    cexManager.getBookTicker('gate', sym, { timeoutMs }).catch(() => null)
  ]);

  emitRestTicker(aggregator, 'binance', binance);
  emitRestTicker(aggregator, 'gate', gate);

  return aggregator.buildTick(sym);
}

export default { refreshTickFromRest };
