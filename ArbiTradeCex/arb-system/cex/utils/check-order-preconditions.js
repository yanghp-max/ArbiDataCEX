/**
 * 发单前检查（对齐 ArbiTrade-1 checkOrderPreconditions）
 * - 余额：买/开空保证金按 estimatedPrice × amount × 1.01
 * - 持仓：maxPosition 上限（平仓减仓豁免）
 * - reduceOnly：校验方向与持仓量足够
 */

const BALANCE_BUFFER = 1.01;
const MARGIN_RATE_ESTIMATE = 0.10;

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

/**
 * @param {object} adapter - Binance/Gate 适配器（需 getBalance / getPositions）
 * @param {object} params
 * @param {string} params.symbol - 如 WLDUSDT
 * @param {string} params.side - buy | sell
 * @param {number} params.amount - 基础币数量（与 Binance qty / Gate 持仓口径一致）
 * @param {number} [params.maxPosition] - 最大持仓（基础币）
 * @param {number} [params.estimatedPrice] - 名义价（买用 ask，卖用 bid）
 * @param {boolean} [params.reduceOnly]
 * @param {boolean} [params.futuresMode=true]
 */
export async function checkOrderPreconditions(adapter, params = {}) {
  const {
    symbol,
    side,
    amount,
    maxPosition,
    estimatedPrice,
    reduceOnly = false,
    futuresMode = true
  } = params;

  const exchangeName = adapter?.config?.name || adapter?.id || 'CEX';
  const sideNorm = String(side || '').toLowerCase();
  const qty = Number(amount);

  const result = {
    balanceCheck: { passed: false, details: {}, reason: '' },
    positionCheck: { passed: true, details: {}, reason: 'N/A' },
    closeCheck: { passed: true, details: {}, reason: 'N/A' },
    overall: false
  };

  if (!symbol || !sideNorm || !Number.isFinite(qty) || qty <= 0) {
    result.balanceCheck.reason = '无效下单参数';
    return result;
  }

  try {
    const balances = await adapter.getBalance({ silent: true });
    const positions = await adapter.getPositions({ silent: true });

    let requiredCurrency = 'USDT';
    let requiredAmount = 0;
    const priceForCalc = Number(estimatedPrice) > 0 ? Number(estimatedPrice) : 0;

    if (sideNorm === 'buy') {
      if (!priceForCalc) {
        result.balanceCheck.reason = '买入检查缺少 estimatedPrice';
        return result;
      }
      requiredAmount = qty * priceForCalc * BALANCE_BUFFER;
    } else if (futuresMode) {
      if (!priceForCalc) {
        result.balanceCheck.reason = '卖出/开空检查缺少 estimatedPrice';
        return result;
      }
      requiredAmount = qty * priceForCalc * MARGIN_RATE_ESTIMATE;
    } else {
      const base = compactSymbol(symbol).replace(/USDT$/, '');
      requiredCurrency = base || compactSymbol(symbol);
      requiredAmount = qty;
    }

    const balance = (balances || []).find((b) => String(b.currency).toUpperCase() === requiredCurrency);
    const available = Number(balance?.available ?? 0);

    result.balanceCheck.details = { currency: requiredCurrency, available, required: requiredAmount };

    if (available < requiredAmount) {
      result.balanceCheck.reason =
        `余额不足: ${requiredCurrency} 可用=${available.toFixed(4)}, 需要=${requiredAmount.toFixed(4)}`;
      return result;
    }

    result.balanceCheck.passed = true;
    result.balanceCheck.reason = `余额充足: ${requiredCurrency} 可用=${available.toFixed(4)}, 需要=${requiredAmount.toFixed(4)}`;

    const pos = findPosition(positions, symbol);
    const currentPosition = signedPositionQty(pos);

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
