/**
 * 全局配置加载
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenvConfig } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

dotenvConfig({ path: path.join(rootDir, '.env') });

let cached = null;

function normalizeSymbolList(list) {
  return (list || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean);
}

function resolveConfigPath(relOrAbs, fallbackRel) {
  const rel = relOrAbs || fallbackRel;
  return path.isAbsolute(rel) ? rel : path.resolve(rootDir, rel);
}

function resolveMinQtyJsonPath(config) {
  return resolveConfigPath(config?.strategy?.minQtyJson, 'config/min-order-qty.json');
}

export function loadMinOrderQtyJson(config = null) {
  const cfg = config || (cached ?? JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')));
  const minQtyPath = resolveMinQtyJsonPath(cfg);
  if (!fs.existsSync(minQtyPath)) return null;
  return JSON.parse(fs.readFileSync(minQtyPath, 'utf8'));
}

/** 可交易币种：以 min-order-qty.json 的 selectedSymbols 为准，且必须有精度条目 */
export function resolveStrategySymbols(config) {
  const minQty = loadMinOrderQtyJson(config);
  const precisionSet = new Set(
    minQty?.symbols && typeof minQty.symbols === 'object'
      ? Object.keys(minQty.symbols).map((s) => s.toUpperCase())
      : []
  );

  const candidates = normalizeSymbolList(
    minQty?.selectedSymbols
      ?? minQty?.selected_symbols
      ?? config?.strategy?.symbols
  );

  let selected = candidates;
  if (selected.length === 0 && precisionSet.size > 0) {
    selected = [...precisionSet];
  }

  if (precisionSet.size === 0) return selected;

  const resolved = selected.filter((sym) => precisionSet.has(sym));
  if (resolved.length < selected.length) {
    const dropped = selected.filter((sym) => !resolved.includes(sym));
    console.warn(`[global-config] dropped symbols missing min-order-qty entry: ${dropped.join(', ')}`);
  }
  return resolved;
}

/** 是否检查 maxPriceAgeMs / signalMaxAgeMs；未配置时 live=true、dry=false */
export function resolveEnforceLatency(strategyConfig, tradingEnabled) {
  if (strategyConfig?.enforceLatency != null) {
    return Boolean(strategyConfig.enforceLatency);
  }
  return Boolean(tradingEnabled);
}

export function loadConfig() {
  if (cached) return cached;
  const configPath = path.join(rootDir, 'config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  cached = JSON.parse(raw);
  cached.strategy.symbols = resolveStrategySymbols(cached);
  return cached;
}

export function getRootDir() {
  return rootDir;
}

export default { loadConfig, getRootDir, loadMinOrderQtyJson, resolveStrategySymbols, resolveEnforceLatency };
