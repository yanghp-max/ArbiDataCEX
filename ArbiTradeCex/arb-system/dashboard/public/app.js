const { createApp, computed, onMounted, onUnmounted, reactive, ref } = Vue;

function emptyState() {
  return {
    startedAt: Date.now(),
    tradingEnabled: false,
    useMockAccount: false,
    progress: {
      overallPct: 0,
      windowSeconds: 3600,
      minDataPoints: 50,
      symbols: {}
    },
    symbols: {},
    trades: [],
    logs: [],
    summary: {
      totalPnl: 0,
      tradeCount: 0,
      winCount: 0,
      lossCount: 0,
      bySymbol: {}
    }
  };
}

createApp({
  setup() {
    const connected = ref(false);
    const state = reactive(emptyState());
    let ws = null;
    let reconnectTimer = null;

    const pnlSummary = computed(() => {
      const s = state.summary || {};
      if (Number.isFinite(Number(s.totalPnl))) {
        return {
          totalPnl: Number(s.totalPnl),
          tradeCount: s.tradeCount ?? 0,
          winCount: s.winCount ?? 0,
          lossCount: s.lossCount ?? 0,
          bySymbol: s.bySymbol ?? {}
        };
      }
      const trades = state.trades || [];
      let totalPnl = 0;
      let winCount = 0;
      let lossCount = 0;
      const bySymbol = {};
      for (const t of trades) {
        const net = Number(t.netPnl) || 0;
        totalPnl += net;
        if (net >= 0) winCount += 1;
        else lossCount += 1;
        bySymbol[t.symbol] = (bySymbol[t.symbol] ?? 0) + net;
      }
      return { totalPnl, tradeCount: trades.length, winCount, lossCount, bySymbol };
    });

    const pnlBySymbolRows = computed(() => {
      const entries = Object.entries(pnlSummary.value.bySymbol || {});
      return entries
        .map(([symbol, pnl]) => ({ symbol, pnl }))
        .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
    });

    const symbolCards = computed(() => {
      const order = Object.keys(state.progress.symbols);
      return order.map((sym) => state.symbols[sym] || { symbol: sym, status: 'waiting_quotes' });
    });

    const combinedLogs = computed(() => {
      const tradeLogs = (state.trades || []).map((t) => ({
        id: `trade_${t.timestamp}_${t.symbol}`,
        timestamp: t.timestamp,
        level: 'trade',
        symbol: t.symbol,
        message: `${t.symbol} ${t.direction} · qty ${t.qty} · pnl ${fmt(t.netPnl, 4)} USDT${t.simulated ? ' (sim)' : ''}`,
        detail: t
      }));
      const others = (state.logs || []).filter((log) => !String(log.message || '').includes('[FINAL_SKIP]'));
      return [...tradeLogs, ...others]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 100);
    });

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}`);

      ws.onopen = () => {
        connected.value = true;
      };

      ws.onclose = () => {
        connected.value = false;
        reconnectTimer = setTimeout(connect, 2000);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.data) Object.assign(state, msg.data);
        } catch {
          // ignore
        }
      };
    }

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

    onMounted(connect);
    onUnmounted(() => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    });

    return {
      connected,
      state,
      pnlSummary,
      pnlBySymbolRows,
      symbolCards,
      combinedLogs,
      fmt,
      fmtPct,
      spreadClass,
      pnlClass,
      formatPnl,
      formatTime,
      formatDuration,
      formatDetail,
      statusLabel
    };
  }
}).mount('#app');
