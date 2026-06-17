/**
 * 合并 A/B ticker → tick（对齐 ArbiTrade-1 priceData：各 source 缓存最后一条）
 * - aAgeMs / bAgeMs：各腿距上次本机接收的时间（now - receiveMs）
 * - priceAgeMs：max(aAgeMs, bAgeMs) — 最旧腿收包年龄（监控用，下单不据此拦截）
 * - priceReceiveMs：max(A/B receiveMs) — 最近一条腿到达时刻（对齐 ArbiTrade-1 _receiveTime 取 max）
 * - aLatencyMs / bLatencyMs：WS 入站时固定的 wsDelayMs
 * - timestamp：两腿交易所时间取 max
 */

function compactSymbol(symbol) {
  return String(symbol).replace(/[-_]/g, '').toUpperCase();
}

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
  const receiveMs = Number(leg?.receiveMs);
  if (Number.isFinite(receiveMs)) return receiveMs;
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
  return null;
}

/** 保留上游 receiveMs/localTimestamp（worker/adapter），仅缺失时用 now */
function resolveReceiveMs(ticker, now = Date.now()) {
  const receiveMs = Number(ticker?.receiveMs);
  if (Number.isFinite(receiveMs)) return receiveMs;
  const localMs = Number(ticker?.localTimestamp);
  if (Number.isFinite(localMs)) return localMs;
  return now;
}

export class QuoteAggregator {
  constructor() {
    /** symbol(compact) -> { sources: Map<provider,ticker>, funding } */
    this.latest = new Map();
  }

  #ensureRow(sym) {
    if (!this.latest.has(sym)) {
      this.latest.set(sym, { sources: new Map(), funding: {} });
    }
    return this.latest.get(sym);
  }

  onTicker(source, ticker) {
    const sym = compactSymbol(ticker.symbol);
    if (!sym) return;

    const receiveMs = resolveReceiveMs(ticker);
    const cached = {
      ...ticker,
      symbol: sym,
      receiveMs,
      localTimestamp: receiveMs
    };

    const row = this.#ensureRow(sym);
    row.sources.set(source, cached);
  }

  /** 公共 WS 重连后清掉陈旧腿，避免单腿来价时拼到断线前的旧价 */
  clearSource(source) {
    for (const row of this.latest.values()) {
      row.sources?.delete(source);
    }
  }

  setFunding(symbol, fundingA, fundingB) {
    const sym = compactSymbol(symbol);
    const row = this.#ensureRow(sym);
    row.funding = { a: fundingA, b: fundingB };
  }

  buildTick(symbol, options = {}) {
    const sym = compactSymbol(symbol);
    const row = this.latest.get(sym);
    if (!row?.sources) return null;
    const sourceA = options.sourceA || 'binance';
    const sourceB = options.sourceB || 'gate';
    const b = row.sources.get(sourceA);
    const g = row.sources.get(sourceB);
    const funding = row.funding || {};
    if (!b || !g) return null;
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
    const priceAgeMs = Math.max(aAgeMs ?? 0, bAgeMs ?? 0);
    const legSkewMs = Math.abs(aReceiveMs - bReceiveMs);
    const maxWsLatencyMs = Math.max(
      aLatencyMs ?? -1,
      bLatencyMs ?? -1
    );
    const maxWsLatency = maxWsLatencyMs >= 0 ? maxWsLatencyMs : null;

    return {
      symbol: sym,
      timestamp,
      oldestLegExchangeMs,
      localTimestamp: now,
      priceAgeMs,
      legSkewMs,
      priceReceiveMs,
      maxWsLatencyMs: maxWsLatency,
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
      aExchangeTimestampMs: aExchangeTs,
      bExchangeTimestampMs: bExchangeTs,
      aLocalTimestamp: b.receiveMs ?? b.localTimestamp ?? null,
      bLocalTimestamp: g.receiveMs ?? g.localTimestamp ?? null,
      fundingA: funding.a ?? null,
      fundingB: funding.b ?? null
    };
  }
}

export { compactSymbol };
export default QuoteAggregator;
