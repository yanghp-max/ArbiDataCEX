import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveMinHedgeQty,
  resolveHedgeQtyFromBaseQty
} from '../../common/utils/cross-exchange-order-qty.js';
import {
  DEFAULT_BINANCE_SLIPPAGE_BPS,
  DEFAULT_GATE_SLIPPAGE_BPS,
  legPricesForDirection,
  tradeLegSides
} from '../services/spread-calculator.js';

export class PrecisionChecker {
  constructor(minQtyBySymbol = {}, options = {}) {
    this.minQtyBySymbol = minQtyBySymbol;
    this.orderUsd = Number(options.orderUsd) || 0;
    this.minOrderLotQtySymbols = new Set(
      (options.minOrderLotQtySymbols || []).map((s) => String(s).toUpperCase())
    );
  }

  static async loadFromJson(jsonPath, symbols, options = {}) {
    const text = await fs.readFile(jsonPath, 'utf8');
    const json = JSON.parse(text);
    const map = {};
    for (const sym of symbols) {
      if (json.symbols?.[sym]) map[sym] = json.symbols[sym];
    }
    const checker = new PrecisionChecker(map, options);
    checker.warnIfMinNotionalMissing(symbols);
    return checker;
  }

  /** 情况 A：依赖 JSON 内 per-symbol minNotional（需先 build:symbols-min-qty） */
  warnIfMinNotionalMissing(symbols) {
    const lotSet = this.minOrderLotQtySymbols;
    const missing = [];
    for (const sym of symbols) {
      if (lotSet.has(String(sym).toUpperCase())) continue;
      const b = this.minQtyBySymbol[sym]?.binance;
      if (!b) {
        missing.push(`${sym}(no entry)`);
        continue;
      }
      const apiU = Number(b.minNotional);
      if (!Number.isFinite(apiU) || apiU <= 0) missing.push(sym);
    }
    if (missing.length > 0) {
      console.warn(
        `[PrecisionChecker] binance.minNotional missing for: ${missing.slice(0, 8).join(', ')}`
        + `${missing.length > 8 ? ` ...+${missing.length - 8}` : ''}. `
        + `Run: npm run build:symbols-min-qty — until then only orderUsd=${this.orderUsd} applies (BTC etc. may be wrong).`
      );
    }
  }

  resolvePath(configPath, rootDir) {
    if (path.isAbsolute(configPath)) return configPath;
    return path.resolve(rootDir, configPath);
  }

  buildOrder({ direction, tick, orderUsd }) {
    const cfg = this.minQtyBySymbol[tick.symbol];
    if (!cfg) return { qty: 0 };

    const { aPrice } = legPricesForDirection(direction, tick);
    const minU = Number(orderUsd ?? this.orderUsd);
    const useLotMinQty = this.minOrderLotQtySymbols.has(String(tick.symbol).toUpperCase());

    const resolved = resolveMinHedgeQty({
      orderUsd: minU,
      aPrice,
      binanceCfg: cfg.binance,
      gateCfg: cfg.gate,
      useLotMinQty
    });
    const { qty, gateSize, effectiveMinNotional, qBinance, qGate } = resolved;

    if (qty <= 0 || gateSize <= 0) return { qty: 0, gateSize: 0 };

    const gateCfg = cfg.gate;

    return {
      qty,
      gateSize,
      effectiveMinNotional,
      qBinance,
      qGate,
      gateDecimalSize: Boolean(gateCfg.enableDecimal || gateCfg.quantityUnit === 'base'),
      gateQuantityUnit: gateCfg.quantityUnit || 'contract',
      gateQuantoMultiplier: Number(gateCfg.quantoMultiplier) || 1,
      direction,
      aPrice,
      cfg
    };
  }

  alignHedgeFromBaseQty(tick, baseQty) {
    const cfg = this.minQtyBySymbol[tick.symbol];
    if (!cfg || !(baseQty > 0)) return { qty: 0, gateSize: 0 };
    return resolveHedgeQtyFromBaseQty({
      baseQty,
      binanceCfg: cfg.binance,
      gateCfg: cfg.gate
    });
  }

  /**
   * 开仓：持仓上限截取后，对齐 qty/gateSize 且必须 ≥ 两腿最小可成交量。
   * 不满足则返回 null（避免单腿或低于交易所最小量下单）。
   */
  finalizeOpenOrder({ direction, tick, clippedQty, orderUsd }) {
    const cfg = this.minQtyBySymbol[tick.symbol];
    if (!cfg) return null;

    const { aPrice } = legPricesForDirection(direction, tick);
    const useLotMinQty = this.minOrderLotQtySymbols.has(String(tick.symbol).toUpperCase());
    const minU = Number(orderUsd ?? this.orderUsd);

    const min = resolveMinHedgeQty({
      orderUsd: minU,
      aPrice,
      binanceCfg: cfg.binance,
      gateCfg: cfg.gate,
      useLotMinQty
    });
    const aligned = resolveHedgeQtyFromBaseQty({
      baseQty: clippedQty,
      binanceCfg: cfg.binance,
      gateCfg: cfg.gate,
      round: 'ceil'
    });

    if (min.qty <= 0 || min.gateSize <= 0) return null;
    if (aligned.qty <= 0 || aligned.gateSize <= 0) return null;
    if (aligned.qty + 1e-12 < min.qty || aligned.gateSize + 1e-12 < min.gateSize) {
      return null;
    }

    const gateCfg = cfg.gate;
    return {
      qty: aligned.qty,
      gateSize: aligned.gateSize,
      effectiveMinNotional: min.effectiveMinNotional,
      qBinance: min.qBinance,
      qGate: min.qGate,
      gateDecimalSize: Boolean(gateCfg.enableDecimal || gateCfg.quantityUnit === 'base'),
      gateQuantityUnit: gateCfg.quantityUnit || 'contract',
      gateQuantoMultiplier: Number(gateCfg.quantoMultiplier) || 1,
      direction,
      aPrice,
      cfg
    };
  }

  calcUsdtNeed(direction, qty, tick, rate = 0.1) {
    const { aPrice, bPrice } = legPricesForDirection(direction, tick);
    if (direction === '-a+b') {
      return {
        aNeed: qty * aPrice * rate,
        bNeed: qty * bPrice * rate
      };
    }
    return {
      aNeed: qty * aPrice * rate,
      bNeed: qty * bPrice * rate
    };
  }
}

export class RiskManager {
  constructor(config) {
    this.config = config;
  }

  wouldIncreaseAbs(posBefore, direction, qty) {
    let aAfter = posBefore.a;
    let bAfter = posBefore.b;
    if (direction === '-a+b') {
      aAfter -= qty;
      bAfter += qty;
    } else {
      aAfter += qty;
      bAfter -= qty;
    }
    return Math.abs(aAfter) > Math.abs(posBefore.a) || Math.abs(bAfter) > Math.abs(posBefore.b);
  }

  maxPositionQty(tick, direction) {
    const px = direction === '-a+b' ? tick.aBid : tick.aAsk;
    return this.config.maxPositionUsd / px;
  }

  clipQty(qty, tick, direction, accountCache) {
    const maxQ = this.maxPositionQty(tick, direction);
    const sym = tick.symbol;
    const aBefore = accountCache.getPosition('binance', sym);
    const bBefore = accountCache.getPosition('gate', sym);
    let aAfter = aBefore;
    let bAfter = bBefore;
    if (direction === '-a+b') {
      aAfter -= qty;
      bAfter += qty;
    } else {
      aAfter += qty;
      bAfter -= qty;
    }
    const maxA = Math.max(0, maxQ - Math.abs(aBefore));
    const maxB = Math.max(0, maxQ - Math.abs(bBefore));
    let q = Math.min(qty, maxA, maxB);
    if (Math.abs(aAfter) > maxQ) q = Math.min(q, maxQ - Math.abs(aBefore));
    return Math.max(0, q);
  }

  clipCloseQty(qty, tick, accountCache) {
    const sym = tick.symbol;
    const aBefore = accountCache.getPosition('binance', sym);
    const bBefore = accountCache.getPosition('gate', sym);
    const held = Math.min(Math.abs(aBefore), Math.abs(bBefore));
    return Math.max(0, Math.min(qty, held));
  }
}

/** enforceLatency=false 时上限为 Infinity，检查全部跳过 */
export function resolveLatencyLimits(strategyConfig, enforceLatency) {
  if (!enforceLatency) {
    return {
      maxPriceAgeMs: Infinity,
      maxLegSkewMs: Infinity,
      maxWsLatencyMs: Infinity,
      signalMaxAgeMs: Infinity
    };
  }
  return {
    maxPriceAgeMs: strategyConfig.maxPriceAgeMs ?? 1000,
    maxLegSkewMs: strategyConfig.maxLegSkewMs ?? 2000,
    maxWsLatencyMs: strategyConfig.maxWsLatencyMs ?? 100,
    signalMaxAgeMs: strategyConfig.signalMaxAgeMs ?? 100
  };
}

/** 是否启用延迟类检查（enforceLatency=false 或字段缺失时不检查） */
export function latencyChecksEnabled(limits) {
  return Number.isFinite(limits?.maxPriceAgeMs)
    && limits.maxPriceAgeMs !== Infinity;
}

/** 组合行情：最旧腿接收年龄 max(aAgeMs, bAgeMs) */
export function tickExchangeAgePass(tick, maxPriceAgeMs) {
  if (!Number.isFinite(maxPriceAgeMs)) return true;
  return tick.priceAgeMs <= maxPriceAgeMs;
}

/** CEX-CEX：两腿各自接收年龄均须达标（对齐 ArbiTrade-1 lastPriceUpdate 按源检查） */
export function tickEachLegAgePass(tick, maxPriceAgeMs) {
  if (!Number.isFinite(maxPriceAgeMs)) return true;
  const a = tick.aAgeMs;
  const b = tick.bAgeMs;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a <= maxPriceAgeMs && b <= maxPriceAgeMs;
}

/** 两腿本机接收时间差过大：一侧刚收到、另一侧长期无推送 */
export function tickLegSkewPass(tick, maxLegSkewMs) {
  if (!Number.isFinite(maxLegSkewMs)) return true;
  const skew = tick.legSkewMs ?? 0;
  return skew <= maxLegSkewMs;
}

/** WS 传输延迟：任一端超阈即不通过（对齐 stable _wsDelay > 100） */
export function tickWsLatencyPass(tick, maxWsLatencyMs) {
  if (!Number.isFinite(maxWsLatencyMs)) return true;
  const a = tick.aLatencyMs;
  const b = tick.bLatencyMs;
  const ws = tick.maxWsLatencyMs
    ?? (Number.isFinite(a) || Number.isFinite(b)
      ? Math.max(Number.isFinite(a) ? a : -1, Number.isFinite(b) ? b : -1)
      : null);
  if (ws == null || ws < 0) return true;
  return ws <= maxWsLatencyMs;
}

export function tickLatencyPass(tick, limits) {
  return analyzeLatencyFail(tick, limits).pass;
}

/** @returns {{ pass: boolean, code?: string, reason?: string }} */
export function analyzeLatencyFail(tick, limits) {
  if (!latencyChecksEnabled(limits)) return { pass: true };
  if (!tick) return { pass: false, code: 'no_tick', reason: '没有可用行情' };

  const { maxPriceAgeMs, maxLegSkewMs, maxWsLatencyMs } = limits;

  if (!tickExchangeAgePass(tick, maxPriceAgeMs)) {
    const exceed = tick.priceAgeMs - maxPriceAgeMs;
    return {
      pass: false,
      code: 'price_age',
      reason: `行情太旧 priceAgeMs=${tick.priceAgeMs}ms > 上限${maxPriceAgeMs}ms (超出${exceed.toFixed(0)}ms)`
    };
  }
  if (!tickEachLegAgePass(tick, maxPriceAgeMs)) {
    const aEx = Math.max(0, (tick.aAgeMs ?? 0) - maxPriceAgeMs);
    const bEx = Math.max(0, (tick.bAgeMs ?? 0) - maxPriceAgeMs);
    return {
      pass: false,
      code: 'leg_age',
      reason: `单腿行情过旧 A=${tick.aAgeMs}ms B=${tick.bAgeMs}ms > 上限${maxPriceAgeMs}ms`
        + ` (A超出${aEx.toFixed(0)}ms B超出${bEx.toFixed(0)}ms)`
    };
  }
  if (!tickLegSkewPass(tick, maxLegSkewMs)) {
    const exceed = (tick.legSkewMs ?? 0) - maxLegSkewMs;
    return {
      pass: false,
      code: 'leg_skew',
      reason: `两腿收到时间差 legSkewMs=${tick.legSkewMs}ms > 上限${maxLegSkewMs}ms (超出${exceed.toFixed(0)}ms)`
    };
  }
  const ws = tick.maxWsLatencyMs ?? Math.max(tick.aLatencyMs ?? 0, tick.bLatencyMs ?? 0);
  if (!tickWsLatencyPass(tick, maxWsLatencyMs)) {
    const exceed = ws - maxWsLatencyMs;
    return {
      pass: false,
      code: 'ws_latency',
      reason: `WS 传输延迟 ${ws}ms > 上限${maxWsLatencyMs}ms (超出${exceed.toFixed(0)}ms)`
    };
  }
  return { pass: true };
}

/** 本机收到价格后的处理延迟（对齐 stable priceReceiveTime → 执行） */
export function tickSignalAgePass(tick, signalMaxAgeMs) {
  return analyzeSignalAgeFail(tick, signalMaxAgeMs).pass;
}

/** @returns {{ pass: boolean, code?: string, reason?: string }} */
export function analyzeSignalAgeFail(tick, signalMaxAgeMs) {
  if (!Number.isFinite(signalMaxAgeMs)) return { pass: true };
  if (!tick) return { pass: false, code: 'no_tick', reason: '没有可用行情' };
  const base = tick.priceReceiveMs ?? tick.timestamp;
  const age = Date.now() - base;
  if (age <= signalMaxAgeMs) return { pass: true };
  const exceed = age - signalMaxAgeMs;
  return {
    pass: false,
    code: 'signal_age',
    reason: `收价后处理过久 signalAge=${age}ms > 上限${signalMaxAgeMs}ms (超出${exceed.toFixed(0)}ms)`
  };
}

/** 执行前：bid/ask 与决策时快照一致（对齐 stable price_stale / dedup_price_stale） */
export function tickPriceSnapshotMatch(snapshot, tick) {
  if (!snapshot || !tick) return false;
  return snapshot.aBid === tick.aBid
    && snapshot.aAsk === tick.aAsk
    && snapshot.bBid === tick.bBid
    && snapshot.bAsk === tick.bAsk;
}

function clampSlippageBps(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 单腿：决策快照 → 发单前 fresh 价，不利方向变动不得超过 slippageBps
 * sell: fresh >= snap×(1−bps/1e4)；buy: fresh <= snap×(1+bps/1e4)
 */
export function legPriceSlippageOk({ side, snapPrice, freshPrice, slippageBps, legLabel = 'leg' }) {
  const snap = Number(snapPrice);
  const fresh = Number(freshPrice);
  const bps = clampSlippageBps(slippageBps, 0);
  if (!Number.isFinite(snap) || snap <= 0 || !Number.isFinite(fresh) || fresh <= 0) {
    return { ok: false, leg: legLabel, reason: `${legLabel} 价格无效` };
  }
  const r = bps / 10000;
  const sideNorm = String(side || '').toLowerCase();
  if (sideNorm === 'sell') {
    const minOk = snap * (1 - r);
    if (fresh + 1e-15 < minOk) {
      const moveBps = ((snap - fresh) / snap) * 10000;
      return {
        ok: false,
        leg: legLabel,
        side: sideNorm,
        reason: `${legLabel} 卖价下滑 ${moveBps.toFixed(1)}bps > 允许 ${bps}bps`,
        snapPrice: snap,
        freshPrice: fresh,
        slippageBps: bps,
        moveBps
      };
    }
    return { ok: true, leg: legLabel, side: sideNorm, moveBps: Math.max(0, ((snap - fresh) / snap) * 10000) };
  }
  if (sideNorm === 'buy') {
    const maxOk = snap * (1 + r);
    if (fresh - 1e-15 > maxOk) {
      const moveBps = ((fresh - snap) / snap) * 10000;
      return {
        ok: false,
        leg: legLabel,
        side: sideNorm,
        reason: `${legLabel} 买价上涨 ${moveBps.toFixed(1)}bps > 允许 ${bps}bps`,
        snapPrice: snap,
        freshPrice: fresh,
        slippageBps: bps,
        moveBps
      };
    }
    return { ok: true, leg: legLabel, side: sideNorm, moveBps: Math.max(0, ((fresh - snap) / snap) * 10000) };
  }
  return { ok: false, leg: legLabel, reason: `${legLabel} 未知买卖方向` };
}

/**
 * 发单前：WS 最新价相对决策快照，不利变动是否在 symbol 配置的滑点内
 * @returns {{ ok: boolean, reason?: string, leg?: string, details?: object[] }}
 */
export function tickPriceSlippagePass(snapshot, tick, direction, slippage = {}) {
  if (!snapshot || !tick) {
    return { ok: false, reason: '缺少行情快照或最新 tick' };
  }
  const { aSide, bSide } = tradeLegSides(direction);
  const binanceBps = clampSlippageBps(
    slippage.binanceSlippageBps,
    DEFAULT_BINANCE_SLIPPAGE_BPS
  );
  const gateBps = clampSlippageBps(slippage.gateSlippageBps, DEFAULT_GATE_SLIPPAGE_BPS);

  const aSnap = aSide === 'sell' ? snapshot.aBid : snapshot.aAsk;
  const aFresh = aSide === 'sell' ? tick.aBid : tick.aAsk;
  const bSnap = bSide === 'sell' ? snapshot.bBid : snapshot.bAsk;
  const bFresh = bSide === 'sell' ? tick.bBid : tick.bAsk;

  const aCheck = legPriceSlippageOk({
    side: aSide,
    snapPrice: aSnap,
    freshPrice: aFresh,
    slippageBps: binanceBps,
    legLabel: 'Binance'
  });
  const bCheck = legPriceSlippageOk({
    side: bSide,
    snapPrice: bSnap,
    freshPrice: bFresh,
    slippageBps: gateBps,
    legLabel: 'Gate'
  });

  if (!aCheck.ok) {
    return { ok: false, reason: aCheck.reason, leg: aCheck.leg, details: [aCheck, bCheck] };
  }
  if (!bCheck.ok) {
    return { ok: false, reason: bCheck.reason, leg: bCheck.leg, details: [aCheck, bCheck] };
  }
  return { ok: true, details: [aCheck, bCheck] };
}

export function describePriceSlippageFail(result) {
  if (!result || result.ok) return null;
  return result.reason || 'WS 价格变动超过滑点容忍';
}

export function tickPriceSnapshot(symbol, tick) {
  return {
    symbol,
    aBid: tick.aBid,
    aAsk: tick.aAsk,
    bBid: tick.bBid,
    bAsk: tick.bAsk
  };
}

export function finalCheckPass(tick, direction, adjSpread, limits) {
  return analyzeFinalCheckFail(tick, adjSpread, limits).pass;
}

/** @returns {{ pass: boolean, code?: string, reason?: string }} */
export function analyzeFinalCheckFail(tick, adjSpread, limits) {
  const latency = analyzeLatencyFail(tick, limits);
  if (!latency.pass) return latency;
  const spread = Number(adjSpread);
  if (spread < 0) {
    return {
      pass: false,
      code: 'spread_negative',
      reason: `扣费后价差为负 ${spread.toFixed(4)}% < 0 (超出${Math.abs(spread).toFixed(4)}%)`
    };
  }
  if (spread > 10) {
    return {
      pass: false,
      code: 'spread_too_high',
      reason: `扣费后价差异常偏大 ${spread.toFixed(4)}% > 10% (超出${(spread - 10).toFixed(4)}%)`
    };
  }
  return { pass: true };
}

/** 延迟检查未通过时的通俗说明（供实盘日志） */
export function describeLatencyFail(tick, limits) {
  const r = analyzeLatencyFail(tick, limits);
  return r.pass ? null : (r.reason ?? '延迟检查未通过');
}

/** 最终校验未通过时的通俗说明 */
export function describeFinalCheckFail(tick, adjSpread, limits) {
  const r = analyzeFinalCheckFail(tick, adjSpread, limits);
  return r.pass ? null : (r.reason ?? '最终校验未通过');
}
