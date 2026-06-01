/**
 * 双腿同时下单 + 回执解析（通过 CexManager 统一接口）
 * 成交价语义对齐 backtest get_open_prices / get_close_prices：
 *   -a+b: A@bid, B@ask
 *   +a-b: A@ask, B@bid
 */
import { legPricesForDirection } from '../services/spread-calculator.js';

export class OrderExecutor {
  constructor({ cexManager, tradingEnabled }) {
    this.cexManager = cexManager;
    this.tradingEnabled = tradingEnabled;
  }

  async executeBothLegs({ direction, tick, order, reduceOnly = false }) {
    const { qty, gateSize, gateDecimalSize } = order;
    const { aPrice, bPrice } = legPricesForDirection(direction, tick);
    const binanceSide = direction === '-a+b' ? 'sell' : 'buy';
    const gateSide = direction === '-a+b' ? 'buy' : 'sell';

    if (!this.tradingEnabled) {
      return {
        simulated: true,
        aOrderId: `SIM_A_${Date.now()}`,
        bOrderId: `SIM_B_${Date.now()}`,
        aPriceUsed: aPrice,
        bPriceUsed: bPrice,
        qty,
        aFilledQty: qty,
        bFilledQty: qty
      };
    }

    const [aOrder, bOrder] = await Promise.all([
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

    const aFilled = Number(aOrder.filled || qty);
    const bFilled = Number(bOrder.filled || qty);
    const matchedQty = Math.min(aFilled, bFilled, qty);
    const fallback = legPricesForDirection(direction, tick);

    return {
      simulated: false,
      aOrderId: String(aOrder.orderId),
      bOrderId: String(bOrder.orderId),
      aPriceUsed: Number(aOrder.avgPrice || aOrder.price || fallback.aPrice),
      bPriceUsed: Number(bOrder.avgPrice || bOrder.price || fallback.bPrice),
      qty: matchedQty,
      aFilledQty: aFilled,
      bFilledQty: bFilled,
      rawA: aOrder,
      rawB: bOrder
    };
  }
}

export default OrderExecutor;
