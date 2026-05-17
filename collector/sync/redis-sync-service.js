/**
 * Redis 同步与裁剪服务（可单独验证）
 */
import config from '../config.js';
import { RedisClient } from '../redis/redis-client.js';
import mysqlService from './mysql-service.js';
import pLimit from 'p-limit';

class RedisSyncService {
  constructor() {
    this.redis = new RedisClient(config.redis);
    this.timer = null;
    this.running = false;
    this.syncing = false;
    this.stats = {
      totalSynced: 0,
      totalTrimmed: 0,
      lastRunAt: null,
      errors: 0
    };
  }

  async initialize() {
    await this.redis.connect();
    await mysqlService.connect();
  }

  async discoverSymbols() {
    const keys = await this.redis.client.keys('price:stream:*');
    return keys.map((k) => k.replace('price:stream:', ''));
  }

  parseMessage(msg) {
    return { id: msg.id, ...(msg.message || {}) };
  }

  async xrange(symbol, start, end, count) {
    const key = `price:stream:${symbol}`;
    const rows = await this.redis.client.xRange(key, start, end, { COUNT: count });
    return rows.map((r) => this.parseMessage(r));
  }

  async trimById(symbol, streamId) {
    if (!streamId || streamId === '-') return 0;
    const key = `price:stream:${symbol}`;
    // 兼容 redis@4.x：直接发送原生命令，避免 xTrim 参数签名差异导致报错
    const result = await this.redis.client.sendCommand([
      'XTRIM',
      key,
      'MINID',
      streamId
    ]);
    return Number(result || 0);
  }

  async runOnce(targetSymbols = null) {
    if (this.syncing) return { synced: 0, trimmed: 0 };
    this.syncing = true;
    try {
      const symbols = targetSymbols && targetSymbols.length
        ? targetSymbols
        : await this.discoverSymbols();
      console.log('[Sync] target symbols:', symbols.join(', '));
      if (!symbols.length) return { synced: 0, trimmed: 0 };
      const ensured = await mysqlService.ensureSyncStatusRows(symbols);
      if (ensured > 0) {
        console.log(`[Sync] initialized sync_status rows: +${ensured}`);
      }

      const beforeTime = Date.now() - config.sync.syncBeforeMs;
      const limit = pLimit(config.sync.concurrency);
      const results = await Promise.all(
        symbols.map((s) => limit(() => this.syncOneSymbol(s, beforeTime)))
      );
      const synced = results.reduce((acc, r) => acc + r.synced, 0);
      const trimmed = results.reduce((acc, r) => acc + r.trimmed, 0);
      this.stats.totalSynced += synced;
      this.stats.totalTrimmed += trimmed;
      this.stats.lastRunAt = Date.now();
      return { synced, trimmed };
    } catch (error) {
      this.stats.errors++;
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  async syncOneSymbol(symbol, beforeTime) {
    let synced = 0;
    let trimmed = 0;
    let currentStartId = '-';
    let lastSyncId = '-';
    const streamKey = `price:stream:${symbol}`;
    const xlen = await this.redis.client.xLen(streamKey).catch(() => 0);
    console.log(`[Sync][${symbol}] stream=${streamKey} xlen=${xlen}`);
    const status = await mysqlService.getSyncStatus(symbol);
    if (status?.last_sync_id) currentStartId = status.last_sync_id;
    const initialStartId = currentStartId;
    console.log(
      `[Sync][${symbol}] startId=${currentStartId}, beforeTime=${beforeTime}-0, batchSize=${config.sync.batchSize}`
    );

    while (true) {
      const records = await this.xrange(
        symbol,
        currentStartId,
        `${beforeTime}-0`,
        config.sync.batchSize
      );
      console.log(
        `[Sync][${symbol}] xrange start=${currentStartId} end=${beforeTime}-0 got=${records.length}`
      );
      if (!records.length && currentStartId === '-' && xlen > 0) {
        const [earliestRows, latestRows] = await Promise.all([
          this.redis.client.xRange(streamKey, '-', '+', { COUNT: 1 }).catch(() => []),
          this.redis.client.xRevRange(streamKey, '+', '-', { COUNT: 1 }).catch(() => [])
        ]);
        const earliestId = earliestRows?.[0]?.id || '-';
        const latestId = latestRows?.[0]?.id || '-';
        console.log(
          `[Sync][${symbol}] no-match-window earliestId=${earliestId} latestId=${latestId} beforeTime=${beforeTime}-0`
        );
      }
      const newRecords = records.filter((r) => r.id !== currentStartId);
      if (!newRecords.length) break;

      const inserted = await mysqlService.batchInsertPrices(newRecords);
      if (inserted <= 0) break;

      const lastRecordId = newRecords[newRecords.length - 1].id;
      await mysqlService.updateSyncStatus(symbol, lastRecordId, inserted);
      synced += inserted;
      lastSyncId = lastRecordId;
      currentStartId = lastRecordId;
      console.log(
        `[Sync][${symbol}] inserted=${inserted}, lastRecordId=${lastRecordId}, syncedTotal=${synced}`
      );
    }

    if (
      config.sync.trimById &&
      lastSyncId !== '-' &&
      lastSyncId !== initialStartId
    ) {
      trimmed = await this.trimById(symbol, lastSyncId);
      console.log(`[Sync][${symbol}] trimmed=${trimmed} byId=${lastSyncId}`);
    } else {
      console.log(
        `[Sync][${symbol}] skip trim, lastSyncId=${lastSyncId}, initialStartId=${initialStartId}`
      );
    }
    return { synced, trimmed };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(async () => {
      try {
        const result = await this.runOnce();
        console.log(`[Sync] synced=${result.synced}, trimmed=${result.trimmed}`);
      } catch (error) {
        console.error('[Sync] run failed:', error.message);
      }
    }, config.sync.intervalMs);
    console.log(`[Sync] started interval=${config.sync.intervalMs}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async shutdown() {
    this.stop();
    await mysqlService.disconnect();
    await this.redis.disconnect();
  }
}

const syncService = new RedisSyncService();
export { syncService, RedisSyncService };
export default syncService;
