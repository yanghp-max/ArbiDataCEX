/**
 * 合并 A/B ticker → tick（对齐 ArbiTrade-1 / cex_cex_arbitrage_demo_logic.md）
 * - timestamp：交易所行情时间戳（毫秒），合并 tick 取 A/B 中较新的一侧
 * - priceAgeMs = now - timestamp（单一 age，用于 stale 判断）
 * - aAgeMs / bAgeMs：各腿交易所时间距 now 的年龄（仅展示/诊断）
 * - aLatencyMs / bLatencyMs = local - server（推送延迟，诊断用）
 */

function legExchangeTimestampMs(leg) {
  if (leg?.timestamp != null && Number.isFinite(Number(leg.timestamp))) {
    return Number(leg.timestamp);
  }
  if (leg?.serverTimestamp != null && Number.isFinite(Number(leg.serverTimestamp))) {
    const ts = Number(leg.serverTimestamp);
    return ts > 1e12 ? ts : ts * 1000;
  }
  return null;
}

function legExchangeAgeMs(leg, now) {
  const ts = legExchangeTimestampMs(leg);
  if (ts == null) return null;
  return Math.max(0, now - ts);
}

function legLatencyMs(leg) {
  if (leg?.serverTimestamp == null || leg?.localTimestamp == null) return null;
  const serverMs = legExchangeTimestampMs(leg);
  const localMs = Number(leg.localTimestamp);
  if (serverMs == null || !Number.isFinite(localMs)) return null;
  return Math.max(0, localMs - serverMs);
}

export class QuoteAggregator {
  constructor() {
    this.latest = new Map();
  }

  onTicker(source, ticker) {
    const sym = ticker.symbol.replace('-', '');
    if (!this.latest.has(sym)) {
      this.latest.set(sym, { binance: null, gate: null, funding: {} });
    }
    const row = this.latest.get(sym);
    if (source === 'binance') row.binance = ticker;
    else row.gate = ticker;
  }

  setFunding(symbol, fundingA, fundingB) {
    const sym = symbol.replace('-', '');
    if (!this.latest.has(sym)) this.latest.set(sym, { binance: null, gate: null, funding: {} });
    this.latest.get(sym).funding = { a: fundingA, b: fundingB };
  }

  buildTick(symbol) {
    const sym = symbol.replace('-', '');
    const row = this.latest.get(sym);
    if (!row?.binance || !row?.gate) return null;
    const { binance: b, gate: g, funding } = row;
    if (![b.bid, b.ask, g.bid, g.ask].every(Number.isFinite)) return null;

    const now = Date.now();
    const aExchangeTs = legExchangeTimestampMs(b);
    const bExchangeTs = legExchangeTimestampMs(g);
    if (aExchangeTs == null || bExchangeTs == null) return null;

    const timestamp = Math.max(aExchangeTs, bExchangeTs);
    const priceAgeMs = Math.max(0, now - timestamp);
    const aAgeMs = legExchangeAgeMs(b, now);
    const bAgeMs = legExchangeAgeMs(g, now);
    const aLatencyMs = legLatencyMs(b);
    const bLatencyMs = legLatencyMs(g);

    return {
      symbol: sym,
      timestamp,
      localTimestamp: now,
      priceAgeMs,
      aAgeMs,
      bAgeMs,
      aLatencyMs,
      bLatencyMs,
      aBid: b.bid,
      aAsk: b.ask,
      bBid: g.bid,
      bAsk: g.ask,
      aServerTimestamp: b.serverTimestamp ?? null,
      bServerTimestamp: g.serverTimestamp ?? null,
      aLocalTimestamp: b.localTimestamp ?? null,
      bLocalTimestamp: g.localTimestamp ?? null,
      fundingA: funding.a ?? null,
      fundingB: funding.b ?? null
    };
  }
}

export default QuoteAggregator;
