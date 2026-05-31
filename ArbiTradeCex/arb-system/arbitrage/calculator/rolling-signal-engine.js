/**
 * 滚动窗口：1 秒时间桶，median/MAD z-score（对齐 backtest_cex_cex_open_only.py）
 * - median / mad 用原始 spread
 * - open_z / close_z 用扣费 spread + 分支 A/B
 */
import { percentile50, computeMad } from '../../common/utils/precision.js';
import { branchForAb, branchForBa, computeZPair } from '../services/spread-calculator.js';

export class RollingSignalEngine {
  constructor(options = {}) {
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.minDataPoints = options.minDataPoints ?? 50;
    this.buckets = new Map();
  }

  #bucketKey(ts) {
    return Math.floor(ts / 1000);
  }

  updateAndCalc({ timestamp, spreadAb, spreadBa, spreadAbAdj, spreadBaAdj }) {
    const bk = this.#bucketKey(timestamp);
    this.buckets.set(bk, { spreadAb, spreadBa, spreadAbAdj, spreadBaAdj, ts: timestamp });

    const minBk = bk - this.windowSeconds;
    for (const k of this.buckets.keys()) {
      if (k < minBk) this.buckets.delete(k);
    }

    const entries = [...this.buckets.values()].sort((a, b) => a.ts - b.ts);
    const samples = entries.length;
    const timeSpanMs = samples >= 2 ? entries[samples - 1].ts - entries[0].ts : 0;
    const windowReady = timeSpanMs >= this.windowSeconds * 1000 && samples >= this.minDataPoints;

    const baseProgress = () => {
      const timeProgressPct = Math.min(100, (timeSpanMs / (this.windowSeconds * 1000)) * 100);
      const sampleProgressPct = Math.min(100, (samples / this.minDataPoints) * 100);
      const collectProgressPct = windowReady
        ? 100
        : Math.min(timeProgressPct, sampleProgressPct);
      return {
        samples,
        timeSpanMs,
        timeProgressPct: Math.round(timeProgressPct * 10) / 10,
        sampleProgressPct: Math.round(sampleProgressPct * 10) / 10,
        collectProgressPct: Math.round(collectProgressPct * 10) / 10
      };
    };

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

    const abRaw = entries.map((e) => e.spreadAb).filter(Number.isFinite);
    const baRaw = entries.map((e) => e.spreadBa).filter(Number.isFinite);
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
