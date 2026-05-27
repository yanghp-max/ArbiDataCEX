/**
 * 双腿同时下单 + 回执解析（通过 CexManager 统一接口）
 */
export class OrderExecutor {
  constructor({ cexManager, tradingEnabled }) {
    this.cexManager = cexManager;
    this.tradingEnabled = tradingEnabled;
  }

  async executeBothLegs({ direction, tick, order }) {
    const { qty, gateSize, gateDecimalSize } = order;
    const binanceSide = direction === '-a+b' ? 'sell' : 'buy';
    const gateSide = direction === '-a+b' ? 'buy' : 'sell';

    if (!this.tradingEnabled) {
      return {
        simulated: true,
        aOrderId: `SIM_A_${Date.now()}`,
        bOrderId: `SIM_B_${Date.now()}`,
        aPriceUsed: order.aPrice,
        bPriceUsed: direction === '-a+b' ? tick.bAsk : tick.bBid,
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
        amount: qty
      }),
      this.cexManager.placeOrder('gate', {
        symbol: tick.symbol,
        side: gateSide,
        type: 'market',
        amount: gateSize,
        decimalSize: gateDecimalSize
      })
    ]);

    return {
      simulated: false,
      aOrderId: String(aOrder.orderId),
      bOrderId: String(bOrder.orderId),
      aPriceUsed: Number(aOrder.avgPrice || aOrder.price || order.aPrice),
      bPriceUsed: Number(bOrder.avgPrice || bOrder.price || (direction === '-a+b' ? tick.bAsk : tick.bBid)),
      qty: Math.min(Number(aOrder.filled || qty), qty),
      aFilledQty: Number(aOrder.filled || qty),
      bFilledQty: qty,
      rawA: aOrder,
      rawB: bOrder
    };
  }
}

export default OrderExecutor;
