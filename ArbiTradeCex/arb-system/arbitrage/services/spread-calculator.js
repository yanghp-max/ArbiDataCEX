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

/** dry-run PnL fee fallback（真实成交 fee 优先） */
export const DEFAULT_CEX_FEE_BPS_PER_LEG = 5;
/** 信号：每腿交易所手续费（0.05% = 5 bps） */
export const DEFAULT_BINANCE_FEE_BPS = 5;
export const DEFAULT_GATE_FEE_BPS = 5;
/** 信号：扣费后再扣的预估滑点 bps */
export const DEFAULT_BINANCE_SLIPPAGE_BPS = 1;
export const DEFAULT_GATE_SLIPPAGE_BPS = 1;
/** @deprecated 用 feeBps + slippageBps；仅作未配新字段时的总 bps 兼容 */
export const DEFAULT_BINANCE_BPS_PER_LEG = DEFAULT_BINANCE_FEE_BPS + DEFAULT_BINANCE_SLIPPAGE_BPS;
export const DEFAULT_GATE_BPS_PER_LEG = DEFAULT_GATE_FEE_BPS + DEFAULT_GATE_SLIPPAGE_BPS;

function clampBps(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 单所：卖 ×(1−bps/1e4)，买 ×(1+bps/1e4) */
function exchangeMults(bps) {
  const r = bps / 10000;
  return { sell: 1 - r, buy: 1 + r };
}

/**
 * 信号 spread：先扣 legA/legB fee（手续费），再扣 legA/legB slippage（预估滑点）。
 * binance/gate 旧字段与 *BpsPerLeg 仍保留为兼容 fallback。
 * cexFeeBpsPerLeg：dry-run 两腿统一 fee fallback（最低优先级）。
 */
function compactSymbol(symbol) {
  return String(symbol).replace(/[-_]/g, '').toUpperCase();
}

/** 仅全局配置，symbolOverrides 不得覆盖 */
const GLOBAL_COST_KEYS = [
  'binanceFeeBps',
  'gateFeeBps',
  'legAFeeBps',
  'legBFeeBps',
  'cexFeeBpsPerLeg',
  'binanceBpsPerLeg',
  'gateBpsPerLeg'
];

function sanitizeLegOverrides(overrides = {}) {
  const next = { ...overrides };
  if (next.legA && typeof next.legA === 'object') {
    next.legA = { ...next.legA };
    delete next.legA.feeBps;
  }
  if (next.legB && typeof next.legB === 'object') {
    next.legB = { ...next.legB };
    delete next.legB.feeBps;
  }
  return next;
}

function pickGlobalFees(strategyConfig = {}) {
  return {
    legAFeeBps: strategyConfig.legAFeeBps,
    legBFeeBps: strategyConfig.legBFeeBps,
    binanceFeeBps: strategyConfig.binanceFeeBps,
    gateFeeBps: strategyConfig.gateFeeBps,
    cexFeeBpsPerLeg: strategyConfig.cexFeeBpsPerLeg,
    binanceBpsPerLeg: strategyConfig.binanceBpsPerLeg,
    gateBpsPerLeg: strategyConfig.gateBpsPerLeg
  };
}

/** 全局 strategy + symbolOverrides[SYMBOL]；手续费类字段始终用全局 */
export function resolveSymbolStrategyConfig(strategyConfig = {}, symbol) {
  const key = compactSymbol(symbol);
  const raw = strategyConfig?.symbolOverrides?.[key] ?? {};
  const overrides = sanitizeLegOverrides(raw);
  for (const k of GLOBAL_COST_KEYS) delete overrides[k];
  return { ...strategyConfig, ...overrides, ...pickGlobalFees(strategyConfig) };
}

function resolveExchangeLegBps(strategyConfig, {
  feeKey,
  slipKey,
  legacyKey,
  defaultFee,
  defaultSlip,
  defaultLegacyTotal
}) {
  const feeExplicit = strategyConfig[feeKey] != null;
  const slipExplicit = strategyConfig[slipKey] != null;
  const legacyExplicit = strategyConfig[legacyKey] != null;

  if (feeExplicit || slipExplicit) {
    const feeBps = clampBps(strategyConfig[feeKey], defaultFee);
    const slippageBps = clampBps(strategyConfig[slipKey], defaultSlip);
    return {
      feeBps,
      slippageBps,
      totalBps: feeBps + slippageBps
    };
  }

  if (legacyExplicit) {
    const totalBps = clampBps(strategyConfig[legacyKey], defaultLegacyTotal);
    const feeBps = clampBps(strategyConfig[feeKey], defaultFee);
    return {
      feeBps,
      slippageBps: Math.max(0, totalBps - feeBps),
      totalBps
    };
  }

  const feeBps = clampBps(strategyConfig[feeKey], defaultFee);
  const slippageBps = clampBps(strategyConfig[slipKey], defaultSlip);
  return {
    feeBps,
    slippageBps,
    totalBps: feeBps + slippageBps
  };
}

export function resolveCexCostConfig(strategyConfig = {}) {
  const legAConfig = strategyConfig?.legA ?? {};
  const legBConfig = strategyConfig?.legB ?? {};

  const binance = resolveExchangeLegBps(strategyConfig, {
    feeKey: 'binanceFeeBps',
    slipKey: 'binanceSlippageBps',
    legacyKey: 'binanceBpsPerLeg',
    defaultFee: DEFAULT_BINANCE_FEE_BPS,
    defaultSlip: DEFAULT_BINANCE_SLIPPAGE_BPS,
    defaultLegacyTotal: DEFAULT_BINANCE_BPS_PER_LEG
  });
  const gate = resolveExchangeLegBps(strategyConfig, {
    feeKey: 'gateFeeBps',
    slipKey: 'gateSlippageBps',
    legacyKey: 'gateBpsPerLeg',
    defaultFee: DEFAULT_GATE_FEE_BPS,
    defaultSlip: DEFAULT_GATE_SLIPPAGE_BPS,
    defaultLegacyTotal: DEFAULT_GATE_BPS_PER_LEG
  });

  return {
    // 通用 A/B 配置（推荐）
    legAFeeBps: clampBps(
      legAConfig.feeBps ?? strategyConfig.legAFeeBps,
      binance.feeBps
    ),
    legASlippageBps: clampBps(
      legAConfig.slippageBps ?? strategyConfig.legASlippageBps,
      binance.slippageBps
    ),
    legBFeeBps: clampBps(
      legBConfig.feeBps ?? strategyConfig.legBFeeBps,
      gate.feeBps
    ),
    legBSlippageBps: clampBps(
      legBConfig.slippageBps ?? strategyConfig.legBSlippageBps,
      gate.slippageBps
    ),
    binanceFeeBps: binance.feeBps,
    binanceSlippageBps: binance.slippageBps,
    gateFeeBps: gate.feeBps,
    gateSlippageBps: gate.slippageBps,
    binanceBpsPerLeg: binance.totalBps,
    gateBpsPerLeg: gate.totalBps,
    cexFeeBpsPerLeg: clampBps(strategyConfig.cexFeeBpsPerLeg, DEFAULT_CEX_FEE_BPS_PER_LEG)
  };
}

export function resolveCexCostConfigForSymbol(strategyConfig = {}, symbol) {
  const merged = resolveSymbolStrategyConfig(strategyConfig, symbol);
  const cfg = { ...merged, ...pickGlobalFees(strategyConfig) };
  return resolveCexCostConfig(cfg);
}

/**
 * 对齐 ArbiTrade-1 data-manager（A↔dex，B↔cex）：
 *
 *   spread_ab = (A_bid×(1−bn/1e4) − B_ask×(1+gt/1e4)) / (B_ask×(1+gt/1e4)) × 100
 *   spread_ba = (B_bid×(1−gt/1e4) − A_ask×(1+bn/1e4)) / (A_ask×(1+bn/1e4)) × 100
 *
 * bn / gt = 每腿 fee + slippage 总 bps（可由 resolveCexCostConfig 提供）
 */
export function calcSpreads(tick, options = {}) {
  const legAFee = options.legAFeeBps ?? options.binanceFeeBps;
  const legASlip = options.legASlippageBps ?? options.binanceSlippageBps;
  const legBFee = options.legBFeeBps ?? options.gateFeeBps;
  const legBSlip = options.legBSlippageBps ?? options.gateSlippageBps;

  const bn = options.binanceBpsPerLeg != null
    ? clampBps(options.binanceBpsPerLeg, DEFAULT_BINANCE_BPS_PER_LEG)
    : clampBps(
      (legAFee ?? DEFAULT_BINANCE_FEE_BPS)
      + (legASlip ?? DEFAULT_BINANCE_SLIPPAGE_BPS),
      DEFAULT_BINANCE_BPS_PER_LEG
    );
  const gt = options.gateBpsPerLeg != null
    ? clampBps(options.gateBpsPerLeg, DEFAULT_GATE_BPS_PER_LEG)
    : clampBps(
      (legBFee ?? DEFAULT_GATE_FEE_BPS)
      + (legBSlip ?? DEFAULT_GATE_SLIPPAGE_BPS),
      DEFAULT_GATE_BPS_PER_LEG
    );
  const a = exchangeMults(bn);
  const b = exchangeMults(gt);

  const spreadAb = ((tick.aBid - tick.bAsk) / tick.bAsk) * 100;
  const spreadBa = ((tick.bBid - tick.aAsk) / tick.aAsk) * 100;

  const aBidEff = tick.aBid * a.sell;
  const aAskEff = tick.aAsk * a.buy;
  const bBidEff = tick.bBid * b.sell;
  const bAskEff = tick.bAsk * b.buy;

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

/** 仅一侧有仓（另一侧为 0），常见于缓存残留或单腿成交 */
export function isOneSidedOrphan(aQty, bQty, eps = 1e-6) {
  const a = Math.abs(aQty);
  const b = Math.abs(bQty);
  return (a > eps && b <= eps) || (b > eps && a <= eps);
}

/** lockedDirection 是否与当前持仓符号一致（防止 A=200 B=0 残留锁触发加仓） */
export function isPositionLockConsistent(direction, aQty, bQty, eps = 1e-6) {
  if (!direction) return false;
  if (direction === '-a+b') {
    if (aQty < -eps && bQty > eps) return true;
    if (aQty < -eps && Math.abs(bQty) <= eps) return true;
    return false;
  }
  if (direction === '+a-b') {
    if (aQty > eps && bQty < -eps) return true;
    if (aQty > eps && Math.abs(bQty) <= eps) return true;
    return false;
  }
  return false;
}

export function heldQty(aQty, bQty) {
  return Math.min(Math.abs(aQty), Math.abs(bQty));
}

export function inferDirectionFromPosition(aQty, bQty, eps = 1e-12) {
  if (aQty < -eps && bQty > eps) return '-a+b';
  if (aQty > eps && bQty < -eps) return '+a-b';
  return null;
}
