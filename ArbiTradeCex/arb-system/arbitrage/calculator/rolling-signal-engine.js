/**
 * 滚动窗口：1 秒时间桶，median/MAD z-score
 */
import { percentile50, computeMad } from '../../common/utils/precision.js';

export class RollingSignalEngine {
  constructor(options = {}) {
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.minDataPoints = options.minDataPoints ?? 50;
    this.buckets = new Map();
  }

  #bucketKey(ts) {
    return Math.floor(ts / 1000);
  }

  updateAndCalc({ timestamp, spreadAbAdj, spreadBaAdj }) {
    const bk = this.#bucketKey(timestamp);
    this.buckets.set(bk, { spreadAbAdj, spreadBaAdj, ts: timestamp });

    const minBk = bk - this.windowSeconds;
    for (const k of this.buckets.keys()) {
      if (k < minBk) this.buckets.delete(k);
    }

    const entries = [...this.buckets.values()].sort((a, b) => a.ts - b.ts);
    const samples = entries.length;
    const timeSpanMs = samples >= 2 ? entries[samples - 1].ts - entries[0].ts : 0;
    const windowReady = timeSpanMs >= this.windowSeconds * 1000 && samples >= this.minDataPoints;

    if (!windowReady || samples < 2) {
      const timeProgressPct = Math.min(100, (timeSpanMs / (this.windowSeconds * 1000)) * 100);
      const sampleProgressPct = Math.min(100, (samples / this.minDataPoints) * 100);
      const collectProgressPct = Math.min(timeProgressPct, sampleProgressPct);
      return {
        windowReady: false,
        zAb: null,
        zBa: null,
        samples,
        timeSpanMs,
        timeProgressPct: Math.round(timeProgressPct * 10) / 10,
        sampleProgressPct: Math.round(sampleProgressPct * 10) / 10,
        collectProgressPct: Math.round(collectProgressPct * 10) / 10
      };
    }

    const ab = entries.map((e) => e.spreadAbAdj).filter(Number.isFinite);
    const ba = entries.map((e) => e.spreadBaAdj).filter(Number.isFinite);
    const medAb = percentile50(ab);
    const medBa = percentile50(ba);
    const madAb = computeMad(ab, medAb);
    const madBa = computeMad(ba, medBa);

    const last = entries[entries.length - 1];
    let zAb = null;
    let zBa = null;
    if (madAb > 0) zAb = (last.spreadAbAdj - medAb) / madAb;
    if (madBa > 0) zBa = (last.spreadBaAdj - medBa) / madBa;

    const timeProgressPct = Math.min(100, (timeSpanMs / (this.windowSeconds * 1000)) * 100);
    const sampleProgressPct = Math.min(100, (samples / this.minDataPoints) * 100);
    const collectProgressPct = windowReady
      ? 100
      : Math.min(timeProgressPct, sampleProgressPct);

    return {
      windowReady: true,
      zAb,
      zBa,
      samples,
      timeSpanMs,
      timeProgressPct: Math.round(timeProgressPct * 10) / 10,
      sampleProgressPct: Math.round(sampleProgressPct * 10) / 10,
      collectProgressPct: Math.round(collectProgressPct * 10) / 10,
      spreadAbAdj: last.spreadAbAdj,
      spreadBaAdj: last.spreadBaAdj
    };
  }
}

export default RollingSignalEngine;
