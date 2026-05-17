/**
 * CEX-CEX Collector 主入口（参考 ArbiData collector 结构）
 */
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

import config from './config.js';
import { getEventBus, EVENTS } from './event-bus/index.js';
import { RedisClient } from './redis/redis-client.js';
import { PriceStreamWriter } from './redis/price-stream-writer.js';
import { BinanceAdapter, GateAdapter } from './cex/index.js';
import fs from 'node:fs/promises';

class Collector {
  constructor() {
    this.eventBus = getEventBus();
    this.redis = null;
    this.priceWriter = null;
    this.binance = null;
    this.gate = null;
    this.symbols = [];
    this.fundingTimer = null;
    this.isRunning = false;
  }

  async loadSymbols() {
    const raw = await fs.readFile(config.app.symbolConfig, 'utf-8');
    const payload = JSON.parse(raw);
    const symbols = payload.symbols || [];
    const sorted = [...symbols].sort((a, b) => Number(a.rank) - Number(b.rank));
    this.symbols = sorted.slice(0, config.app.topN).map((s) => ({
      symbol: `${String(s.symbol_id).replace('USDT', '')}-USDT`,
      binanceSymbol: s.binance_symbol,
      gateSymbol: s.gate_symbol
    }));
  }

  async initialize() {
    console.log('========================================');
    console.log('  CEX-CEX Collector (Binance + Gate)');
    console.log('========================================');

    await this.loadSymbols();
    console.log(`[Collector] Loaded symbols: ${this.symbols.length}`);

    this.redis = new RedisClient(config.redis);
    await this.redis.connect();

    this.priceWriter = new PriceStreamWriter(this.eventBus, this.redis, {
      enableWrite: true,
      enableLog: config.writer.enableLog,
      enableStatsLog: config.writer.enableStatsLog,
      statsInterval: config.writer.statsInterval,
      streamMaxLen: config.redis.streamMaxLen
    });
    this.priceWriter.start();

    this.binance = new BinanceAdapter(config.binance);
    this.gate = new GateAdapter(config.gate);

    await this.binance.connect();
    await this.gate.connect();

    this.binance.on('ticker', (ticker) => {
      this.eventBus.emit(EVENTS.PRICE_UPDATE, {
        symbol: ticker.symbol,
        side: 'cex_a',
        source: 'binance',
        priceData: ticker
      });
    });

    this.gate.on('ticker', (ticker) => {
      this.eventBus.emit(EVENTS.PRICE_UPDATE, {
        symbol: ticker.symbol,
        side: 'cex_b',
        source: 'gate',
        priceData: ticker
      });
    });
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const normalizedSymbols = this.symbols.map((s) => s.symbol);
    await this.binance.subscribe(normalizedSymbols, ['bookTicker']);
    await this.gate.subscribe(normalizedSymbols, ['book_ticker']);

    this.fundingTimer = setInterval(() => {
      this.pollFunding().catch((e) => console.error('[Collector] funding poll error:', e.message));
    }, config.app.fundingIntervalSec * 1000);
    await this.pollFunding();
    console.log('[Collector] started');
  }

  async pollFunding() {
    for (const s of this.symbols) {
      const symbol = s.symbol;
      const [fa, fb] = await Promise.all([
        this.binance.getFundingRate(symbol).catch(() => null),
        this.gate.getFundingRate(symbol).catch(() => null)
      ]);
      if (Number.isFinite(fa)) {
        this.eventBus.emit(EVENTS.FUNDING_UPDATE, {
          symbol,
          side: 'cex_a',
          source: 'binance',
          fundingRate: fa
        });
      }
      if (Number.isFinite(fb)) {
        this.eventBus.emit(EVENTS.FUNDING_UPDATE, {
          symbol,
          side: 'cex_b',
          source: 'gate',
          fundingRate: fb
        });
      }
    }
  }

  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.fundingTimer) clearInterval(this.fundingTimer);
    if (this.priceWriter) this.priceWriter.stop();
    if (this.binance) await this.binance.disconnect();
    if (this.gate) await this.gate.disconnect();
    if (this.redis) await this.redis.disconnect();
  }
}

async function main() {
  const collector = new Collector();

  const shutdown = async (sig) => {
    console.log(`[${sig}] stopping...`);
    await collector.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await collector.initialize();
    await collector.start();
  } catch (error) {
    console.error('[Collector] fatal:', error);
    process.exit(1);
  }
}

main();
