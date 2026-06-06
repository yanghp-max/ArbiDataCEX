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

  const binance = cexManager.get('binance');
  const gate = cexManager.get('gate');
  const list = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  if (list.length === 0) return { applied: false, reason: 'no_symbols' };

  console.log(`[Leverage] 启动统一设置 ${lev}x，共 ${list.length} 个币种`);
  const summary = { leverage: lev, binance: { ok: 0, fail: 0 }, gate: { ok: 0, fail: 0 } };

  for (const symbol of list) {
    if (binance?.authenticated && typeof binance.setSymbolLeverage === 'function') {
      try {
        const r = await binance.setSymbolLeverage(symbol, lev);
        summary.binance.ok += 1;
        console.log(`[Leverage] Binance ${symbol} -> ${r?.leverage ?? lev}x`);
      } catch (err) {
        summary.binance.fail += 1;
        console.warn(`[Leverage] Binance ${symbol} 失败: ${err.message}`);
      }
      await sleep(SYMBOL_DELAY_MS);
    }

    if (gate?.authenticated && typeof gate.setSymbolLeverage === 'function') {
      try {
        const r = await gate.setSymbolLeverage(symbol, lev);
        summary.gate.ok += 1;
        const mode = r?.mode ? ` (${r.mode})` : '';
        console.log(`[Leverage] Gate ${symbol} -> ${r?.leverage ?? lev}x${mode}`);
      } catch (err) {
        summary.gate.fail += 1;
        console.warn(`[Leverage] Gate ${symbol} 失败: ${err.message}`);
      }
      await sleep(SYMBOL_DELAY_MS);
    }
  }

  console.log(
    `[Leverage] 完成 Binance ${summary.binance.ok}/${list.length} 成功`
    + `，Gate ${summary.gate.ok}/${list.length} 成功`
  );
  return { applied: true, ...summary };
}

export default { applyDefaultLeverage };
