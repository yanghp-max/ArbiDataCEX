/**
 * 合并 A/B ticker → tick
 */
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
    const ts = Math.max(b.timestamp || 0, g.timestamp || 0, b.localTimestamp, g.localTimestamp);
    return {
      symbol: sym,
      timestamp: ts,
      localTimestamp: Date.now(),
      priceAgeMs: Date.now() - ts,
      aBid: b.bid,
      aAsk: b.ask,
      bBid: g.bid,
      bAsk: g.ask,
      fundingA: funding.a ?? null,
      fundingB: funding.b ?? null
    };
  }
}

export default QuoteAggregator;
