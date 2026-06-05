/**
 * 双腿同时下单 + 回执解析（通过 CexManager 统一接口）
 * 成交价语义对齐 backtest get_open_prices / get_close_prices：
 *   -a+b: A@bid, B@ask
 *   +a-b: A@ask, B@bid
 */
import { OrderStatus } from '../../cex/types.js';
import { legPricesForDirection, tradeLegSides } from '../services/spread-calculator.js';

const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFilled(order, requestedQty) {
  const filled = Number(order?.filled);
  if (Number.isFinite(filled) && filled >= 0) return filled;
  return 0;
}

/** Gate 合约张数 → Binance 基础数量 */
export function gateFillToBaseQty(filledContracts, order) {
  const filled = Number(filledContracts);
  if (!Number.isFinite(filled) || filled <= 0) return 0;
  if (order.gateDecimalSize || order.gateQuantityUnit === 'base') return filled;
  const mult = Number(order.gateQuantoMultiplier);
  if (!Number.isFinite(mult) || mult <= 0) return filled;
  return filled * mult;
}

export class OrderExecutor {
  constructor({ cexManager, tradingEnabled }) {
    this.cexManager = cexManager;
    this.tradingEnabled = tradingEnabled;
  }

  async executeBothLegs({ direction, tick, order, reduceOnly = false }) {
    const { qty, gateSize, gateDecimalSize } = order;
    const { aSide, bSide } = tradeLegSides(direction);
    const { aPrice, bPrice } = legPricesForDirection(direction, tick);
    const binanceSide = aSide;
    const gateSide = bSide;
    const binanceStepSize = order.cfg?.binance?.stepSize;

    if (!this.tradingEnabled) {
      return {
        simulated: true,
        aOrderId: `SIM_A_${Date.now()}`,
        bOrderId: `SIM_B_${Date.now()}`,
        aSide,
        bSide,
        aPrice,
        bPrice,
        qty,
        aFilledQty: qty,
        bFilledQty: qty,
        legMismatch: false,
        legExposure: false
      };
    }

    const fallback = legPricesForDirection(direction, tick);
    const [aResult, bResult] = await Promise.allSettled([
      this.cexManager.placeOrder('binance', {
        symbol: tick.symbol,
        side: binanceSide,
        type: 'market',
        amount: qty,
        stepSize: binanceStepSize,
        reduceOnly
      }),
      this.cexManager.placeOrder('gate', {
        symbol: tick.symbol,
        side: gateSide,
        type: 'market',
        amount: gateSize,
        decimalSize: gateDecimalSize,
        reduceOnly
      })
    ]);

    if (aResult.status === 'rejected' && bResult.status === 'rejected') {
      throw new Error(
        `两腿都失败: Binance=${aResult.reason?.message}; Gate=${bResult.reason?.message}`
      );
    }

    let aOrder = aResult.status === 'fulfilled' ? aResult.value : null;
    let bOrder = bResult.status === 'fulfilled' ? bResult.value : null;
    const failedLeg = aResult.status === 'rejected'
      ? 'binance'
      : bResult.status === 'rejected'
        ? 'gate'
        : null;
    const failReason = failedLeg === 'binance'
      ? aResult.reason?.message
      : failedLeg === 'gate'
        ? bResult.reason?.message
        : null;

    if (aOrder) {
      aOrder = await this.#ensureOrderFill('binance', aOrder, tick.symbol, qty);
    }
    if (bOrder) {
      bOrder = await this.#ensureOrderFill('gate', bOrder, tick.symbol, gateSize, gateDecimalSize);
    }

    const aFilled = aOrder ? readFilled(aOrder, qty) : 0;
    const bFilledBase = bOrder ? gateFillToBaseQty(readFilled(bOrder, gateSize), order) : 0;

    if (aFilled <= 0 && bFilledBase <= 0) {
      const detail = failedLeg
        ? `${failedLeg === 'binance' ? 'Binance' : 'Gate'}拒单: ${failReason}`
        : '两腿都没成交';
      throw new Error(detail);
    }

    const legMismatch = aFilled > 0 && bFilledBase > 0 && Math.abs(aFilled - bFilledBase) > 1e-6;
    const legExposure = Boolean(failedLeg)
      || (aFilled > 0 && bFilledBase <= 0)
      || (bFilledBase > 0 && aFilled <= 0)
      || legMismatch;
    const matchedQty = aFilled > 0 && bFilledBase > 0
      ? Math.min(aFilled, bFilledBase, qty)
      : Math.max(aFilled, bFilledBase);

    const aPricePost = aOrder
      ? Number(aOrder.avgPrice || aOrder.price || fallback.aPrice)
      : fallback.aPrice;
    const bPricePost = bOrder
      ? Number(bOrder.avgPrice || bOrder.price || fallback.bPrice)
      : fallback.bPrice;

    return {
      simulated: false,
      aOrderId: aOrder ? String(aOrder.orderId) : null,
      bOrderId: bOrder ? String(bOrder.orderId) : null,
      aSide,
      bSide,
      aPrice: aPricePost,
      bPrice: bPricePost,
      qty: matchedQty,
      aFilledQty: aFilled,
      bFilledQty: bFilledBase,
      legMismatch,
      legExposure,
      failedLeg,
      failReason
    };
  }

  async #ensureOrderFill(exchange, order, symbol, requestedQty, gateDecimalSize = false) {
    let current = order;
    const needsPoll = () => {
      const filled = readFilled(current, requestedQty);
      const avg = Number(current.avgPrice || current.price || 0);
      const terminal = current.status === OrderStatus.FILLED || current.status === OrderStatus.CANCELLED;
      return filled <= 0 || avg <= 0 || (!terminal && filled < requestedQty);
    };

    if (!needsPoll()) return current;

    for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
      await sleep(POLL_INTERVAL_MS);
      current = await this.cexManager.getOrderStatus(exchange, current.orderId, symbol);
      if (!needsPoll()) break;
    }
    return current;
  }
}

export default OrderExecutor;
