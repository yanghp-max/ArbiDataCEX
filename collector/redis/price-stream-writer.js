/**
 * CEX-CEX 价格流写入器（参考 ArbiData PriceStreamWriter）
 */
export class PriceStreamWriter {
  constructor(eventBus, redisClient, options = {}) {
    this.eventBus = eventBus;
    this.redis = redisClient;
    this.options = {
      enableWrite: true,
      enableLog: false,
      enableStatsLog: true,
      statsInterval: 60000,
      streamMaxLen: 200000,
      ...options
    };

    // symbol -> { cex_a: {...}, cex_b: {...}, funding_a, funding_b }
    this.priceCache = new Map();
    this.stats = {
      totalWrites: 0,
      successWrites: 0,
      failedWrites: 0,
      updatesReceived: 0,
      startTime: Date.now()
    };
    this.statsTimer = null;
  }

  start() {
    this.eventBus.on('priceUpdate', this.handlePriceUpdate.bind(this));
    this.eventBus.on('fundingUpdate', this.handleFundingUpdate.bind(this));
    if (this.options.enableStatsLog) {
      this.statsTimer = setInterval(() => this.logStats(), this.options.statsInterval);
    }
    console.log('[PriceStreamWriter] started');
  }

  stop() {
    this.eventBus.removeAllListeners('priceUpdate');
    this.eventBus.removeAllListeners('fundingUpdate');
    if (this.statsTimer) clearInterval(this.statsTimer);
  }

  handlePriceUpdate(event) {
    const { symbol, side, source, priceData } = event;
    this.stats.updatesReceived++;
    if (!this.priceCache.has(symbol)) {
      this.priceCache.set(symbol, { cex_a: null, cex_b: null, funding_a: null, funding_b: null });
    }
    const cache = this.priceCache.get(symbol);
    cache[side] = {
      source,
      bid: priceData.bid,
      ask: priceData.ask,
      serverTimestamp: priceData.serverTimestamp ?? null,
      localTimestamp: priceData.localTimestamp ?? Date.now(),
      latencyMs:
        priceData.serverTimestamp != null
          ? Number(priceData.localTimestamp ?? Date.now()) - Number(priceData.serverTimestamp)
          : null
    };

    if (cache.cex_a && cache.cex_b) {
      this.writeToRedisStream(symbol, cache, `${source}_quote`);
    }
  }

  handleFundingUpdate(event) {
    const { symbol, side, fundingRate } = event;
    if (!this.priceCache.has(symbol)) {
      this.priceCache.set(symbol, { cex_a: null, cex_b: null, funding_a: null, funding_b: null });
    }
    const cache = this.priceCache.get(symbol);
    if (side === 'cex_a') cache.funding_a = fundingRate;
    if (side === 'cex_b') cache.funding_b = fundingRate;
  }

  toBeijingTime(timestamp) {
    const date = new Date(timestamp + 8 * 60 * 60 * 1000);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    const hh = String(date.getUTCHours()).padStart(2, '0');
    const mi = String(date.getUTCMinutes()).padStart(2, '0');
    const ss = String(date.getUTCSeconds()).padStart(2, '0');
    const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
  }

  async writeToRedisStream(symbol, cache, trigger = 'quote_update') {
    if (!this.options.enableWrite || !this.redis.isReady()) return;

    const spreadAB = ((cache.cex_a.bid - cache.cex_b.ask) / cache.cex_b.ask) * 100;
    const spreadBA = ((cache.cex_b.bid - cache.cex_a.ask) / cache.cex_a.ask) * 100;
    const timestamp = Date.now();
    const normalizedSymbol = symbol.replace('-', '');
    const fields = {
      timestamp: String(timestamp),
      datetime: this.toBeijingTime(timestamp),
      symbol: normalizedSymbol,
      cex_a_source: cache.cex_a.source,
      cex_b_source: cache.cex_b.source,
      cex_a_bid: String(cache.cex_a.bid),
      cex_a_ask: String(cache.cex_a.ask),
      cex_b_bid: String(cache.cex_b.bid),
      cex_b_ask: String(cache.cex_b.ask),
      spread_ab: String(spreadAB),
      spread_ba: String(spreadBA),
      binance_bid: String(cache.cex_a.bid),
      binance_ask: String(cache.cex_a.ask),
      gate_bid: String(cache.cex_b.bid),
      gate_ask: String(cache.cex_b.ask),
      binance_funding_rate: cache.funding_a != null ? String(cache.funding_a) : '',
      gate_funding_rate: cache.funding_b != null ? String(cache.funding_b) : '',
      binance_server_ts:
        cache.cex_a.serverTimestamp != null ? String(cache.cex_a.serverTimestamp) : '',
      binance_local_ts:
        cache.cex_a.localTimestamp != null ? String(cache.cex_a.localTimestamp) : '',
      binance_ws_latency_ms:
        cache.cex_a.latencyMs != null ? String(cache.cex_a.latencyMs) : '',
      gate_server_ts:
        cache.cex_b.serverTimestamp != null ? String(cache.cex_b.serverTimestamp) : '',
      gate_local_ts:
        cache.cex_b.localTimestamp != null ? String(cache.cex_b.localTimestamp) : '',
      trigger
    };

    const streamKey = `price:stream:${normalizedSymbol}`;
    this.stats.totalWrites++;
    try {
      await this.redis.xadd(streamKey, fields, {
        maxLen: this.options.streamMaxLen,
        approximate: true
      });
      this.stats.successWrites++;
      if (this.options.enableLog) {
        console.log(`[PriceStreamWriter] xadd ${streamKey}`);
      }
    } catch (error) {
      this.stats.failedWrites++;
      console.error('[PriceStreamWriter] write failed:', error.message);
    }
  }

  logStats() {
    const uptime = Math.floor((Date.now() - this.stats.startTime) / 1000);
    console.log(
      `[PriceStreamWriter] uptime=${uptime}s updates=${this.stats.updatesReceived} writes=${this.stats.totalWrites} ok=${this.stats.successWrites} fail=${this.stats.failedWrites}`
    );
  }
}

export default PriceStreamWriter;
