/**
 * Dashboard 状态桥：收集 tick / 进度 / 成交，推送给 WebSocket 客户端
 */
import { getRootDir } from '../../config/global-config.js';
import { DashboardServer } from './dashboard-server.js';

export class DashboardBridge {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.port = options.port ?? 3456;
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.minDataPoints = options.minDataPoints ?? 50;
    this.symbols = options.symbols ?? [];
    this.server = null;
    this.state = {
      startedAt: Date.now(),
      tradingEnabled: options.tradingEnabled ?? false,
      useMockAccount: options.useMockAccount ?? false,
      progress: {
        overallPct: 0,
        windowSeconds: this.windowSeconds,
        minDataPoints: this.minDataPoints,
        symbols: {}
      },
      symbols: {},
      trades: [],
      logs: [],
      summary: {
        totalPnl: 0,
        tradeCount: 0
      }
    };

    for (const sym of this.symbols) {
      this.state.progress.symbols[sym] = this.#emptyProgress(sym);
      this.state.symbols[sym] = this.#emptySymbol(sym);
    }
  }

  #emptyProgress(symbol) {
    return {
      symbol,
      samples: 0,
      timeSpanMs: 0,
      timeProgressPct: 0,
      sampleProgressPct: 0,
      collectProgressPct: 0,
      windowReady: false
    };
  }

  #emptySymbol(symbol) {
    return {
      symbol,
      status: 'waiting_quotes',
      priceAgeMs: null,
      aBid: null,
      aAsk: null,
      bBid: null,
      bAsk: null,
      spreadAb: null,
      spreadBa: null,
      spreadAbAdj: null,
      spreadBaAdj: null,
      zAb: null,
      zBa: null,
      fundingA: null,
      fundingB: null,
      windowReady: false,
      updatedAt: null
    };
  }

  async start() {
    if (!this.enabled) return;
    const publicDir = `${getRootDir()}/dashboard/public`;
    this.server = new DashboardServer({ port: this.port, publicDir });
    this.server.onClientConnect = () => {
      this.server.broadcast({ type: 'snapshot', data: this.state });
    };
    await this.server.start();
    console.log(`[Dashboard] http://localhost:${this.port}`);
  }

  async stop() {
    await this.server?.stop();
  }

  #pushLog(entry) {
    this.state.logs.unshift({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry
    });
    if (this.state.logs.length > 200) this.state.logs.length = 200;
  }

  #recalcOverallProgress() {
    const rows = Object.values(this.state.progress.symbols);
    if (!rows.length) {
      this.state.progress.overallPct = 0;
      return;
    }
    const sum = rows.reduce((acc, r) => acc + (r.collectProgressPct || 0), 0);
    this.state.progress.overallPct = Math.round((sum / rows.length) * 10) / 10;
  }

  updateMarketSnapshot({ symbol, tick, spreads, signal }) {
    if (!this.enabled) return;

    const sym = this.state.symbols[symbol] || this.#emptySymbol(symbol);
    if (!tick) {
      sym.status = 'waiting_quotes';
      sym.updatedAt = Date.now();
      this.state.symbols[symbol] = sym;
      this.#broadcast();
      return;
    }

    const stale = tick.priceAgeMs > 5000;
    sym.status = stale ? 'stale' : (signal?.windowReady ? 'ready' : 'collecting');
    sym.priceAgeMs = tick.priceAgeMs;
    sym.aBid = tick.aBid;
    sym.aAsk = tick.aAsk;
    sym.bBid = tick.bBid;
    sym.bAsk = tick.bAsk;
    sym.fundingA = tick.fundingA;
    sym.fundingB = tick.fundingB;
    sym.spreadAb = spreads?.spreadAb ?? null;
    sym.spreadBa = spreads?.spreadBa ?? null;
    sym.spreadAbAdj = spreads?.spreadAbAdj ?? null;
    sym.spreadBaAdj = spreads?.spreadBaAdj ?? null;
    sym.zAb = signal?.zAb ?? null;
    sym.zBa = signal?.zBa ?? null;
    sym.windowReady = Boolean(signal?.windowReady);
    sym.updatedAt = Date.now();
    this.state.symbols[symbol] = sym;

    if (signal) {
      const prog = this.state.progress.symbols[symbol] || this.#emptyProgress(symbol);
      prog.samples = signal.samples ?? 0;
      prog.timeSpanMs = signal.timeSpanMs ?? 0;
      prog.timeProgressPct = signal.timeProgressPct ?? 0;
      prog.sampleProgressPct = signal.sampleProgressPct ?? 0;
      prog.collectProgressPct = signal.collectProgressPct ?? 0;
      prog.windowReady = Boolean(signal.windowReady);
      this.state.progress.symbols[symbol] = prog;
      this.#recalcOverallProgress();
    }

    this.#broadcast();
  }

  recordTrade(tradeRow) {
    if (!this.enabled) return;
    this.state.trades.unshift(tradeRow);
    if (this.state.trades.length > 100) this.state.trades.length = 100;
    this.state.summary.totalPnl = tradeRow.cumPnl ?? this.state.summary.totalPnl;
    this.state.summary.tradeCount += 1;
    this.#broadcast();
  }

  recordExecutionStatus(payload) {
    if (!this.enabled) return;
    if (payload.stage === 'TRADE_DONE' || payload.stage === 'FINAL_SKIP') return;
    this.#pushLog({
      level: payload.stage === 'RESERVE_FAILED' ? 'warn' : 'info',
      symbol: payload.symbol,
      message: `[${payload.stage}] ${payload.symbol}${payload.direction ? ` ${payload.direction}` : ''}`,
      detail: payload
    });
    this.#broadcast();
  }

  #broadcast() {
    this.server?.broadcast({ type: 'update', data: this.state });
  }
}

export default DashboardBridge;
