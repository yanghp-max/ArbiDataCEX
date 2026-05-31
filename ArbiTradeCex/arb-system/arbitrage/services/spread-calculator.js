export function calcSpreads(tick, totalCostPct) {
  const spreadAb = ((tick.aBid - tick.bAsk) / tick.bAsk) * 100;
  const spreadBa = ((tick.bBid - tick.aAsk) / tick.aAsk) * 100;
  return {
    spreadAb,
    spreadBa,
    spreadAbAdj: spreadAb - totalCostPct,
    spreadBaAdj: spreadBa - totalCostPct
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

export function heldQty(aQty, bQty) {
  return Math.min(Math.abs(aQty), Math.abs(bQty));
}

export function inferDirectionFromPosition(aQty, bQty, eps = 1e-12) {
  if (aQty < -eps && bQty > eps) return '-a+b';
  if (aQty > eps && bQty < -eps) return '+a-b';
  return null;
}
