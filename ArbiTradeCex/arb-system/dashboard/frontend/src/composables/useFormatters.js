export function useFormatters() {
  function fmt(v, digits = null) {
    if (v == null || !Number.isFinite(Number(v))) return '-';
    const n = Number(v);
    if (digits != null) return n.toFixed(digits);
    if (Math.abs(n) >= 1000) return n.toFixed(2);
    if (Math.abs(n) >= 1) return n.toFixed(4);
    return n.toFixed(6);
  }

  function fmtMs(v) {
    if (v == null || !Number.isFinite(Number(v))) return '-';
    const n = Number(v);
    if (n < 1) return n.toFixed(1);
    return String(Math.round(n));
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
    if (v == null) return '待确认';
    const n = Number(v);
    if (!Number.isFinite(n)) return '待确认';
    const sign = n > 0 ? '+' : '';
    return `${sign}${fmt(n, 4)}`;
  }

  /** 顶部/日志汇总：有待确认时不显示假 0 */
  function formatTotalPnl(summary) {
    const pending = Number(summary?.pendingCount) || 0;
    const confirmed = Number(summary?.confirmedCount);
    const total = summary?.totalPnl;
    const hasConfirmed = Number.isFinite(confirmed)
      ? confirmed > 0
      : Number.isFinite(Number(total)) && pending < (Number(summary?.tradeCount) || 0);
    if (pending > 0 && !hasConfirmed) return '待确认';
    const base = formatPnl(total ?? 0);
    if (pending > 0) return `${base}（${pending}笔待确认）`;
    return base;
  }

  function totalPnlClass(summary) {
    const pending = Number(summary?.pendingCount) || 0;
    const confirmed = Number(summary?.confirmedCount);
    const hasConfirmed = Number.isFinite(confirmed)
      ? confirmed > 0
      : Number.isFinite(Number(summary?.totalPnl)) && pending < (Number(summary?.tradeCount) || 0);
    if (pending > 0 && !hasConfirmed) return 'flat';
    return pnlClass(summary?.totalPnl);
  }

  return {
    fmt,
    fmtMs,
    fmtPct,
    spreadClass,
    formatTime,
    formatDuration,
    formatDetail,
    statusLabel,
    pnlClass,
    formatPnl,
    formatTotalPnl,
    totalPnlClass
  };
}
