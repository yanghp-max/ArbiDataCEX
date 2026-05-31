/**
 * Dashboard 状态桥：收集 tick / 进度 / 成交，推送给 WebSocket 客户端
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from '../../config/global-config.js';
import { DashboardServer } from './dashboard-server.js';

const DASHBOARD_MARKER = 'dashboard v3';

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
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        bySymbol: {}
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
      openZAb: null,
      openZBa: null,
      closeZAb: null,
      closeZBa: null,
      branchAb: null,
      branchBa: null,
      lockedDirection: null,
      lockedBranch: null,
      fundingA: null,
      fundingB: null,
      windowReady: false,
      updatedAt: null
    };
  }

  async start() {
    if (!this.enabled) return;
    const publicDir = `${getRootDir()}/dashboard/public`;
    await this.#assertDashboardBuild(publicDir);
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

  async #assertDashboardBuild(publicDir) {
    const indexPath = path.join(publicDir, 'index.html');
    try {
      const html = await fs.readFile(indexPath, 'utf8');
      if (!html.includes('/assets/index-') || !html.includes('type="module"')) {
        throw new Error('dashboard/public is outdated; run: npm run build:dashboard');
      }
      if (!(await this.#bundleHasMarker(publicDir))) {
        console.warn('[Dashboard] stale build detected; run: npm run build:dashboard');
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('dashboard/public missing; run: npm run build:dashboard');
      }
      throw err;
    }
  }

  async #bundleHasMarker(publicDir) {
    const assetsDir = path.join(publicDir, 'assets');
    const files = await fs.readdir(assetsDir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.js')) continue;
      const text = await fs.readFile(path.join(assetsDir, file), 'utf8');
      if (text.includes(DASHBOARD_MARKER) || text.includes('pnl-banner')) return true;
    }
    return false;
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

  updateMarketSnapshot({ symbol, tick, spreads, signal, lock }) {
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
    sym.openZAb = signal?.openZAb ?? null;
    sym.openZBa = signal?.openZBa ?? null;
    sym.closeZAb = signal?.closeZAb ?? null;
    sym.closeZBa = signal?.closeZBa ?? null;
    sym.branchAb = signal?.branchAb ?? null;
    sym.branchBa = signal?.branchBa ?? null;
    sym.lockedDirection = lock?.direction ?? null;
    sym.lockedBranch = lock?.branch ?? null;
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

  recordTrade(tradeRow, summary = null) {
    if (!this.enabled) return;
    this.state.trades.unshift(tradeRow);
    if (this.state.trades.length > 100) this.state.trades.length = 100;
    if (summary) {
      this.state.summary = {
        totalPnl: summary.totalPnl ?? 0,
        tradeCount: summary.tradeCount ?? 0,
        winCount: summary.winCount ?? 0,
        lossCount: summary.lossCount ?? 0,
        bySymbol: summary.bySymbol ?? {}
      };
    } else {
      const net = tradeRow.netPnl ?? 0;
      this.state.summary.totalPnl = tradeRow.cumPnl ?? (this.state.summary.totalPnl + net);
      this.state.summary.tradeCount += 1;
      if (net >= 0) this.state.summary.winCount += 1;
      else this.state.summary.lossCount += 1;
      this.state.summary.bySymbol[tradeRow.symbol] =
        (this.state.summary.bySymbol[tradeRow.symbol] ?? 0) + net;
    }
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
