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
        legMismatch: false
      };
    }

    const fallback = legPricesForDirection(direction, tick);
    const [aResult, bResult] = await Promise.allSettled([
      this.cexManager.placeOrder('binance', {
        symbol: tick.symbol,
        side: binanceSide,
        type: 'market',
        amount: qty,
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
      throw new Error(`both legs failed: A=${aResult.reason?.message}; B=${bResult.reason?.message}`);
    }
    if (aResult.status === 'rejected' || bResult.status === 'rejected') {
      const okLeg = aResult.status === 'fulfilled' ? 'binance' : 'gate';
      const failLeg = aResult.status === 'rejected' ? 'binance' : 'gate';
      const failMsg = (aResult.status === 'rejected' ? aResult.reason : bResult.reason)?.message;
      throw new Error(`LEG_EXPOSURE: ${okLeg} placed, ${failLeg} failed: ${failMsg}`);
    }

    let aOrder = aResult.value;
    let bOrder = bResult.value;

    aOrder = await this.#ensureOrderFill('binance', aOrder, tick.symbol, qty);
    bOrder = await this.#ensureOrderFill('gate', bOrder, tick.symbol, gateSize, gateDecimalSize);

    const aFilled = readFilled(aOrder, qty);
    const bFilledBase = gateFillToBaseQty(readFilled(bOrder, gateSize), order);
    const matchedQty = Math.min(aFilled, bFilledBase, qty);
    const legMismatch = aFilled > 0 && bFilledBase > 0 && Math.abs(aFilled - bFilledBase) > 1e-6;
    const aPricePost = Number(aOrder.avgPrice || aOrder.price || fallback.aPrice);
    const bPricePost = Number(bOrder.avgPrice || bOrder.price || fallback.bPrice);

    return {
      simulated: false,
      aOrderId: String(aOrder.orderId),
      bOrderId: String(bOrder.orderId),
      aSide,
      bSide,
      aPrice: aPricePost,
      bPrice: bPricePost,
      qty: matchedQty,
      aFilledQty: aFilled,
      bFilledQty: bFilledBase,
      legMismatch
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
