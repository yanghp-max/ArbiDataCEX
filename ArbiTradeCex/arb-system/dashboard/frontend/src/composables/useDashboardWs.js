import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

// dashboard v5 channels — market:update / trades:update / logs:update / account:update
const DASHBOARD_MARKER = 'dashboard v5 channels';

function emptyState() {
  return {
    startedAt: Date.now(),
    tradingEnabled: false,
    enforceLatency: false,
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
    },
    account: null,
    accountBaseline: null
  };
}

function mergeSnapshot(state, data) {
  if (!data) return;
  const topKeys = [
    'startedAt', 'tradingEnabled', 'enforceLatency', 'useMockAccount',
    'account', 'accountBaseline'
  ];
  for (const key of topKeys) {
    if (data[key] !== undefined) state[key] = data[key];
  }
  if (data.progress) {
    Object.assign(state.progress, data.progress);
    if (data.progress.symbols) {
      for (const [sym, row] of Object.entries(data.progress.symbols)) {
        state.progress.symbols[sym] = row;
      }
    }
  }
  if (data.symbols) {
    for (const [sym, row] of Object.entries(data.symbols)) {
      state.symbols[sym] = row;
    }
  }
  if (data.trades) state.trades = data.trades;
  if (data.logs) state.logs = data.logs;
  if (data.summary) Object.assign(state.summary, data.summary);
}

function applyMarketPatch(state, data) {
  if (!data) return;
  if (data.symbols) {
    for (const [sym, row] of Object.entries(data.symbols)) {
      state.symbols[sym] = row;
    }
  }
  if (data.progress) {
    if (data.progress.overallPct != null) state.progress.overallPct = data.progress.overallPct;
    if (data.progress.windowSeconds != null) state.progress.windowSeconds = data.progress.windowSeconds;
    if (data.progress.minDataPoints != null) state.progress.minDataPoints = data.progress.minDataPoints;
    if (data.progress.symbols) {
      for (const [sym, row] of Object.entries(data.progress.symbols)) {
        state.progress.symbols[sym] = row;
      }
    }
  }
}

function applyTradesPatch(state, data) {
  if (!data) return;
  if (data.trade) {
    const exists = state.trades.some((t) => t.timestamp === data.trade.timestamp && t.symbol === data.trade.symbol);
    if (!exists) {
      state.trades.unshift(data.trade);
      if (state.trades.length > 100) state.trades.length = 100;
    }
  }
  if (data.summary) Object.assign(state.summary, data.summary);
}

function applyLogsPatch(state, data) {
  if (!data?.logs?.length) return;
  const known = new Set(state.logs.map((l) => l.id));
  const fresh = data.logs.filter((l) => l.id && !known.has(l.id));
  if (!fresh.length) return;
  state.logs.unshift(...fresh.reverse());
  if (state.logs.length > 200) state.logs.length = 200;
}

function applyAccountPatch(state, data) {
  if (!data) return;
  if (data.account !== undefined) state.account = data.account;
  if (data.accountBaseline !== undefined) state.accountBaseline = data.accountBaseline;
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

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        mergeSnapshot(state, msg.data);
        break;
      case 'update':
        mergeSnapshot(state, msg.data);
        break;
      case 'market:update':
        applyMarketPatch(state, msg.data);
        break;
      case 'trades:update':
        applyTradesPatch(state, msg.data);
        break;
      case 'logs:update':
        applyLogsPatch(state, msg.data);
        break;
      case 'account:update':
        applyAccountPatch(state, msg.data);
        break;
      default:
        break;
    }
  }

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
        handleWsMessage(msg);
      } catch {
        // ignore malformed payloads
      }
    };
  }

  async function postAccountApi(path) {
    const res = await fetch(path, { method: 'POST' });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json.data;
  }

  async function refreshAccount() {
    const data = await postAccountApi('/api/account/snapshot');
    if (data) state.account = data;
  }

  async function setAccountBaseline() {
    const data = await postAccountApi('/api/account/baseline');
    if (data) state.accountBaseline = data;
    if (state.account) state.account.vsBaselineUsdt = 0;
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
    refreshAccount,
    setAccountBaseline,
    DASHBOARD_MARKER
  };
}
