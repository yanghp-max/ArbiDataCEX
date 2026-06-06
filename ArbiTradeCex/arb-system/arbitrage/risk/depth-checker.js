/**
 * 下单前 REST 订单簿深度预检：按 VWAP 模拟市价吃单，估算滑点与净利 edge。
 */
import { legPricesForDirection, tradeLegSides } from '../services/spread-calculator.js';
import { calcTradeGross, calcTradeFeeCost } from '../execution/result-reporter.js';

/** 从一档起逐档吃单，levels 已按价格排序 */
export function simulateMarketFill(levels, qty) {
  if (!(qty > 0) || !Array.isArray(levels) || levels.length === 0) {
    return { vwap: null, filledQty: 0, notional: 0 };
  }
  let remaining = qty;
  let notional = 0;
  for (const { price, size } of levels) {
    if (remaining <= 0) break;
    if (!(price > 0 && size > 0)) continue;
    const take = Math.min(remaining, size);
    notional += take * price;
    remaining -= take;
  }
  const filledQty = qty - remaining;
  return {
    vwap: filledQty > 0 ? notional / filledQty : null,
    filledQty,
    notional
  };
}

function slipBps(side, quotePx, vwap) {
  if (!(quotePx > 0) || !(vwap > 0)) return null;
  const raw = ((vwap - quotePx) / quotePx) * 10000;
  return side === 'sell' ? -raw : raw;
}

function simSpreadPct(direction, aVwap, bVwap) {
  if (direction === '-a+b') {
    return bVwap > 0 ? ((aVwap - bVwap) / bVwap) * 100 : -Infinity;
  }
  return aVwap > 0 ? ((bVwap - aVwap) / aVwap) * 100 : -Infinity;
}

export class DepthChecker {
  constructor(cfg = {}) {
    this.enabled = cfg.depthCheckEnabled === true;
    this.levels = Number(cfg.depthLevels) || 20;
    this.minFillRatio = Number(cfg.depthMinFillRatio) || 0.999;
    this.minEdgeBps = Number(cfg.depthMinEdgeBps) || 0;
    this.fetchTimeoutMs = Number(cfg.depthFetchTimeoutMs) || 500;
  }

  async fetchBooks(cexManager, symbol) {
    const limit = this.levels;
    const timeout = this.fetchTimeoutMs;
    const fetchOne = (exchange) => {
      const adapter = cexManager.get(exchange);
      if (!adapter?.getOrderBook) {
        throw new Error(`${exchange} 不支持 getOrderBook`);
      }
      return adapter.getOrderBook(symbol, limit, { timeoutMs: timeout });
    };
    const [binance, gate] = await Promise.all([
      fetchOne('binance'),
      fetchOne('gate')
    ]);
    return { binance, gate };
  }

  evaluate({
    direction,
    action = 'open',
    lockedDirection,
    qty,
    books,
    tick,
    feeBpsTotal = 4,
    slippageBpsTotal = 4
  }) {
    const { aSide, bSide } = tradeLegSides(direction);
    const aLevels = aSide === 'sell' ? books.binance?.bids : books.binance?.asks;
    const bLevels = bSide === 'sell' ? books.gate?.bids : books.gate?.asks;

    const aSim = simulateMarketFill(aLevels, qty);
    const bSim = simulateMarketFill(bLevels, qty);
    const minQty = qty * this.minFillRatio;

    if (aSim.filledQty < minQty || bSim.filledQty < minQty) {
      const aPct = qty > 0 ? (aSim.filledQty / qty) * 100 : 0;
      const bPct = qty > 0 ? (bSim.filledQty / qty) * 100 : 0;
      return {
        pass: false,
        reason: '盘口深度不足',
        detail: `可成交量 A=${aPct.toFixed(1)}% B=${bPct.toFixed(1)}% (需≥${(this.minFillRatio * 100).toFixed(1)}%)`
      };
    }

    const aVwap = aSim.vwap;
    const bVwap = bSim.vwap;
    if (!(aVwap > 0) || !(bVwap > 0)) {
      return { pass: false, reason: 'VWAP无效', detail: '' };
    }

    const simFill = {
      aFilledQty: aSim.filledQty,
      bFilledQty: bSim.filledQty,
      aFillPrice: aVwap,
      bFillPrice: bVwap
    };
    const pnlCtx = action === 'close'
      ? { action: 'close', direction, lockedDirection: lockedDirection ?? direction }
      : { action: 'open', direction, lockedDirection: direction };
    const simGross = calcTradeGross(simFill, pnlCtx);
    const feeCost = calcTradeFeeCost(simFill, feeBpsTotal, slippageBpsTotal);
    const simNet = simGross != null ? simGross - feeCost : null;

    const totalCostPct = (feeBpsTotal + slippageBpsTotal) / 100;
    const spreadPct = simSpreadPct(direction, aVwap, bVwap);
    const simNetPct = spreadPct - totalCostPct;
    const minEdgePct = this.minEdgeBps / 100;

    const { aPrice, bPrice } = legPricesForDirection(direction, tick);
    const aSlip = slipBps(aSide, aPrice, aVwap);
    const bSlip = slipBps(bSide, bPrice, bVwap);

    const detail = [
      `simSpread=${spreadPct.toFixed(3)}% net=${simNetPct.toFixed(3)}%`,
      simNet != null ? `simPnl=${simNet >= 0 ? '+' : ''}${simNet.toFixed(4)}U` : '',
      `A vwap=${aVwap.toFixed(6)} slip=${fmtBps(aSlip)}`,
      `B vwap=${bVwap.toFixed(6)} slip=${fmtBps(bSlip)}`
    ].filter(Boolean).join(' · ');

    if (simNetPct < minEdgePct) {
      return {
        pass: false,
        reason: `模拟净利不足 (${simNetPct.toFixed(3)}% < ${minEdgePct.toFixed(3)}%)`,
        detail,
        simGross,
        simNet,
        simNetPct,
        aVwap,
        bVwap,
        aSlipBps: aSlip,
        bSlipBps: bSlip
      };
    }

    return {
      pass: true,
      detail,
      simGross,
      simNet,
      simNetPct,
      aVwap,
      bVwap,
      aSlipBps: aSlip,
      bSlipBps: bSlip
    };
  }

  async check({
    cexManager,
    symbol,
    direction,
    action,
    lockedDirection,
    qty,
    tick,
    feeBpsTotal,
    slippageBpsTotal
  }) {
    const t0 = Date.now();
    const books = await this.fetchBooks(cexManager, symbol);
    const fetchMs = Date.now() - t0;
    const result = this.evaluate({
      direction,
      action,
      lockedDirection,
      qty,
      books,
      tick,
      feeBpsTotal,
      slippageBpsTotal
    });
    return { ...result, fetchMs };
  }
}

function fmtBps(v) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}bps`;
}

export default DepthChecker;
