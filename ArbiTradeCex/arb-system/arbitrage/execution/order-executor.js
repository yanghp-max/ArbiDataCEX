/**
 * 双腿同时下单 + 回执解析
 */
export class OrderExecutor {
  constructor({ binanceAdapter, gateAdapter, tradingEnabled }) {
    this.binance = binanceAdapter;
    this.gate = gateAdapter;
    this.tradingEnabled = tradingEnabled;
  }

  async executeBothLegs({ direction, tick, order }) {
    const { qty, gateSize, gateDecimalSize } = order;
    const binanceSide = direction === '-a+b' ? 'SELL' : 'BUY';
    const signedGateSize = direction === '-a+b' ? gateSize : -gateSize;
    const contract = this.gate.toGateContract(tick.symbol);

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

    const [aRes, bRes] = await Promise.all([
      this.binance.placeMarketOrder({ symbol: tick.symbol, side: binanceSide, quantity: qty }),
      this.gate.placeMarketOrder({ contract, size: signedGateSize, decimalSize: gateDecimalSize })
    ]);

    return {
      simulated: false,
      aOrderId: String(aRes.orderId),
      bOrderId: String(bRes.id),
      aPriceUsed: Number(aRes.avgPrice || aRes.price || order.aPrice),
      bPriceUsed: Number(bRes.fill_price || bRes.price || (direction === '-a+b' ? tick.bAsk : tick.bBid)),
      qty: Math.min(Number(aRes.executedQty || qty), qty),
      aFilledQty: Number(aRes.executedQty || qty),
      bFilledQty: qty,
      rawA: aRes,
      rawB: bRes
    };
  }
}

export default OrderExecutor;
