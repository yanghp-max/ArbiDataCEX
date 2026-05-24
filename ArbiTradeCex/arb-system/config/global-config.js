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

function symbolIdsFromConfigArray(symbolsArr) {
  const set = new Set();
  if (!Array.isArray(symbolsArr)) return set;
  for (const item of symbolsArr) {
    const id = item?.symbol_id ?? item?.symbolId ?? item?.symbol;
    if (id) set.add(String(id).trim().toUpperCase());
  }
  return set;
}

function resolveConfigPath(relOrAbs, fallbackRel) {
  const rel = relOrAbs || fallbackRel;
  return path.isAbsolute(rel) ? rel : path.resolve(rootDir, rel);
}

function resolveMinQtyJsonPath(config) {
  return resolveConfigPath(config?.strategy?.minQtyJson, 'config/min-order-qty.json');
}

function resolveSymbolsConfigPath(config) {
  return resolveConfigPath(config?.strategy?.symbolsConfigJson, 'config/symbols_config.json');
}

export function loadMinOrderQtyJson(config = null) {
  const cfg = config || (cached ?? JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')));
  const minQtyPath = resolveMinQtyJsonPath(cfg);
  if (!fs.existsSync(minQtyPath)) return null;
  return JSON.parse(fs.readFileSync(minQtyPath, 'utf8'));
}

export function loadSymbolsConfigJson(config = null) {
  const cfg = config || (cached ?? JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8')));
  const symbolsConfigPath = resolveSymbolsConfigPath(cfg);
  if (!fs.existsSync(symbolsConfigPath)) return null;
  return JSON.parse(fs.readFileSync(symbolsConfigPath, 'utf8'));
}

export function resolveStrategySymbols(config) {
  const symbolsConfig = loadSymbolsConfigJson(config);
  const minQty = loadMinOrderQtyJson(config);

  const selected = normalizeSymbolList(
    symbolsConfig?.selected_symbols
      ?? symbolsConfig?.selectedSymbols
      ?? config.strategy?.symbols
  );

  const metaSet = symbolIdsFromConfigArray(symbolsConfig?.symbols);
  const precisionSet = new Set(
    minQty?.symbols && typeof minQty.symbols === 'object'
      ? Object.keys(minQty.symbols).map((s) => s.toUpperCase())
      : []
  );

  if (selected.length === 0) {
    return normalizeSymbolList(minQty?.selectedSymbols ?? Object.keys(minQty?.symbols ?? {}));
  }

  const filters = [];
  if (metaSet.size > 0) filters.push(metaSet);
  if (precisionSet.size > 0) filters.push(precisionSet);

  if (filters.length === 0) return selected;

  const resolved = selected.filter((sym) => filters.every((set) => set.has(sym)));
  if (resolved.length < selected.length) {
    const dropped = selected.filter((sym) => !resolved.includes(sym));
    console.warn(`[global-config] dropped symbols missing meta/precision config: ${dropped.join(', ')}`);
  }
  return resolved;
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

export default { loadConfig, getRootDir, loadMinOrderQtyJson, loadSymbolsConfigJson, resolveStrategySymbols };
