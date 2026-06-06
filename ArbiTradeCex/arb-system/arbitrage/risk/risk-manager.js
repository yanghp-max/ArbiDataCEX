import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveMinHedgeQty,
  resolveHedgeQtyFromBaseQty
} from '../../common/utils/cross-exchange-order-qty.js';
import { legPricesForDirection } from '../services/spread-calculator.js';

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
    signalMaxAgeMs: strategyConfig.signalMaxAgeMs ?? 50
  };
}

/** 是否启用延迟类检查（enforceLatency=false 或字段缺失时不检查） */
export function latencyChecksEnabled(limits) {
  return Number.isFinite(limits?.maxPriceAgeMs)
    && limits.maxPriceAgeMs !== Infinity;
}

/** 组合行情：距最近一次任一侧交易所活动时间（now - max(A_ts,B_ts)） */
export function tickExchangeAgePass(tick, maxPriceAgeMs) {
  if (!Number.isFinite(maxPriceAgeMs)) return true;
  return tick.priceAgeMs <= maxPriceAgeMs;
}

/** 两腿交易所时间差过大：一侧刚动、另一侧长期未推送（价可能仍显示在屏幕上） */
export function tickLegSkewPass(tick, maxLegSkewMs) {
  if (!Number.isFinite(maxLegSkewMs)) return true;
  const skew = tick.legSkewMs ?? 0;
  return skew <= maxLegSkewMs;
}

/** WS 传输延迟：任一端超阈即不通过（对齐 stable _wsDelay > 100） */
export function tickWsLatencyPass(tick, maxWsLatencyMs) {
  if (!Number.isFinite(maxWsLatencyMs)) return true;
  const ws = tick.maxWsLatencyMs ?? Math.max(tick.aLatencyMs ?? 0, tick.bLatencyMs ?? 0);
  return ws <= maxWsLatencyMs;
}

export function tickLatencyPass(tick, limits) {
  if (!latencyChecksEnabled(limits)) return true;
  return tickExchangeAgePass(tick, limits.maxPriceAgeMs)
    && tickLegSkewPass(tick, limits.maxLegSkewMs)
    && tickWsLatencyPass(tick, limits.maxWsLatencyMs);
}

/** 本机收到价格后的处理延迟（对齐 stable priceReceiveTime → 执行） */
export function tickSignalAgePass(tick, signalMaxAgeMs) {
  if (!Number.isFinite(signalMaxAgeMs)) return true;
  const base = tick.priceReceiveMs ?? tick.timestamp;
  return Date.now() - base <= signalMaxAgeMs;
}

/** 执行前：bid/ask 与决策时快照一致（对齐 stable price_stale / dedup_price_stale） */
export function tickPriceSnapshotMatch(snapshot, tick) {
  if (!snapshot || !tick) return false;
  return snapshot.aBid === tick.aBid
    && snapshot.aAsk === tick.aAsk
    && snapshot.bBid === tick.bBid
    && snapshot.bAsk === tick.bAsk;
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
  if (latencyChecksEnabled(limits) && !tickLatencyPass(tick, limits)) return false;
  if (adjSpread < 0 || adjSpread > 10) return false;
  return true;
}

/** 延迟检查未通过时的通俗说明（供实盘日志） */
export function describeLatencyFail(tick, limits) {
  if (!tick) return '没有可用行情';
  if (!latencyChecksEnabled(limits)) return null;
  if (!tickExchangeAgePass(tick, limits.maxPriceAgeMs)) {
    return `行情太旧（${tick.priceAgeMs}ms，上限${limits.maxPriceAgeMs}ms）`;
  }
  if (!tickLegSkewPass(tick, limits.maxLegSkewMs)) {
    return `两腿不同步（时间差${tick.legSkewMs}ms，上限${limits.maxLegSkewMs}ms）`;
  }
  const ws = tick.maxWsLatencyMs ?? Math.max(tick.aLatencyMs ?? 0, tick.bLatencyMs ?? 0);
  if (!tickWsLatencyPass(tick, limits.maxWsLatencyMs)) {
    return `网络延迟过高（${ws}ms，上限${limits.maxWsLatencyMs}ms）`;
  }
  return '延迟检查未通过';
}

/** 最终校验未通过时的通俗说明 */
export function describeFinalCheckFail(tick, adjSpread, limits) {
  const latency = describeLatencyFail(tick, limits);
  if (latency && latencyChecksEnabled(limits) && !tickLatencyPass(tick, limits)) {
    return latency;
  }
  if (adjSpread < 0) {
    return `扣费后价差为负（${adjSpread.toFixed(4)}%），做了也亏`;
  }
  if (adjSpread > 10) {
    return `扣费后价差异常偏大（${adjSpread.toFixed(4)}%）`;
  }
  return '最终校验未通过';
}
