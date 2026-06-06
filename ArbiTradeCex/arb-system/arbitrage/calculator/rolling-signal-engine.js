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
  }

  #bucketKey(ts) {
    return Math.floor(ts / 1000);
  }

  #computeWindowMetrics() {
    const bucketKeys = [...this.buckets.keys()];
    const samples = bucketKeys.length;
    if (samples === 0) {
      return { samples: 0, timeSpanSeconds: 0, timeSpanMs: 0 };
    }
    const minBk = Math.min(...bucketKeys);
    const maxBk = Math.max(...bucketKeys);
    const timeSpanSeconds = maxBk - minBk + 1;
    return { samples, timeSpanSeconds, timeSpanMs: timeSpanSeconds * 1000 };
  }

  #checkWindowReady(metrics) {
    if (this.windowReady) return;
    const { timeSpanSeconds, samples } = metrics;
    if (timeSpanSeconds >= this.windowSeconds && samples >= this.minDataPoints) {
      this.windowReady = true;
    }
  }

  updateAndCalc({ timestamp, spreadAb, spreadBa, spreadAbAdj, spreadBaAdj }) {
    const currentSecond = this.#bucketKey(timestamp);
    this.buckets.set(currentSecond, {
      spreadAb,
      spreadBa,
      spreadAbAdj,
      spreadBaAdj,
      ts: timestamp
    });

    const cutoffTime = currentSecond - this.windowSeconds;
    for (const k of this.buckets.keys()) {
      if (k < cutoffTime) this.buckets.delete(k);
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

    const entries = [...this.buckets.values()].sort((a, b) => a.ts - b.ts);

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

    const abRaw = entries.map((e) => e.spreadAbAdj).filter(Number.isFinite);
    const baRaw = entries.map((e) => e.spreadBaAdj).filter(Number.isFinite);
    const medianAb = percentile50(abRaw);
    const medianBa = percentile50(baRaw);
    const madAb = computeMad(abRaw, medianAb);
    const madBa = computeMad(baRaw, medianBa);

    const last = entries[entries.length - 1];
    const branchAb = branchForAb(medianAb, medianBa);
    const branchBa = branchForBa(medianAb, medianBa);

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
