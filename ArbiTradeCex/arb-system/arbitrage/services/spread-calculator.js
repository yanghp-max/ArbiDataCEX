/** 执行方向对应的 A/B 成交价（对齐 backtest get_open_prices / get_close_prices） */
export function legPricesForDirection(direction, tick) {
  if (direction === '-a+b') {
    return { aPrice: tick.aBid, bPrice: tick.bAsk };
  }
  return { aPrice: tick.aAsk, bPrice: tick.bBid };
}

/** 本笔交易各腿实际买卖侧（只记录成交用到的一侧） */
export function tradeLegSides(direction) {
  if (direction === '-a+b') {
    return { aSide: 'sell', bSide: 'buy' };
  }
  return { aSide: 'buy', bSide: 'sell' };
}

/** 默认与 ArbiTrade-1 CEX 腿一致：卖 ×0.9998、买 ×1.0002（各 ~2bps） */
export const DEFAULT_CEX_FEE_BPS_PER_LEG = 2;

/** 信号 spread + PnL 共用（对齐 ArbiTrade-1，仅 per-leg 手续费） */
export function resolveCexCostConfig(strategyConfig = {}) {
  const bps = Number(strategyConfig.cexFeeBpsPerLeg ?? DEFAULT_CEX_FEE_BPS_PER_LEG);
  return {
    cexFeeBpsPerLeg: Number.isFinite(bps) && bps >= 0 ? bps : DEFAULT_CEX_FEE_BPS_PER_LEG
  };
}

function cexLegMultipliers(options = {}) {
  const bps = Number(options.cexFeeBpsPerLeg ?? DEFAULT_CEX_FEE_BPS_PER_LEG);
  if (options.cexSellMult != null && options.cexBuyMult != null) {
    return { sellMult: Number(options.cexSellMult), buyMult: Number(options.cexBuyMult) };
  }
  const rate = Number.isFinite(bps) ? bps / 10000 : DEFAULT_CEX_FEE_BPS_PER_LEG / 10000;
  return { sellMult: 1 - rate, buyMult: 1 + rate };
}

/**
 * 价差计算（对齐 ArbiTrade-1 data-manager：手续费乘在每条腿价格上）
 * - spreadAb/Ba：WS 顶档 raw（展示用）
 * - spreadAbAdj/BaAdj：扣费后 spread（Z 分数 / 开平仓门槛）
 *
 * -a+b: A 卖 bid × sellMult, B 买 ask × buyMult
 * +a-b: B 卖 bid × sellMult, A 买 ask × buyMult
 */
export function calcSpreads(tick, options = {}) {
  const { sellMult, buyMult } = cexLegMultipliers(options);

  const spreadAb = ((tick.aBid - tick.bAsk) / tick.bAsk) * 100;
  const spreadBa = ((tick.bBid - tick.aAsk) / tick.aAsk) * 100;

  const aBidEff = tick.aBid * sellMult;
  const aAskEff = tick.aAsk * buyMult;
  const bBidEff = tick.bBid * sellMult;
  const bAskEff = tick.bAsk * buyMult;

  const spreadAbAdj = ((aBidEff - bAskEff) / bAskEff) * 100;
  const spreadBaAdj = ((bBidEff - aAskEff) / aAskEff) * 100;

  return {
    spreadAb,
    spreadBa,
    spreadAbAdj,
    spreadBaAdj
  };
}

/** median_ab < 0 && median_ba > 0 → A，否则 B */
export function branchForAb(medianAb, medianBa) {
  return medianAb < 0 && medianBa > 0 ? 'A' : 'B';
}

/** median_ba < 0 && median_ab > 0 → A，否则 B */
export function branchForBa(medianAb, medianBa) {
  return medianBa < 0 && medianAb > 0 ? 'A' : 'B';
}

/**
 * 与 backtest_cex_cex_open_only.py compute_z_pair 一致
 */
export function computeZPair(
  spreadAbAdj,
  spreadBaAdj,
  medianAb,
  medianBa,
  madAb,
  madBa,
  direction,
  branch
) {
  if (direction === '-a+b') {
    if (branch === 'A') {
      return {
        openZ: (spreadAbAdj + medianBa) / madBa,
        closeZ: (spreadBaAdj - medianBa) / madBa
      };
    }
    return {
      openZ: (spreadAbAdj - Math.abs(medianBa)) / madBa,
      closeZ: (spreadBaAdj - medianBa) / madBa
    };
  }
  if (branch === 'A') {
    return {
      openZ: (spreadBaAdj + medianAb) / madAb,
      closeZ: (spreadAbAdj - medianAb) / madAb
    };
  }
  return {
    openZ: (spreadBaAdj - Math.abs(medianAb)) / madAb,
    closeZ: (spreadAbAdj - medianAb) / madAb
  };
}

/** 空仓：两侧 open_z 与统一 z_open 比较，选方向 + 分支 */
export function pickOpenFromFlat(signal, zOpen) {
  const canAb = signal.openZAb != null && Number.isFinite(signal.openZAb) && signal.openZAb >= zOpen;
  const canBa = signal.openZBa != null && Number.isFinite(signal.openZBa) && signal.openZBa >= zOpen;
  if (!canAb && !canBa) return null;

  let direction;
  if (canAb && canBa) {
    direction = signal.openZAb >= signal.openZBa ? '-a+b' : '+a-b';
  } else {
    direction = canAb ? '-a+b' : '+a-b';
  }

  const branch = direction === '-a+b' ? signal.branchAb : signal.branchBa;
  const openZ = direction === '-a+b' ? signal.openZAb : signal.openZBa;
  const adjSpread = direction === '-a+b' ? signal.spreadAbAdj : signal.spreadBaAdj;
  return { direction, branch, openZ, adjSpread, action: 'open' };
}

/** 有仓：用锁定的 direction + branch 计算 open_z / close_z */
export function lockedZValues(signal, direction, branch) {
  const { medianAb, medianBa, madAb, madBa, spreadAbAdj, spreadBaAdj } = signal;
  if (!Number.isFinite(madAb) || !Number.isFinite(madBa)) {
    return { openZ: null, closeZ: null };
  }
  const mad = direction === '-a+b' ? madBa : madAb;
  if (!(mad > 0)) return { openZ: null, closeZ: null };
  return computeZPair(
    spreadAbAdj,
    spreadBaAdj,
    medianAb,
    medianBa,
    madAb,
    madBa,
    direction,
    branch
  );
}

/** 有仓：加仓 or 平仓（统一 z_open / z_close） */
export function decideAddOrClose(openZ, closeZ, zOpen, zClose) {
  const canAdd = openZ != null && Number.isFinite(openZ) && openZ >= zOpen;
  const canClose = closeZ != null && Number.isFinite(closeZ) && closeZ >= zClose;
  if (!canAdd && !canClose) return null;
  if (canAdd && canClose) {
    return openZ >= closeZ ? { action: 'add', openZ, closeZ } : { action: 'close', openZ, closeZ };
  }
  if (canAdd) return { action: 'add', openZ, closeZ };
  return { action: 'close', openZ, closeZ };
}

/** 平仓时 spread 过滤用反向交易方向 */
export function closeTradeDirection(lockedDirection) {
  return lockedDirection === '-a+b' ? '+a-b' : '-a+b';
}

export function isFlatPosition(aQty, bQty, eps = 1e-12) {
  return Math.abs(aQty) <= eps && Math.abs(bQty) <= eps;
}

/** 两腿对冲且数量对齐（失衡时禁止加仓） */
export function isHedgedPosition(aQty, bQty, eps = 1e-6) {
  if (isFlatPosition(aQty, bQty, eps)) return true;
  const dir = inferDirectionFromPosition(aQty, bQty, eps);
  if (!dir) return false;
  return Math.abs(Math.abs(aQty) - Math.abs(bQty)) <= eps;
}

export function heldQty(aQty, bQty) {
  return Math.min(Math.abs(aQty), Math.abs(bQty));
}

export function inferDirectionFromPosition(aQty, bQty, eps = 1e-12) {
  if (aQty < -eps && bQty > eps) return '-a+b';
  if (aQty > eps && bQty < -eps) return '+a-b';
  return null;
}
