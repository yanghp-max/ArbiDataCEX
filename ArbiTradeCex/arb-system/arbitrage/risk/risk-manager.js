import fs from 'node:fs/promises';
import path from 'node:path';
import { floorByStep } from '../../common/utils/precision.js';
import { legPricesForDirection } from '../services/spread-calculator.js';

export class PrecisionChecker {
  constructor(minQtyBySymbol = {}) {
    this.minQtyBySymbol = minQtyBySymbol;
  }

  static async loadFromJson(jsonPath, symbols) {
    const text = await fs.readFile(jsonPath, 'utf8');
    const json = JSON.parse(text);
    const map = {};
    for (const sym of symbols) {
      if (json.symbols?.[sym]) map[sym] = json.symbols[sym];
    }
    return new PrecisionChecker(map);
  }

  resolvePath(configPath, rootDir) {
    if (path.isAbsolute(configPath)) return configPath;
    return path.resolve(rootDir, configPath);
  }

  buildOrder({ direction, tick, orderUsd }) {
    const cfg = this.minQtyBySymbol[tick.symbol];
    if (!cfg) return { qty: 0 };

    const { aPrice } = legPricesForDirection(direction, tick);
    const rawQty = orderUsd / aPrice;
    let qty = floorByStep(rawQty, Number(cfg.binance.stepSize));
    if (qty < Number(cfg.binance.minQty)) qty = Number(cfg.binance.minQty);
    qty = floorByStep(qty, Number(cfg.binance.stepSize));

    const gateCfg = cfg.gate;
    const minGate = Number(gateCfg.minQty);
    const step = Number(gateCfg.stepSize || 1);
    let gateSize = 0;

    if (gateCfg.quantityUnit === 'base' || gateCfg.enableDecimal) {
      gateSize = floorByStep(qty, step);
      if (gateSize < minGate) gateSize = minGate;
    } else {
      const multiplier = Number(gateCfg.quantoMultiplier || 0);
      if (multiplier > 0) {
        gateSize = floorByStep(qty / multiplier, step);
        if (gateSize < minGate) gateSize = minGate;
        // 按 Gate 合约张数回推 Binance 基础数量，避免两腿对冲量不一致
        qty = floorByStep(gateSize * multiplier, Number(cfg.binance.stepSize));
      }
    }

    if (qty <= 0 || gateSize <= 0) return { qty: 0, gateSize: 0 };

    return {
      qty,
      gateSize,
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

export function finalCheckPass(tick, direction, adjSpread, maxPriceAgeMs) {
  if (tick.priceAgeMs > maxPriceAgeMs) return false;
  if (adjSpread < 0 || adjSpread > 10) return false;
  return true;
}
