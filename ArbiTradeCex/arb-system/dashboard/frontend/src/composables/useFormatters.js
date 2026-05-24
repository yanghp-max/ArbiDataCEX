export function useFormatters() {
  function fmt(v, digits = 6) {
    if (v == null || !Number.isFinite(Number(v))) return '-';
    const n = Number(v);
    if (Math.abs(n) >= 1000) return n.toFixed(2);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(digits);
  }

  function fmtPct(v) {
    if (v == null || !Number.isFinite(Number(v))) return '-';
    return `${Number(v).toFixed(4)}%`;
  }

  function spreadClass(v) {
    if (v == null || !Number.isFinite(Number(v))) return '';
    return Number(v) >= 0 ? 'pos' : 'neg';
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleString();
  }

  function formatDuration(sec) {
    if (!sec) return '0s';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function formatDetail(detail) {
    return JSON.stringify(detail, null, 2);
  }

  function statusLabel(status) {
    const map = {
      waiting_quotes: '等待行情',
      collecting: '收集中',
      ready: '信号就绪',
      stale: '行情过期'
    };
    return map[status] || status;
  }

  function pnlClass(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) return 'flat';
    return n > 0 ? 'pos' : 'neg';
  }

  function formatPnl(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '-';
    const sign = n > 0 ? '+' : '';
    return `${sign}${fmt(n, 4)}`;
  }

  return {
    fmt,
    fmtPct,
    spreadClass,
    formatTime,
    formatDuration,
    formatDetail,
    statusLabel,
    pnlClass,
    formatPnl
  };
}
