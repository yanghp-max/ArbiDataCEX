/**
 * CEX 模块类型定义（对齐 ArbiTrade-1/arb-system/cex/types.js）
 */

export class Ticker {
  constructor({
    symbol,
    exchange,
    type = 'futures',
    bid,
    ask,
    bidQty,
    askQty,
    timestamp
  }) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.type = type;
    this.bid = Number(bid);
    this.ask = Number(ask);
    this.bidQty = Number(bidQty) || 0;
    this.askQty = Number(askQty) || 0;
    this.timestamp = timestamp || Date.now();
  }

  getSpread() {
    return this.ask - this.bid;
  }

  getMidPrice() {
    return (this.bid + this.ask) / 2;
  }
}

export class OrderBook {
  constructor({ symbol, exchange, bids = [], asks = [], timestamp }) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.bids = bids.map(([price, size]) => ({ price: Number(price), size: Number(size) }));
    this.asks = asks.map(([price, size]) => ({ price: Number(price), size: Number(size) }));
    this.timestamp = timestamp || Date.now();
  }
}

export class Order {
  constructor({
    orderId,
    clientOrderId,
    symbol,
    exchange,
    side,
    type,
    amount,
    price,
    status,
    filled = 0,
    remaining,
    timestamp,
    updateTime,
    avgPrice = 0,
    cumQuote = 0
  }) {
    this.orderId = orderId;
    this.clientOrderId = clientOrderId;
    this.symbol = symbol;
    this.exchange = exchange;
    this.side = side;
    this.type = type;
    this.amount = Number(amount);
    this.price = price != null ? Number(price) : null;
    this.status = status;
    this.filled = Number(filled);
    this.remaining = remaining !== undefined ? Number(remaining) : this.amount - this.filled;
    this.timestamp = timestamp || Date.now();
    this.updateTime = updateTime || timestamp || Date.now();
    this.avgPrice = Number(avgPrice) || 0;
    this.cumQuote = Number(cumQuote) || 0;
  }
}

export class Balance {
  constructor({ currency, exchange, total = 0, available = 0, frozen = 0, timestamp }) {
    this.currency = currency;
    this.exchange = exchange;
    this.total = Number(total);
    this.available = Number(available);
    this.frozen = Number(frozen);
    this.timestamp = timestamp || Date.now();
  }
}

export class Position {
  constructor({
    symbol,
    exchange,
    side,
    size = 0,
    qty,
    entryPrice = 0,
    markPrice = 0,
    unrealizedPnl = 0,
    leverage = 1,
    timestamp
  }) {
    this.symbol = symbol;
    this.exchange = exchange;
    this.side = side;
    this.size = Number(size);
    this.qty = qty !== undefined ? Number(qty) : (side === 'short' ? -this.size : this.size);
    this.entryPrice = Number(entryPrice);
    this.markPrice = Number(markPrice);
    this.unrealizedPnl = Number(unrealizedPnl);
    this.leverage = Number(leverage);
    this.timestamp = timestamp || Date.now();
  }
}

export const EventTypes = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  RECONNECTED: 'reconnected',
  ERROR: 'error',
  TICKER: 'ticker',
  ORDERBOOK: 'orderbook',
  TRADE: 'trade',
  ORDER_UPDATE: 'order_update',
  BALANCE_UPDATE: 'balance_update',
  POSITION_UPDATE: 'position_update'
};

export const OrderStatus = {
  PENDING: 'pending',
  OPEN: 'open',
  FILLED: 'filled',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  PARTIALLY_FILLED: 'partially_filled'
};

export default {
  Ticker,
  OrderBook,
  Order,
  Balance,
  Position,
  EventTypes,
  OrderStatus
};
