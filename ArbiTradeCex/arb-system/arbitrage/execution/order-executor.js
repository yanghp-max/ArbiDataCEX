/**
 * 双腿同时下单 + 回执解析（通过 CexManager 统一接口）
 * 成交价语义对齐 backtest get_open_prices / get_close_prices：
 *   -a+b: A@bid, B@ask
 *   +a-b: A@ask, B@bid
 */
import { OrderStatus } from '../../cex/types.js';
import { calcSpreads, legPricesForDirection, tradeLegSides } from '../services/spread-calculator.js';
import { buildLegPnl, isFillPnlComplete } from './cex-leg-pnl.js';
import { markLatency } from '../monitoring/trade-latency.js';
import {
  checkOrderPreconditionsFromCache,
  formatPreconditionFail
} from '../../cex/utils/check-order-preconditions.js';
import { resolveBLegOrderContextFromOrder } from '../../cex/utils/leg-order-context.js';

function quoteSnapshot(direction, tick, spreadOptions = {}) {
  const nominal = legPricesForDirection(direction, tick);
  const spreads = calcSpreads(tick, spreadOptions);
  return {
    aBid: tick.aBid,
    aAsk: tick.aAsk,
    bBid: tick.bBid,
    bAsk: tick.bAsk,
    aPriceNominal: nominal.aPrice,
    bPriceNominal: nominal.bPrice,
    spreadAbPct: spreads.spreadAb,
    spreadBaPct: spreads.spreadBa
  };
}

const POLL_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 150;
const TRADE_FETCH_ATTEMPTS = 16;
const TRADE_FETCH_INTERVAL_MS = 300;
const TRADE_FETCH_INITIAL_DELAY_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFilled(order, requestedQty) {
  const filled = Number(order?.filled);
  if (Number.isFinite(filled) && filled >= 0) return filled;
  return 0;
}

function isTransientOrderLookupError(err) {
  const msg = String(err?.message || '');
  return /-2013|order does not exist/i.test(msg);
}

/** Gate 合约张数 → Binance 基础数量 */
export function gateFillToBaseQty(filledContracts, order) {
  const filled = Number(filledContracts);
  if (!Number.isFinite(filled) || filled <= 0) return 0;
  const mult = Number(order.gateQuantoMultiplier);
  if (Number.isFinite(mult) && mult > 0) return filled * mult;
  return filled;
}

export class OrderExecutor {
  constructor({
    cexManager,
    tradingEnabled,
    accountCache,
    reservationManager,
    providerA = 'binance',
    providerB = 'gate'
  }) {
    this.cexManager = cexManager;
    this.tradingEnabled = tradingEnabled;
    this.accountCache = accountCache;
    this.reservationManager = reservationManager;
    this.providerA = providerA;
    this.providerB = providerB;
  }

  async executeBothLegs({
    direction,
    tick,
    order,
    reduceOnly = false,
    lockedDirection = null,
    latencyTrace = null,
    cexFeeBpsPerLeg = 2,
    legAFeeBps = null,
    legBFeeBps = null,
    binanceFeeBps = null,
    gateFeeBps = null,
    maxPositionQty = null
  }) {
    const { qty, gateSize, gateDecimalSize } = order;
    const { aSide, bSide } = tradeLegSides(direction);
    const positionDirection = lockedDirection ?? direction;
    const binancePositionSide = positionDirection === '-a+b' ? 'SHORT' : 'LONG';
    const quote = quoteSnapshot(direction, tick);
    const binanceSide = aSide;
    const gateSide = bSide;
    const binanceStepSize = order.cfg?.binance?.stepSize;
    const bLegPnlOpts = this.#bLegPnlOptions(order);

    if (!this.tradingEnabled) {
      const aFeeBps = legAFeeBps ?? binanceFeeBps ?? cexFeeBpsPerLeg;
      const bFeeBps = legBFeeBps ?? gateFeeBps ?? cexFeeBpsPerLeg;
      const aLeg = buildLegPnl({
        exchange: this.providerA,
        side: aSide,
        filledQty: qty,
        order: { avgPrice: quote.aPriceNominal, cumQuote: qty * quote.aPriceNominal },
        feeBpsFallback: aFeeBps
      });
      const bLeg = buildLegPnl({
        exchange: this.providerB,
        side: bSide,
        filledQty: qty,
        order: { avgPrice: quote.bPriceNominal, cumQuote: qty * quote.bPriceNominal },
        feeBpsFallback: bFeeBps,
        ...bLegPnlOpts
      });
      return {
        simulated: true,
        aOrderId: `SIM_A_${Date.now()}`,
        bOrderId: `SIM_B_${Date.now()}`,
        aSide,
        bSide,
        aPrice: quote.aPriceNominal,
        bPrice: quote.bPriceNominal,
        aFillPrice: quote.aPriceNominal,
        bFillPrice: quote.bPriceNominal,
        quote,
        qty,
        aFilledQty: qty,
        bFilledQty: qty,
        aLeg,
        bLeg,
        pnlComplete: true,
        legMismatch: false,
        legExposure: false
      };
    }

    this.#assertOrderPreconditionsFromCache({
      tick,
      quote,
      order,
      binanceSide,
      gateSide,
      qty,
      reduceOnly,
      maxPositionQty
    });
    markLatency(latencyTrace, 'pre_order_done');
    markLatency(latencyTrace, 'order_send_start');

    const submitMs = { [this.providerA]: null, [this.providerB]: null };
    const placeBinance = async () => {
      const t0 = Date.now();
      try {
        return await this.cexManager.placeOrder(this.providerA, {
          symbol: tick.symbol,
          side: binanceSide,
          type: 'market',
          amount: qty,
          stepSize: binanceStepSize,
          reduceOnly,
          positionDirection,
          positionSide: binancePositionSide
        });
      } finally {
        submitMs[this.providerA] = Date.now() - t0;
      }
    };

    const placeGate = async () => {
      const t0 = Date.now();
      try {
        return await this.cexManager.placeOrder(this.providerB, {
          symbol: tick.symbol,
          side: gateSide,
          type: 'market',
          amount: gateSize,
          decimalSize: gateDecimalSize,
          reduceOnly
        });
      } finally {
        submitMs[this.providerB] = Date.now() - t0;
      }
    };

    const [aResult, bResult] = await Promise.allSettled([placeBinance(), placeGate()]);
    markLatency(latencyTrace, 'order_send_done');
    const parallelMs = Math.max(0, (latencyTrace?.marks?.order_send_done ?? 0)
      - (latencyTrace?.marks?.order_send_start ?? 0));
    if (latencyTrace) {
      latencyTrace.orderSubmitMs = { ...submitMs, parallel: parallelMs };
    }
    this.#logPlaceOrderSubmit(tick.symbol, submitMs, parallelMs, aResult, bResult);

    if (aResult.status === 'rejected' && bResult.status === 'rejected') {
      throw new Error(
        `两腿都失败: ${this.providerA}=${aResult.reason?.message}; ${this.providerB}=${bResult.reason?.message}`
      );
    }

    let aOrder = aResult.status === 'fulfilled' ? aResult.value : null;
    let bOrder = bResult.status === 'fulfilled' ? bResult.value : null;
    const failedLeg = aResult.status === 'rejected'
      ? this.providerA
      : bResult.status === 'rejected'
        ? this.providerB
        : null;
    const failReason = failedLeg === this.providerA
      ? aResult.reason?.message
      : failedLeg === this.providerB
        ? bResult.reason?.message
        : null;

    if (aOrder) {
      const polled = await this.#ensureOrderFill(this.providerA, aOrder, tick.symbol, qty);
      aOrder = polled.order;
    }
    if (bOrder) {
      const polled = await this.#ensureOrderFill(this.providerB, bOrder, tick.symbol, gateSize, gateDecimalSize);
      bOrder = polled.order;
    }
    const aFilled = aOrder ? readFilled(aOrder, qty) : 0;
    const bFilledBase = bOrder ? gateFillToBaseQty(readFilled(bOrder, gateSize), order) : 0;

    if (aFilled <= 0 && bFilledBase <= 0) {
      const detail = failedLeg
        ? `${failedLeg}拒单: ${failReason}`
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

    const fallback = legPricesForDirection(direction, tick);
    const aPricePost = aFilled > 0 && aOrder
      ? Number(aOrder.avgPrice || aOrder.price || fallback.aPrice)
      : null;
    const bPricePost = bFilledBase > 0 && bOrder
      ? Number(bOrder.avgPrice || bOrder.price || fallback.bPrice)
      : null;

    if (aOrder && aFilled > 0) {
      if (!(Number(aOrder.cumQuote) > 0) && aPricePost > 0) {
        aOrder = { ...aOrder, cumQuote: aFilled * aPricePost };
      }
      const aTrades = await this.#fetchOrderTradesWithRetry(this.providerA, aOrder.orderId, tick.symbol);
      aOrder = { ...aOrder, trades: aTrades };
    }
    if (bOrder && bFilledBase > 0) {
      if (!(Number(bOrder.cumQuote) > 0) && bPricePost > 0) {
        bOrder = { ...bOrder, cumQuote: bFilledBase * bPricePost };
      }
      const bTrades = await this.#fetchOrderTradesWithRetry(this.providerB, bOrder.orderId, tick.symbol, {
        decimalSize: gateDecimalSize
      });
      bOrder = { ...bOrder, trades: bTrades };
    }

    const aLeg = aFilled > 0
      ? buildLegPnl({
        exchange: this.providerA,
        side: aSide,
        filledQty: aFilled,
        order: aOrder,
        trades: aOrder?.trades,
        requireRealFee: true
      })
      : { exchange: this.providerA, side: aSide, filledQty: 0, usdtChange: 0, quoteVolume: 0, fee: 0, filled: false, pnlComplete: false };
    const bLeg = bFilledBase > 0
      ? buildLegPnl({
        exchange: this.providerB,
        side: bSide,
        filledQty: bFilledBase,
        order: bOrder,
        trades: bOrder?.trades,
        requireRealFee: true,
        ...bLegPnlOpts
      })
      : { exchange: this.providerB, side: bSide, filledQty: 0, usdtChange: 0, quoteVolume: 0, fee: 0, filled: false, pnlComplete: false };

    const fill = {
      simulated: false,
      aOrderId: aOrder ? String(aOrder.orderId) : null,
      bOrderId: bOrder ? String(bOrder.orderId) : null,
      aSide,
      bSide,
      aPrice: aPricePost,
      bPrice: bPricePost,
      aFillPrice: aPricePost,
      bFillPrice: bPricePost,
      quote,
      qty: matchedQty,
      aFilledQty: aFilled,
      bFilledQty: bFilledBase,
      aLeg,
      bLeg,
      pnlComplete: isFillPnlComplete({ aLeg, bLeg }),
      legMismatch,
      legExposure,
      failedLeg,
      failReason,
      latencyTrace
    };

    if (!fill.pnlComplete) {
      const missing = [];
      if (aLeg.filled && aLeg.pnlComplete === false) missing.push(this.providerA);
      if (bLeg.filled && bLeg.pnlComplete === false) missing.push(this.providerB);
      console.warn(
        `[OrderExecutor] 真实 PnL 不完整（未拿到成交 fee）: ${tick.symbol} ${missing.join(', ')}`
      );
    }

    return fill;
  }

  /** 强平/回滚等已提交订单：轮询成交并组装 fill（与 executeBothLegs 回执语义一致） */
  async assembleFillFromCloseLegs({
    symbol,
    direction,
    tick,
    order,
    aOrder = null,
    bOrder = null,
    aSide = null,
    bSide = null,
    aRequestedQty = 0,
    bRequestedGateSize = 0
  }) {
    const { qty, gateSize, gateDecimalSize } = order ?? {};
    const quote = quoteSnapshot(direction, tick);
    const bLegPnlOpts = this.#bLegPnlOptions(order);

    if (aOrder && aRequestedQty > 0) {
      const polled = await this.#ensureOrderFill(this.providerA, aOrder, tick.symbol, aRequestedQty);
      aOrder = polled.order;
    }
    if (bOrder && bRequestedGateSize > 0) {
      const polled = await this.#ensureOrderFill(
        this.providerB,
        bOrder,
        tick.symbol,
        bRequestedGateSize,
        gateDecimalSize
      );
      bOrder = polled.order;
    }

    const aFilled = aOrder ? readFilled(aOrder, aRequestedQty || qty) : 0;
    const bFilledBase = bOrder
      ? gateFillToBaseQty(readFilled(bOrder, bRequestedGateSize || gateSize), order)
      : 0;

    const legMismatch = aFilled > 0 && bFilledBase > 0 && Math.abs(aFilled - bFilledBase) > 1e-6;
    const legExposure = (aFilled > 0 && bFilledBase <= 0) || (bFilledBase > 0 && aFilled <= 0) || legMismatch;
    const matchedQty = aFilled > 0 && bFilledBase > 0
      ? Math.min(aFilled, bFilledBase, qty ?? aRequestedQty ?? bFilledBase)
      : Math.max(aFilled, bFilledBase);

    const fallback = legPricesForDirection(direction, tick);
    const aPricePost = aFilled > 0 && aOrder
      ? Number(aOrder.avgPrice || aOrder.price || fallback.aPrice)
      : null;
    const bPricePost = bFilledBase > 0 && bOrder
      ? Number(bOrder.avgPrice || bOrder.price || fallback.bPrice)
      : null;

    if (aOrder && aFilled > 0) {
      if (!(Number(aOrder.cumQuote) > 0) && aPricePost > 0) {
        aOrder = { ...aOrder, cumQuote: aFilled * aPricePost };
      }
      const aTrades = await this.#fetchOrderTradesWithRetry(this.providerA, aOrder.orderId, tick.symbol);
      aOrder = { ...aOrder, trades: aTrades };
    }
    if (bOrder && bFilledBase > 0) {
      if (!(Number(bOrder.cumQuote) > 0) && bPricePost > 0) {
        bOrder = { ...bOrder, cumQuote: bFilledBase * bPricePost };
      }
      const bTrades = await this.#fetchOrderTradesWithRetry(this.providerB, bOrder.orderId, tick.symbol, {
        decimalSize: gateDecimalSize
      });
      bOrder = { ...bOrder, trades: bTrades };
    }

    const aLeg = aFilled > 0
      ? buildLegPnl({
        exchange: this.providerA,
        side: aSide,
        filledQty: aFilled,
        order: aOrder,
        trades: aOrder?.trades,
        requireRealFee: true
      })
      : {
        exchange: this.providerA,
        side: aSide,
        filledQty: 0,
        usdtChange: 0,
        quoteVolume: 0,
        fee: 0,
        filled: false,
        pnlComplete: false
      };
    const bLeg = bFilledBase > 0
      ? buildLegPnl({
        exchange: this.providerB,
        side: bSide,
        filledQty: bFilledBase,
        order: bOrder,
        trades: bOrder?.trades,
        requireRealFee: true,
        ...bLegPnlOpts
      })
      : {
        exchange: this.providerB,
        side: bSide,
        filledQty: 0,
        usdtChange: 0,
        quoteVolume: 0,
        fee: 0,
        filled: false,
        pnlComplete: false
      };

    return {
      simulated: false,
      aOrderId: aOrder ? String(aOrder.orderId) : null,
      bOrderId: bOrder ? String(bOrder.orderId) : null,
      aSide,
      bSide,
      aPrice: aPricePost,
      bPrice: bPricePost,
      aFillPrice: aPricePost,
      bFillPrice: bPricePost,
      quote,
      qty: matchedQty,
      aFilledQty: aFilled,
      bFilledQty: bFilledBase,
      aLeg,
      bLeg,
      pnlComplete: isFillPnlComplete({ aLeg, bLeg }),
      legMismatch,
      legExposure,
      failedLeg: null,
      failReason: null,
      latencyTrace: null
    };
  }

  #bLegPnlOptions(order) {
    const ctx = resolveBLegOrderContextFromOrder(order);
    return {
      quantityUnit: ctx.quantityUnit,
      tradeFormat: ctx.tradeFormat,
      quantoMultiplier: ctx.quantoMultiplier
    };
  }

  #assertOrderPreconditionsFromCache({
    tick,
    quote,
    order,
    binanceSide,
    gateSide,
    qty,
    reduceOnly,
    maxPositionQty
  }) {
    if (!this.accountCache) {
      throw new Error('[OrderExecutor] accountCache 未注入，无法缓存预检');
    }

    const bCtx = resolveBLegOrderContextFromOrder(order);
    const gateSize = Number(order?.gateSize ?? qty);
    const cacheOpts = {
      reservationManager: this.reservationManager,
      trustReservation: Boolean(this.reservationManager)
    };

    const binanceCheck = checkOrderPreconditionsFromCache(this.accountCache, {
      exchange: this.providerA,
      symbol: tick.symbol,
      side: binanceSide,
      amount: qty,
      maxPosition: maxPositionQty,
      estimatedPrice: quote.aPriceNominal,
      reduceOnly,
      legRole: 'A',
      ...cacheOpts
    });
    const gateCheck = checkOrderPreconditionsFromCache(this.accountCache, {
      exchange: this.providerB,
      symbol: tick.symbol,
      side: gateSide,
      amount: qty,
      gateAmount: gateSize,
      maxPosition: maxPositionQty,
      estimatedPrice: quote.bPriceNominal,
      quantoMultiplier: bCtx.quantoMultiplier,
      quantityUnit: bCtx.quantityUnit,
      legRole: 'B',
      reduceOnly,
      ...cacheOpts
    });

    if (!binanceCheck.overall) {
      throw new Error(formatPreconditionFail(this.providerA, binanceCheck));
    }
    if (!gateCheck.overall) {
      throw new Error(formatPreconditionFail(this.providerB, gateCheck));
    }
  }

  #logPlaceOrderSubmit(symbol, submitMs, parallelMs, aResult, bResult) {
    if (!this.tradingEnabled) return;
    const fmtLeg = (name, ms, result) => {
      if (ms == null) return `${name} -`;
      if (result.status === 'fulfilled') {
        return `${name} ${ms}ms id=${result.value?.orderId ?? '?'}`;
      }
      const msg = result.reason?.message || 'unknown';
      return `${name} FAIL ${ms}ms (${msg})`;
    };
    console.log(
      `[发单·提交] ${symbol}`
      + ` ${fmtLeg(this.providerA, submitMs[this.providerA], aResult)}`
      + ` | ${fmtLeg(this.providerB, submitMs[this.providerB], bResult)}`
      + ` | 并行 ${parallelMs}ms（placeOrder 返回，不含等成交）`
    );
  }

  async #fetchOrderTradesWithRetry(exchange, orderId, symbol, options = {}) {
    await sleep(exchange === this.providerB ? TRADE_FETCH_INITIAL_DELAY_MS : 150);
    const orderKey = String(orderId);
    for (let i = 0; i < TRADE_FETCH_ATTEMPTS; i += 1) {
      try {
        const trades = await this.cexManager.getOrderTrades(exchange, orderKey, symbol, options);
        if (Array.isArray(trades) && trades.length > 0) {
          return trades;
        }
      } catch (err) {
        console.warn(`[OrderExecutor] ${exchange} trades fetch failed order=${orderKey}: ${err.message}`);
      }
      if (i < TRADE_FETCH_ATTEMPTS - 1) {
        await sleep(TRADE_FETCH_INTERVAL_MS);
      }
    }
    return [];
  }

  async #ensureOrderFill(exchange, order, symbol, requestedQty, gateDecimalSize = false) {
    const pollStart = Date.now();
    let current = order;
    let polled = false;
    const needsPoll = () => {
      const filled = readFilled(current, requestedQty);
      const avg = Number(current.avgPrice || current.price || 0);
      const terminal = current.status === OrderStatus.FILLED || current.status === OrderStatus.CANCELLED;
      return filled <= 0 || avg <= 0 || (!terminal && filled < requestedQty);
    };

    if (!needsPoll()) {
      return { order: current, pollMs: 0 };
    }

    for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
      polled = true;
      await sleep(POLL_INTERVAL_MS);
      try {
        current = await this.cexManager.getOrderStatus(exchange, current.orderId, symbol);
      } catch (err) {
        const transient = isTransientOrderLookupError(err);
        const lastAttempt = i >= POLL_ATTEMPTS - 1;
        if (!transient || lastAttempt) {
          throw err;
        }
        console.warn(
          `[OrderExecutor] ${exchange} getOrderStatus transient miss order=${current?.orderId} `
          + `(attempt ${i + 1}/${POLL_ATTEMPTS}): ${err.message}`
        );
        continue;
      }
      if (!needsPoll()) break;
    }
    return { order: current, pollMs: polled ? Date.now() - pollStart : 0 };
  }
}

export default OrderExecutor;
