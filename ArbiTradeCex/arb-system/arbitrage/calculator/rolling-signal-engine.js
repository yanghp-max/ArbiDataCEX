/**
 * 滚动窗口：1 秒时间桶，median/MAD z-score
 * - median / mad / z 均用扣费后 spread（ArbiTrade-1 data-manager 同思路）
 * - spreadAb/Ba 保留 WS raw 供展示
 */
import { percentile50, computeMad } from '../../common/utils/precision.js';
import { branchForAb, branchForBa, computeZPair } from '../services/spread-calculator.js';

export class RollingSignalEngine {
  constructor(options = {}) {
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.minDataPoints = options.minDataPoints ?? 50;
    this.buckets = new Map();
    /** 就绪后锁存，与 ArbiTrade-1 DataManager / demo 文档一致 */
    this.windowReady = false;
    /** 避免同一秒内多次 full sort（stable 侧 worker 合并后 tick 频率更低） */
    this._entries = null;
    this._statsCache = null;
    /** 窗口边界：prune 只从 minKey 递增删，避免每次扫全表 O(windowSeconds) */
    this._minBucketKey = null;
    this._maxBucketKey = null;
  }

  #bucketKey(ts) {
    return Math.floor(ts / 1000);
  }

  #syncMinMaxOnInsert(key) {
    if (this._minBucketKey == null || key < this._minBucketKey) {
      this._minBucketKey = key;
    }
    if (this._maxBucketKey == null || key > this._maxBucketKey) {
      this._maxBucketKey = key;
    }
  }

  /** 从 minKey 向前删过期桶；空档秒直接跳过 */
  #pruneOldBuckets(cutoffTime) {
    if (this._minBucketKey == null) return false;
    let pruned = false;
    while (this._minBucketKey != null && this._minBucketKey < cutoffTime) {
      if (this.buckets.has(this._minBucketKey)) {
        this.buckets.delete(this._minBucketKey);
        pruned = true;
      }
      this._minBucketKey += 1;
    }
    if (this.buckets.size === 0) {
      this._minBucketKey = null;
      this._maxBucketKey = null;
      return pruned;
    }
    while (this._minBucketKey != null && !this.buckets.has(this._minBucketKey)) {
      this._minBucketKey += 1;
    }
    if (this._minBucketKey != null && this._maxBucketKey != null && this._minBucketKey > this._maxBucketKey) {
      this._minBucketKey = null;
      this._maxBucketKey = null;
    }
    return pruned;
  }

  #computeWindowMetrics() {
    const samples = this.buckets.size;
    if (samples === 0 || this._minBucketKey == null || this._maxBucketKey == null) {
      return { samples: 0, timeSpanSeconds: 0, timeSpanMs: 0 };
    }
    const timeSpanSeconds = this._maxBucketKey - this._minBucketKey + 1;
    return { samples, timeSpanSeconds, timeSpanMs: timeSpanSeconds * 1000 };
  }

  #checkWindowReady(metrics) {
    if (this.windowReady) return;
    const { timeSpanSeconds, samples } = metrics;
    if (timeSpanSeconds >= this.windowSeconds && samples >= this.minDataPoints) {
      this.windowReady = true;
    }
  }

  #rebuildStats(entries) {
    const abRaw = entries.map((e) => e.spreadAbAdj).filter(Number.isFinite);
    const baRaw = entries.map((e) => e.spreadBaAdj).filter(Number.isFinite);
    const medianAb = percentile50(abRaw);
    const medianBa = percentile50(baRaw);
    const madAb = computeMad(abRaw, medianAb);
    const madBa = computeMad(baRaw, medianBa);
    const branchAb = branchForAb(medianAb, medianBa);
    const branchBa = branchForBa(medianAb, medianBa);
    this._statsCache = {
      medianAb,
      medianBa,
      madAb,
      madBa,
      branchAb,
      branchBa
    };
    return this._statsCache;
  }

  updateAndCalc({ timestamp, spreadAb, spreadBa, spreadAbAdj, spreadBaAdj }) {
    const currentSecond = this.#bucketKey(timestamp);
    const row = {
      spreadAb,
      spreadBa,
      spreadAbAdj,
      spreadBaAdj,
      ts: timestamp
    };
    const hadBucket = this.buckets.has(currentSecond);
    this.buckets.set(currentSecond, row);
    this.#syncMinMaxOnInsert(currentSecond);

    const cutoffTime = currentSecond - this.windowSeconds;
    const pruned = this.#pruneOldBuckets(cutoffTime);

    const structureChanged = pruned || !hadBucket || !this._entries?.length;
    if (pruned || !this._entries?.length) {
      this._entries = [...this.buckets.values()].sort((a, b) => a.ts - b.ts);
    } else if (!hadBucket) {
      this._entries.push(row);
    } else {
      this._entries[this._entries.length - 1] = row;
    }

    const metrics = this.#computeWindowMetrics();
    if (!this.windowReady) {
      this.#checkWindowReady(metrics);
    }

    const { samples, timeSpanMs, timeSpanSeconds } = metrics;
    const windowReady = this.windowReady;

    const baseProgress = () => {
      const timeProgressPct = Math.min(100, (timeSpanSeconds / this.windowSeconds) * 100);
      const sampleProgressPct = Math.min(100, (samples / this.minDataPoints) * 100);
      const collectProgressPct = windowReady
        ? 100
        : Math.min(timeProgressPct, sampleProgressPct);
      return {
        samples,
        timeSpanMs,
        timeSpanSeconds,
        timeProgressPct: Math.round(timeProgressPct * 10) / 10,
        sampleProgressPct: Math.round(sampleProgressPct * 10) / 10,
        collectProgressPct: Math.round(collectProgressPct * 10) / 10
      };
    };

    const entries = this._entries ?? [];

    if (!windowReady || samples < 2) {
      const progress = baseProgress();
      return {
        windowReady: false,
        openZAb: null,
        openZBa: null,
        closeZAb: null,
        closeZBa: null,
        ...progress
      };
    }

    const stats = (structureChanged || !this._statsCache)
      ? this.#rebuildStats(entries)
      : this._statsCache;
    const {
      medianAb,
      medianBa,
      madAb,
      madBa,
      branchAb,
      branchBa
    } = stats;

    const last = entries[entries.length - 1];

    let openZAb = null;
    let closeZAb = null;
    let openZBa = null;
    let closeZBa = null;

    if (madBa > 0) {
      const pairAb = computeZPair(
        last.spreadAbAdj,
        last.spreadBaAdj,
        medianAb,
        medianBa,
        madAb,
        madBa,
        '-a+b',
        branchAb
      );
      openZAb = pairAb.openZ;
      closeZAb = pairAb.closeZ;
    }
    if (madAb > 0) {
      const pairBa = computeZPair(
        last.spreadAbAdj,
        last.spreadBaAdj,
        medianAb,
        medianBa,
        madAb,
        madBa,
        '+a-b',
        branchBa
      );
      openZBa = pairBa.openZ;
      closeZBa = pairBa.closeZ;
    }

    return {
      windowReady: true,
      openZAb,
      openZBa,
      closeZAb,
      closeZBa,
      branchAb,
      branchBa,
      medianAb,
      medianBa,
      madAb,
      madBa,
      spreadAb: last.spreadAb,
      spreadBa: last.spreadBa,
      spreadAbAdj: last.spreadAbAdj,
      spreadBaAdj: last.spreadBaAdj,
      ...baseProgress()
    };
  }
}

export default RollingSignalEngine;
