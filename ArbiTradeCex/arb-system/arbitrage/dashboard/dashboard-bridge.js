/**
 * Dashboard 状态桥：收集 tick / 进度 / 成交，推送给 WebSocket 客户端
 *
 * 推送策略（对齐 ArbiTrade-1）：
 * - 行情/进度：定频合并推送，仅含本周期变更的 symbol（market:update）
 * - 成交/账户：事件触发、小 payload 即时推送
 * - 日志：定频批量推送新增条目
 * - 新连接：全量 snapshot
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getRootDir } from '../../config/global-config.js';
import { resolveLatencyLimits, tickLatencyPass } from '../risk/risk-manager.js';
import { buildAccountSnapshot } from '../services/account-snapshot.js';
import { DashboardServer } from './dashboard-server.js';

const DASHBOARD_MARKER = 'dashboard v5 channels';

export class DashboardBridge {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.port = options.port ?? 3456;
    this.broadcastIntervalMs = Number(options.broadcastIntervalMs) > 0
      ? Number(options.broadcastIntervalMs)
      : 1000;
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.minDataPoints = options.minDataPoints ?? 50;
    this.enforceLatency = options.enforceLatency ?? options.tradingEnabled ?? false;
    this.latencyLimits = resolveLatencyLimits(
      {
        maxPriceAgeMs: options.maxPriceAgeMs,
        maxLegSkewMs: options.maxLegSkewMs,
        maxWsLatencyMs: options.maxWsLatencyMs
      },
      this.enforceLatency
    );
    this.symbols = options.symbols ?? [];
    this.server = null;
    this.accountServices = null;
    this._flushInterval = null;
    this._dirtySymbols = new Set();
    this._dirtyProgress = false;
    this._dirtyLogs = false;
    this._pendingLogs = [];
    this.state = {
      startedAt: Date.now(),
      tradingEnabled: options.tradingEnabled ?? false,
      enforceLatency: this.enforceLatency,
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
      },
      account: null,
      accountBaseline: null
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
      aAgeMs: null,
      bAgeMs: null,
      aLatencyMs: null,
      bLatencyMs: null,
      aLocalTimestamp: null,
      bLocalTimestamp: null,
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

  /** 由 SharedResources 在 init 完成后注入 */
  setAccountServices({ accountCache, cexManager, quoteAggregator, symbols }) {
    this.accountServices = { accountCache, cexManager, quoteAggregator, symbols };
  }

  async refreshAccountSnapshot() {
    if (!this.accountServices) {
      throw new Error('account services not ready');
    }
    const snap = await buildAccountSnapshot({
      ...this.accountServices,
      forceRefresh: true
    });
    this.state.account = snap;
    if (this.state.accountBaseline == null) {
      this.state.accountBaseline = {
        at: snap.at,
        totalUsdt: snap.totalUsdt,
        auto: true
      };
    }
    const baseline = this.state.accountBaseline.totalUsdt ?? 0;
    snap.vsBaselineUsdt = snap.totalUsdt - baseline;
    snap.realizedPnlUsdt = this.state.summary?.totalPnl ?? 0;
    const baselineNote = this.state.accountBaseline?.auto === false ? '较基准' : '较启动';
    this.#pushLog({
      level: 'info',
      message: `[ACCOUNT] 总 U ${snap.totalUsdt.toFixed(2)} (Binance ${snap.binance.usdt.toFixed(2)} + Gate ${snap.gate.usdt.toFixed(2)}) · ${baselineNote} ${snap.vsBaselineUsdt >= 0 ? '+' : ''}${snap.vsBaselineUsdt.toFixed(2)}`
    });
    this.#flushAccountUpdate();
    this.#flushLogsUpdate();
    return snap;
  }

  setAccountBaseline() {
    const total = this.state.account?.totalUsdt;
    if (!Number.isFinite(total)) {
      throw new Error('请先点击「刷新账户 U」');
    }
    this.state.accountBaseline = { at: Date.now(), totalUsdt: total, auto: false };
    if (this.state.account) {
      this.state.account.vsBaselineUsdt = 0;
    }
    this.#pushLog({
      level: 'info',
      message: `[ACCOUNT] 基准已设为 ${total.toFixed(2)} USDT`
    });
    this.#flushAccountUpdate();
    this.#flushLogsUpdate();
    return this.state.accountBaseline;
  }

  async start() {
    if (!this.enabled) return;
    const publicDir = `${getRootDir()}/dashboard/public`;
    await this.#assertDashboardBuild(publicDir);
    this.server = new DashboardServer({ port: this.port, publicDir });
    this.server.onClientConnect = () => {
      this.server.broadcast({ type: 'snapshot', data: this.state });
    };
    this.server.accountApi = {
      refreshSnapshot: () => this.refreshAccountSnapshot(),
      setBaseline: () => this.setAccountBaseline()
    };
    await this.server.start();
    this._flushInterval = setInterval(() => {
      this.#flushPendingUpdates();
    }, this.broadcastIntervalMs);
    if (typeof this._flushInterval.unref === 'function') {
      this._flushInterval.unref();
    }
    console.log(
      `[Dashboard] http://localhost:${this.port}`
      + ` · push interval ${this.broadcastIntervalMs}ms (market/logs channels)`
    );
  }

  async stop() {
    if (this._flushInterval) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
    }
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
      if (text.includes(DASHBOARD_MARKER) || text.includes('market:update')) return true;
    }
    return false;
  }

  #pushLog(entry) {
    const row = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      ...entry
    };
    this.state.logs.unshift(row);
    if (this.state.logs.length > 200) this.state.logs.length = 200;
    this._pendingLogs.push(row);
    if (this._pendingLogs.length > 50) {
      this._pendingLogs.splice(0, this._pendingLogs.length - 50);
    }
    this._dirtyLogs = true;
    return row;
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

  #markMarketDirty(symbol, { progress = false } = {}) {
    this._dirtySymbols.add(symbol);
    if (progress) this._dirtyProgress = true;
  }

  #clearMarketDirty() {
    this._dirtySymbols.clear();
    this._dirtyProgress = false;
  }

  updateMarketSnapshot({ symbol, tick, spreads, signal, lock }) {
    if (!this.enabled) return;

    const sym = this.state.symbols[symbol] || this.#emptySymbol(symbol);
    if (!tick) {
      sym.status = 'waiting_quotes';
      sym.priceAgeMs = null;
      sym.aAgeMs = null;
      sym.bAgeMs = null;
      sym.aLatencyMs = null;
      sym.bLatencyMs = null;
      sym.aLocalTimestamp = null;
      sym.bLocalTimestamp = null;
      sym.updatedAt = Date.now();
      this.state.symbols[symbol] = sym;
      this.#markMarketDirty(symbol);
      return;
    }

    const stale = this.enforceLatency && !tickLatencyPass(tick, this.latencyLimits);
    sym.status = stale ? 'stale' : (signal?.windowReady ? 'ready' : 'collecting');
    // 价格/价差随 onTick 更新；leg age / lat 仅由 refreshMarketTiming 定频写入，避免 any-leg 触发腿恒为 0
    sym.aLocalTimestamp = tick.aLocalTimestamp ?? null;
    sym.bLocalTimestamp = tick.bLocalTimestamp ?? null;
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
      this.#markMarketDirty(symbol, { progress: true });
      return;
    }

    this.#markMarketDirty(symbol);
  }

  /** 定频刷新 leg/lat/priceAge，避免 any-leg 来价时仅触发腿显示 0ms */
  refreshMarketTiming({ symbol, tick }) {
    if (!this.enabled || !tick) return;
    const sym = this.state.symbols[symbol];
    if (!sym || sym.aBid == null) return;

    sym.priceAgeMs = tick.priceAgeMs;
    sym.aAgeMs = tick.aAgeMs ?? null;
    sym.bAgeMs = tick.bAgeMs ?? null;
    sym.aLatencyMs = tick.aLatencyMs ?? null;
    sym.bLatencyMs = tick.bLatencyMs ?? null;
    sym.aLocalTimestamp = tick.aLocalTimestamp ?? null;
    sym.bLocalTimestamp = tick.bLocalTimestamp ?? null;

    if (this.enforceLatency) {
      const stale = !tickLatencyPass(tick, this.latencyLimits);
      if (sym.windowReady) {
        sym.status = stale ? 'stale' : 'ready';
      } else if (sym.status !== 'waiting_quotes') {
        sym.status = stale ? 'stale' : 'collecting';
      }
    }
    sym.updatedAt = Date.now();
    this.#markMarketDirty(symbol);
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
    } else if (tradeRow.pnlComplete !== false && tradeRow.netPnl != null && Number.isFinite(tradeRow.netPnl)) {
      const net = tradeRow.netPnl;
      this.state.summary.totalPnl = tradeRow.cumPnl ?? (this.state.summary.totalPnl + net);
      this.state.summary.tradeCount += 1;
      if (net >= 0) this.state.summary.winCount += 1;
      else this.state.summary.lossCount += 1;
      this.state.summary.bySymbol[tradeRow.symbol] =
        (this.state.summary.bySymbol[tradeRow.symbol] ?? 0) + net;
    } else {
      this.state.summary.tradeCount += 1;
    }
    this.#flushTradesUpdate(tradeRow);
  }

  recordExecutionStatus(payload) {
    if (!this.enabled) return;
    const silentStages = new Set([
      'TRADE_DONE',
      'FINAL_SKIP',
      'MIN_QTY_SKIP',
      'SIGNAL_STALE',
      'RESERVE_FAILED',
      'PRICE_STALE'
    ]);
    if (silentStages.has(payload.stage)) return;
    const level = ['RESERVE_FAILED', 'SIGNAL_STALE', 'ZERO_FILL'].includes(payload.stage)
      ? 'warn'
      : ['LEG_EXPOSURE', 'LEG_MISMATCH', 'EXEC_FAILED'].includes(payload.stage)
        ? 'error'
        : 'info';
    this.#pushLog({
      level,
      symbol: payload.symbol,
      message: `[${payload.stage}] ${payload.symbol}${payload.direction ? ` ${payload.direction}` : ''}${payload.detail ? `: ${payload.detail}` : ''}`,
      detail: payload
    });
  }

  #flushPendingUpdates() {
    if (!this.server?.hasClients?.()) {
      this.#clearMarketDirty();
      this._dirtyLogs = false;
      this._pendingLogs.length = 0;
      return;
    }
    this.#flushMarketUpdate();
    this.#flushLogsUpdate();
  }

  #flushMarketUpdate() {
    if (this._dirtySymbols.size === 0 && !this._dirtyProgress) return;

    const data = {};
    if (this._dirtySymbols.size > 0) {
      data.symbols = {};
      for (const sym of this._dirtySymbols) {
        if (this.state.symbols[sym]) {
          data.symbols[sym] = this.state.symbols[sym];
        }
      }
    }
    if (this._dirtyProgress) {
      data.progress = {
        overallPct: this.state.progress.overallPct,
        windowSeconds: this.state.progress.windowSeconds,
        minDataPoints: this.state.progress.minDataPoints,
        symbols: {}
      };
      for (const sym of this._dirtySymbols) {
        if (this.state.progress.symbols[sym]) {
          data.progress.symbols[sym] = this.state.progress.symbols[sym];
        }
      }
    }

    if (data.symbols || data.progress) {
      this.server.broadcast({ type: 'market:update', data });
    }
    this.#clearMarketDirty();
  }

  #flushLogsUpdate() {
    if (!this._dirtyLogs || this._pendingLogs.length === 0) return;
    if (!this.server?.hasClients?.()) {
      this._dirtyLogs = false;
      this._pendingLogs.length = 0;
      return;
    }
    this.server.broadcast({
      type: 'logs:update',
      data: { logs: [...this._pendingLogs] }
    });
    this._pendingLogs.length = 0;
    this._dirtyLogs = false;
  }

  #flushTradesUpdate(tradeRow) {
    if (!this.server?.hasClients?.()) return;
    this.server.broadcast({
      type: 'trades:update',
      data: {
        trade: tradeRow,
        summary: this.state.summary
      }
    });
  }

  #flushAccountUpdate() {
    if (!this.server?.hasClients?.()) return;
    this.server.broadcast({
      type: 'account:update',
      data: {
        account: this.state.account,
        accountBaseline: this.state.accountBaseline
      }
    });
  }
}

export default DashboardBridge;
