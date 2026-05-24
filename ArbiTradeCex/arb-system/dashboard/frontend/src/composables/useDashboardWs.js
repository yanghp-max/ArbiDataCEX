import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

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

export function useDashboardWs() {
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

  const pnlBySymbolRows = computed(() =>
    Object.entries(pnlSummary.value.bySymbol || {})
      .map(([symbol, pnl]) => ({ symbol, pnl }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
  );

  const symbolCards = computed(() => {
    const order = Object.keys(state.progress.symbols);
    return order.map((sym) => state.symbols[sym] || { symbol: sym, status: 'waiting_quotes' });
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
        if (!msg.data) return;
        if (msg.data.summary) Object.assign(state.summary, msg.data.summary);
        Object.assign(state, msg.data);
      } catch {
        // ignore malformed payloads
      }
    };
  }

  onMounted(connect);
  onUnmounted(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  });

  return { connected, state, pnlSummary, pnlBySymbolRows, symbolCards };
}
