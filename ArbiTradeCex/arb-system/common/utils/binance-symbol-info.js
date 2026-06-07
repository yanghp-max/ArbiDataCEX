/**
 * Binance exchangeInfo 整包缓存可能滞后；用盘口价与 LOT/PRICE 规则交叉校验，必要时单币重拉。
 */
import axios from 'axios';

const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';

export function getBinancePriceFilter(symbolInfo) {
  return (symbolInfo?.filters || []).find((f) => f.filterType === 'PRICE_FILTER') || null;
}

export function getBinanceLotFilter(symbolInfo) {
  return (symbolInfo?.filters || []).find((f) => f.filterType === 'LOT_SIZE') || null;
}

/**
 * 整包 exchangeInfo 与实盘价明显不一致（如 LAB：价 ~13 但 stepSize=1 / minNotional=5）。
 */
export function isBinanceExchangeInfoStale(symbolInfo, refPrice) {
  const px = Number(refPrice);
  if (!Number.isFinite(px) || px <= 0 || !symbolInfo) return false;

  const pf = getBinancePriceFilter(symbolInfo);
  const lot = getBinanceLotFilter(symbolInfo);
  if (!pf || !lot) return false;

  const minPrice = Number(pf.minPrice);
  const maxPrice = Number(pf.maxPrice);
  const stepSize = Number(lot.stepSize);

  if (Number.isFinite(minPrice) && px < minPrice) return true;
  if (Number.isFinite(maxPrice) && px > maxPrice) return true;

  // 单价较高的币（>10U）若 stepSize>=1，多为整包缓存未更新
  if (px >= 10 && Number.isFinite(stepSize) && stepSize >= 1) return true;

  return false;
}

export async function fetchBinanceSymbolExchangeInfo(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const { data } = await axios.get(`${BINANCE_REST}/fapi/v1/exchangeInfo`, {
    params: { symbol: sym },
    timeout: 15000
  });
  const row = Array.isArray(data?.symbols)
    ? data.symbols.find((s) => String(s.symbol) === sym)
    : null;
  if (!row) {
    throw new Error(`Binance exchangeInfo missing symbol ${sym}`);
  }
  return row;
}

/**
 * 构建 min-qty 时使用：整包条目若滞后则单币重拉。
 */
/**
 * Binance 整包/单币 exchangeInfo 仍滞后时，按盘口价修正 LOT/MIN_NOTIONAL（如 LAB）。
 */
export function reconcileBinanceSymbolFilters(symbolInfo, refPrice) {
  if (!symbolInfo || !isBinanceExchangeInfoStale(symbolInfo, refPrice)) {
    return symbolInfo;
  }

  const px = Number(refPrice);
  const filters = (symbolInfo.filters || []).map((f) => {
    if (f.filterType === 'LOT_SIZE') {
      return { ...f, minQty: '0.001', stepSize: '0.001' };
    }
    if (f.filterType === 'MARKET_LOT_SIZE') {
      return { ...f, minQty: '0.001', stepSize: '0.001' };
    }
    if (f.filterType === 'MIN_NOTIONAL') {
      const api = Number(f.notional ?? f.minNotional);
      const notional = Number.isFinite(api) && api >= 50 ? api : 50;
      return { ...f, notional: String(notional) };
    }
    if (f.filterType === 'PRICE_FILTER' && Number.isFinite(px) && px >= 10) {
      const tickSize = px >= 100 ? '0.10' : '0.0010000';
      return {
        ...f,
        minPrice: String(Math.max(0.01, px * 0.01)),
        maxPrice: String(Math.max(px * 100, px + 1)),
        tickSize
      };
    }
    return { ...f };
  });

  return { ...symbolInfo, filters };
}

export async function resolveBinanceSymbolInfoForBuild(symbol, symbolInfo, refPrice) {
  let info = symbolInfo;
  let refreshed = false;

  if (info && isBinanceExchangeInfoStale(info, refPrice)) {
    info = await fetchBinanceSymbolExchangeInfo(symbol);
    refreshed = true;
  }
  if (info && isBinanceExchangeInfoStale(info, refPrice)) {
    info = reconcileBinanceSymbolFilters(info, refPrice);
  }

  return { symbolInfo: info, refreshed };
}

export default {
  getBinancePriceFilter,
  getBinanceLotFilter,
  isBinanceExchangeInfoStale,
  fetchBinanceSymbolExchangeInfo,
  reconcileBinanceSymbolFilters,
  resolveBinanceSymbolInfoForBuild
};
