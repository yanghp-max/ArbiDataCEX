/**
 * 合并 A/B ticker → tick
 * - priceAgeMs / legSkewMs：基于本机接收时间（localTimestamp），反映真实行情新鲜度
 * - aAgeMs / bAgeMs：各腿接收年龄（now - localTimestamp）
 * - aLatencyMs / bLatencyMs：WS 收到时的传输延迟（wsDelayMs，在 adapter 入站时固定）
 * - timestamp：两腿交易所时间取 max（adapter 已对异常 E/T 做修正）
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

function legReceiveTimestampMs(leg) {
  const localMs = Number(leg?.localTimestamp);
  return Number.isFinite(localMs) ? localMs : null;
}

function legReceiveAgeMs(leg, now) {
  const localMs = legReceiveTimestampMs(leg);
  if (localMs == null) return null;
  return Math.max(0, now - localMs);
}

function legWsDelayMs(leg) {
  if (leg?.wsDelayMs != null && Number.isFinite(Number(leg.wsDelayMs))) {
    return Math.max(0, Number(leg.wsDelayMs));
  }
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

  /** 公共 WS 重连后清掉陈旧 Binance 腿，避免 Gate 单独来价时用旧 localTimestamp 累加延迟 */
  clearSource(source) {
    for (const row of this.latest.values()) {
      if (source === 'binance') row.binance = null;
      else if (source === 'gate') row.gate = null;
    }
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

    const aReceiveMs = legReceiveTimestampMs(b);
    const bReceiveMs = legReceiveTimestampMs(g);
    if (aReceiveMs == null || bReceiveMs == null) return null;

    const timestamp = Math.max(aExchangeTs, bExchangeTs);
    const oldestLegExchangeMs = Math.min(aExchangeTs, bExchangeTs);
    const aAgeMs = legReceiveAgeMs(b, now);
    const bAgeMs = legReceiveAgeMs(g, now);
    const aLatencyMs = legWsDelayMs(b);
    const bLatencyMs = legWsDelayMs(g);
    const priceReceiveMs = Math.max(aReceiveMs, bReceiveMs);
    const priceAgeMs = Math.max(0, now - priceReceiveMs);
    const legSkewMs = Math.abs(aReceiveMs - bReceiveMs);
    const maxWsLatencyMs = Math.max(aLatencyMs ?? 0, bLatencyMs ?? 0);

    return {
      symbol: sym,
      timestamp,
      oldestLegExchangeMs,
      localTimestamp: now,
      priceAgeMs,
      legSkewMs,
      priceReceiveMs,
      maxWsLatencyMs,
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
