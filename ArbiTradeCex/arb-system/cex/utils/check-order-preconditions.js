/**
 * 发单前检查（对齐 ArbiTrade-1 OrderPreCheck：优先 WS 缓存，不阻塞发单路径 REST）
 * - 余额：买/开空保证金按 estimatedPrice × amount × 1.01
 * - 持仓：maxPosition 上限（平仓减仓豁免）
 * - reduceOnly：校验方向与持仓量足够
 */

import { resolvePrecheckQtyContext } from './leg-order-context.js';

const BALANCE_BUFFER = 1.01;
const MARGIN_RATE_ESTIMATE = 0.10;
/** USDT 永续 B 腿 / Gate：按名义价值 1x 估算保证金 */
const FUTURES_STRICT_MARGIN_RATE = 1.0;

function compactSymbol(symbol) {
  return String(symbol).replace(/[-_]/g, '').toUpperCase();
}

function findPosition(positions, symbol) {
  const key = compactSymbol(symbol);
  return (positions || []).find((p) => compactSymbol(p.symbol) === key) || null;
}

function signedPositionQty(pos) {
  if (!pos) return 0;
  if (pos.qty != null && Number.isFinite(Number(pos.qty))) {
    return Number(pos.qty);
  }
  const size = Math.abs(Number(pos.size) || 0);
  if (pos.side === 'short') return -size;
  if (pos.side === 'long') return size;
  return Number(pos.size) || 0;
}

function calcRequiredBalance({
  side,
  qty,
  orderQty,
  quantityUnit,
  contracts,
  estimatedPrice,
  futuresMode = true,
  strictFuturesMargin = false
}) {
  const sideNorm = String(side || '').toLowerCase();
  const priceForCalc = Number(estimatedPrice) > 0 ? Number(estimatedPrice) : 0;

  let requiredCurrency = 'USDT';
  let requiredAmount = 0;

  if (sideNorm === 'buy') {
    if (!priceForCalc) {
      return { ok: false, reason: '买入检查缺少 estimatedPrice' };
    }
    const marginRate = strictFuturesMargin && futuresMode
      ? FUTURES_STRICT_MARGIN_RATE
      : 1;
    requiredAmount = qty * priceForCalc * marginRate * BALANCE_BUFFER;
  } else if (futuresMode) {
    if (!priceForCalc) {
      return { ok: false, reason: '卖出/开空检查缺少 estimatedPrice' };
    }
    const marginRate = strictFuturesMargin
      ? FUTURES_STRICT_MARGIN_RATE
      : MARGIN_RATE_ESTIMATE;
    requiredAmount = qty * priceForCalc * marginRate * BALANCE_BUFFER;
  } else {
    requiredAmount = qty;
  }

  const details = {
    currency: requiredCurrency,
    required: requiredAmount
  };
  if (quantityUnit === 'contract' && orderQty != null) {
    details.orderQty = orderQty;
    details.contracts = contracts;
    details.baseQty = qty;
  }
  return { ok: true, requiredCurrency, requiredAmount, details };
}

function evaluateOrderPreconditions({
  exchangeName,
  symbol,
  side,
  amount,
  gateAmount,
  maxPosition,
  estimatedPrice,
  quantoMultiplier,
  quantityUnit,
  legRole,
  reduceOnly = false,
  futuresMode = true,
  availableBalance = null,
  currentPosition = 0,
  trustReservation = false,
  cacheReliable = true,
  exchange
}) {
  const sideNorm = String(side || '').toLowerCase();
  const precheck = resolvePrecheckQtyContext({
    exchange,
    amount,
    gateAmount,
    quantoMultiplier,
    quantityUnit,
    legRole
  });
  const qty = precheck.baseQty;
  const { orderQty, contracts } = precheck;

  const result = {
    balanceCheck: { passed: false, details: {}, reason: '' },
    positionCheck: { passed: true, details: {}, reason: 'N/A' },
    closeCheck: { passed: true, details: {}, reason: 'N/A' },
    overall: false,
    exchange: exchangeName
  };

  if (!symbol || !sideNorm || !Number.isFinite(qty) || qty <= 0) {
    result.balanceCheck.reason = '无效下单参数';
    return result;
  }

  if (trustReservation) {
    if (availableBalance == null) {
      result.balanceCheck.reason = '缓存未初始化';
      return result;
    }
    result.balanceCheck.passed = true;
    result.balanceCheck.details = { source: 'cache', trustReservation: true, available: availableBalance };
    result.balanceCheck.reason = '已预占，余额复检跳过（缓存）';
    if (!cacheReliable) {
      console.warn(`[OrderPreCheck] ⚠️ ${exchangeName} 余额缓存不可靠，仍继续发单`);
    }
  } else {
    const req = calcRequiredBalance({
      side,
      qty,
      orderQty,
      quantityUnit: precheck.quantityUnit,
      contracts,
      estimatedPrice,
      futuresMode,
      strictFuturesMargin: precheck.strictFuturesMargin
    });
    if (!req.ok) {
      result.balanceCheck.reason = req.reason;
      return result;
    }

    const available = Number(availableBalance ?? 0);
    result.balanceCheck.details = { ...req.details, available };

    if (available < req.requiredAmount) {
      result.balanceCheck.reason =
        `余额不足: ${req.requiredCurrency} 可用=${available.toFixed(4)}, 需要=${req.requiredAmount.toFixed(4)}`;
      return result;
    }

    result.balanceCheck.passed = true;
    result.balanceCheck.reason =
      `余额充足: ${req.requiredCurrency} 可用=${available.toFixed(4)}, 需要=${req.requiredAmount.toFixed(4)}`;
  }

  if (reduceOnly) {
    const needShort = sideNorm === 'buy';
    const needLong = sideNorm === 'sell';
    const held = needShort
      ? (currentPosition < 0 ? Math.abs(currentPosition) : 0)
      : (currentPosition > 0 ? currentPosition : 0);

    result.closeCheck.details = {
      side: sideNorm,
      held,
      required: qty,
      currentPosition
    };

    if (needShort && currentPosition >= 0) {
      result.closeCheck.passed = false;
      result.closeCheck.reason = '平仓买入需要空头持仓';
      result.positionCheck.passed = false;
      result.positionCheck.reason = result.closeCheck.reason;
      return result;
    }
    if (needLong && currentPosition <= 0) {
      result.closeCheck.passed = false;
      result.closeCheck.reason = '平仓卖出需要多头持仓';
      result.positionCheck.passed = false;
      result.positionCheck.reason = result.closeCheck.reason;
      return result;
    }
    if (held + 1e-9 < qty) {
      result.closeCheck.passed = false;
      result.closeCheck.reason = `平仓数量不足: 持仓=${held.toFixed(8)}, 需要=${qty}`;
      result.positionCheck.passed = false;
      result.positionCheck.reason = result.closeCheck.reason;
      return result;
    }

    result.closeCheck.passed = true;
    result.closeCheck.reason = `平仓检查通过: 持仓=${held.toFixed(8)}`;
    result.positionCheck.passed = true;
    result.positionCheck.reason = result.closeCheck.reason;
    result.overall = true;
    return result;
  }

  if (maxPosition != null && Number.isFinite(Number(maxPosition))) {
    const limit = Number(maxPosition);
    const afterPosition = sideNorm === 'buy'
      ? currentPosition + qty
      : currentPosition - qty;
    const isReducing = Math.abs(afterPosition) < Math.abs(currentPosition);

    result.positionCheck.details = {
      current: currentPosition,
      afterOrder: afterPosition,
      limit
    };

    if (Math.abs(afterPosition) > limit && !isReducing) {
      result.positionCheck.passed = false;
      result.positionCheck.reason =
        `超过持仓限制: 当前=${currentPosition.toFixed(4)}, 下单后=${afterPosition.toFixed(4)}, 限制=${limit}`;
      return result;
    }

    result.positionCheck.passed = true;
    result.positionCheck.reason =
      `持仓检查通过: 当前=${currentPosition.toFixed(4)}, 下单后=${afterPosition.toFixed(4)}, 限制=${limit}`;
  }

  result.overall = result.balanceCheck.passed && result.positionCheck.passed;
  return result;
}

/**
 * 缓存预检（对齐 ArbiTrade-1 SmartBalanceCache + OrderPreCheck，不发 REST）
 * @param {import('../../arbitrage/cache/account-cache.js').AccountCache} accountCache
 * @param {object} params
 * @param {boolean} [params.trustReservation] - tryReserve 后跳过余额复检，仅校验缓存就绪与仓位
 * @param {'A'|'B'} [params.legRole] - B 腿使用 Gate 式 USDT 永续保证金估算
 * @param {'contract'|'base'} [params.quantityUnit] - B 腿下单单位
 */
export function checkOrderPreconditionsFromCache(accountCache, params = {}) {
  const {
    exchange,
    reservationManager = null,
    trustReservation = false,
    ...rest
  } = params;

  const exchangeName = String(exchange || 'cex');
  const bal = accountCache?.getBalance?.(exchange) ?? null;
  let availableBalance = null;
  if (bal) {
    availableBalance = trustReservation
      ? (Number.isFinite(bal.available) ? bal.available : bal.total)
      : (reservationManager?.getAvailableUsdt?.(exchange)
        ?? (Number.isFinite(bal.available) ? bal.available : bal.total));
  }

  const currentPosition = accountCache?.getPosition?.(exchange, rest.symbol) ?? 0;

  try {
    return evaluateOrderPreconditions({
      exchangeName,
      exchange,
      availableBalance,
      currentPosition,
      cacheReliable: accountCache?.isReliable?.(exchange) !== false,
      trustReservation,
      ...rest
    });
  } catch (error) {
    return {
      balanceCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      positionCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      closeCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      overall: false,
      error: error.message,
      exchange: exchangeName
    };
  }
}

/**
 * @param {object} adapter - Binance/Gate/Aster 适配器（需 getBalance / getPositions）
 * @param {object} params
 * @param {string} params.symbol - 如 WLDUSDT
 * @param {string} params.side - buy | sell
 * @param {number} params.amount - A 腿或 B 腿基础币数量
 * @param {number} [params.gateAmount] - B 腿实际下单量（张数或基础币，见 quantityUnit）
 * @param {number} [params.maxPosition] - 最大持仓（基础币）
 * @param {number} [params.estimatedPrice] - 名义价（买用 ask，卖用 bid）
 * @param {number} [params.quantoMultiplier] - B 腿合约乘数
 * @param {'contract'|'base'} [params.quantityUnit]
 * @param {'A'|'B'} [params.legRole]
 * @param {boolean} [params.reduceOnly]
 * @param {boolean} [params.futuresMode=true]
 */
export async function checkOrderPreconditions(adapter, params = {}) {
  const {
    symbol,
    side,
    amount,
    gateAmount,
    maxPosition,
    estimatedPrice,
    quantoMultiplier,
    quantityUnit,
    legRole,
    reduceOnly = false,
    futuresMode = true
  } = params;

  const exchangeName = adapter?.config?.name || adapter?.id || 'CEX';
  const exchange = String(adapter?.id || adapter?.config?.name || '').toLowerCase();

  try {
    const balances = await adapter.getBalance({ silent: true });
    const positions = await adapter.getPositions({ silent: true });
    const pos = findPosition(positions, symbol);
    const currentPosition = signedPositionQty(pos);

    const precheck = resolvePrecheckQtyContext({
      exchange,
      side,
      amount,
      gateAmount,
      quantoMultiplier,
      quantityUnit,
      legRole
    });
    const req = calcRequiredBalance({
      side,
      qty: precheck.baseQty,
      orderQty: precheck.orderQty,
      quantityUnit: precheck.quantityUnit,
      contracts: precheck.contracts,
      estimatedPrice,
      futuresMode,
      strictFuturesMargin: precheck.strictFuturesMargin
    });
    if (!req.ok) {
      return {
        balanceCheck: { passed: false, details: {}, reason: req.reason },
        positionCheck: { passed: true, details: {}, reason: 'N/A' },
        closeCheck: { passed: true, details: {}, reason: 'N/A' },
        overall: false,
        exchange: exchangeName
      };
    }
    const balance = (balances || []).find((b) => String(b.currency).toUpperCase() === req.requiredCurrency);
    const available = Number(balance?.available ?? 0);

    return evaluateOrderPreconditions({
      exchangeName,
      exchange,
      symbol,
      side,
      amount,
      gateAmount,
      maxPosition,
      estimatedPrice,
      quantoMultiplier,
      quantityUnit,
      legRole,
      reduceOnly,
      futuresMode,
      availableBalance: available,
      currentPosition
    });
  } catch (error) {
    return {
      balanceCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      positionCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      closeCheck: { passed: false, details: {}, reason: `检查失败: ${error.message}` },
      overall: false,
      error: error.message,
      exchange: exchangeName
    };
  }
}

export function formatPreconditionFail(exchange, checkResult) {
  const parts = [];
  if (!checkResult?.balanceCheck?.passed && checkResult?.balanceCheck?.reason) {
    parts.push(checkResult.balanceCheck.reason);
  }
  if (!checkResult?.positionCheck?.passed && checkResult?.positionCheck?.reason) {
    parts.push(checkResult.positionCheck.reason);
  }
  if (!checkResult?.closeCheck?.passed && checkResult?.closeCheck?.reason) {
    parts.push(checkResult.closeCheck.reason);
  }
  const detail = parts.join(' | ') || checkResult?.error || '前置检查未通过';
  return `[${exchange}] ${detail}`;
}

export default checkOrderPreconditions;
