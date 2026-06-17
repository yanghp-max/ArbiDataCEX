/**
 * 启动时为策略币种统一设置杠杆（Binance PM + Gate USDT 永续）
 */

const SYMBOL_DELAY_MS = 120;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLeverage(leverage) {
  const lev = Math.floor(Number(leverage));
  if (!Number.isFinite(lev) || lev < 1) return null;
  return Math.min(lev, 125);
}

/**
 * @param {import('./manager.js').CexManager} cexManager
 * @param {string[]} symbols - 紧凑 symbol，如 BTWUSDT
 * @param {number} leverage
 */
export async function applyDefaultLeverage(cexManager, symbols, leverage) {
  const lev = normalizeLeverage(leverage);
  if (lev == null) return { applied: false, reason: 'invalid_leverage' };

  const leverageAdapters = [...cexManager.adapters.entries()]
    .filter(([, adapter]) => adapter?.authenticated && typeof adapter?.setSymbolLeverage === 'function');
  const list = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) return { applied: false, reason: 'no_symbols' };
  if (leverageAdapters.length === 0) {
    return { applied: false, reason: 'no_leverage_adapter' };
  }

  console.log(`[Leverage] 启动统一设置 ${lev}x，共 ${list.length} 个币种`);
  const summary = { leverage: lev, exchanges: {} };
  for (const [name] of leverageAdapters) {
    summary.exchanges[name] = { ok: 0, fail: 0 };
  }

  for (const symbol of list) {
    for (const [name, adapter] of leverageAdapters) {
      try {
        const r = await adapter.setSymbolLeverage(symbol, lev);
        summary.exchanges[name].ok += 1;
        const mode = r?.mode ? ` (${r.mode})` : '';
        console.log(`[Leverage] ${name} ${symbol} -> ${r?.leverage ?? lev}x${mode}`);
      } catch (err) {
        summary.exchanges[name].fail += 1;
        console.warn(`[Leverage] ${name} ${symbol} 失败: ${err.message}`);
      }
      await sleep(SYMBOL_DELAY_MS);
    }
  }

  const lines = Object.entries(summary.exchanges).map(
    ([name, stat]) => `${name} ${stat.ok}/${list.length} 成功`
  );
  console.log(`[Leverage] 完成 ${lines.join('，')}`);
  return { applied: true, ...summary };
}

export default { applyDefaultLeverage };
