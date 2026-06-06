/**
 * 发单前 REST 订单簿快照日志（仅观测，不模拟、不拦单）
 */
import { legPricesForDirection, tradeLegSides } from '../services/spread-calculator.js';

function topLevel(levels) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const { price, size } = levels[0];
  if (!(price > 0) || !(size > 0)) return null;
  return { price, size };
}

function fmtQty(v) {
  if (!Number.isFinite(Number(v))) return '-';
  const n = Number(v);
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  return n.toFixed(4);
}

function restSpreadPct(direction, aTop, bTop) {
  if (!aTop || !bTop) return null;
  if (direction === '-a+b') {
    return bTop.price > 0 ? ((aTop.price - bTop.price) / bTop.price) * 100 : null;
  }
  return aTop.price > 0 ? ((bTop.price - aTop.price) / aTop.price) * 100 : null;
}

/** REST 顶档 vs WS 顶价，供终端对照 */
export function formatBookDiagnostics({ direction, qty, books, tick }) {
  const { aSide, bSide } = tradeLegSides(direction);
  const aLevels = aSide === 'sell' ? books.binance?.bids : books.binance?.asks;
  const bLevels = bSide === 'sell' ? books.gate?.bids : books.gate?.asks;
  const { aPrice, bPrice } = legPricesForDirection(direction, tick);
  const aTop = topLevel(aLevels);
  const bTop = topLevel(bLevels);
  const aSideCn = aSide === 'sell' ? '卖→bids' : '买→asks';
  const bSideCn = bSide === 'sell' ? '卖→bids' : '买→asks';

  const legLine = (label, sideCn, levels, top, wsQuote) => {
    if (!top) return `  ${label} ${sideCn}: REST无档位`;
    const wsGapBps = wsQuote > 0
      ? ((top.price - wsQuote) / wsQuote * 10000).toFixed(1)
      : '-';
    let l2Part = '';
    const l2 = levels?.[1];
    if (l2?.price > 0 && l2?.size > 0) {
      const gapBps = ((l2.price - top.price) / top.price * 10000).toFixed(1);
      l2Part = ` · L2=${l2.price.toFixed(6)}×${fmtQty(l2.size)} (Δ${gapBps}bps)`;
    }
    return [
      `  ${label} ${sideCn}`,
      `REST L1=${top.price.toFixed(6)}×${fmtQty(top.size)}${l2Part}`,
      `WS=${wsQuote?.toFixed(6) ?? '-'} L1-WS=${wsGapBps}bps`
    ].join(' · ');
  };

  const spreadRest = restSpreadPct(direction, aTop, bTop);
  const spreadWs = direction === '-a+b'
    ? (bPrice > 0 ? ((aPrice - bPrice) / bPrice) * 100 : null)
    : (aPrice > 0 ? ((bPrice - aPrice) / aPrice) * 100 : null);

  const lines = [
    `qty=${fmtQty(qty)} (base)`,
    legLine('A/Binance', aSideCn, aLevels, aTop, aPrice),
    legLine('B/Gate', bSideCn, bLevels, bTop, bPrice)
  ];
  if (spreadRest != null && Number.isFinite(spreadRest)) {
    lines.push(
      `  REST L1价差=${spreadRest.toFixed(4)}%`
      + (spreadWs != null && Number.isFinite(spreadWs)
        ? ` · WS顶档价差=${spreadWs.toFixed(4)}%`
        : '')
    );
  }
  return lines.join('\n');
}

export class DepthChecker {
  constructor(cfg = {}) {
    this.enabled = cfg.depthLogEnabled === true || cfg.depthCheckEnabled === true;
    this.levels = Number(cfg.depthLevels) || 5;
    this.fetchTimeoutMs = Number(cfg.depthFetchTimeoutMs) || 500;
  }

  async fetchBooks(cexManager, symbol) {
    const limit = this.levels;
    const timeout = this.fetchTimeoutMs;
    const fetchOne = (exchange) => {
      const adapter = cexManager.get(exchange);
      if (!adapter?.getOrderBook) {
        throw new Error(`${exchange} 不支持 getOrderBook`);
      }
      return adapter.getOrderBook(symbol, limit, { timeoutMs: timeout });
    };
    const [binance, gate] = await Promise.all([
      fetchOne('binance'),
      fetchOne('gate')
    ]);
    return { binance, gate };
  }

  async snapshot({
    cexManager,
    symbol,
    direction,
    qty,
    tick
  }) {
    const t0 = Date.now();
    const books = await this.fetchBooks(cexManager, symbol);
    const fetchMs = Date.now() - t0;
    const bookDebug = formatBookDiagnostics({ direction, qty, books, tick });
    return { bookDebug, fetchMs };
  }
}

export default DepthChecker;
