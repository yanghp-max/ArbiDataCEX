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
import { describeLatencyFail, resolveLatencyLimits, tickLatencyPass } from '../risk/risk-manager.js';
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
    this.configReloader = null;
    this._flushInterval = null;
    this._marketFlushTimer = null;
    this._marketPushThrottleMs = 200;
    this._dirtySymbols = new Set();
    this._dirtyProgress = false;
    this._dirtyLogs = false;
    this._pendingLogs = [];
    this.state = {
      startedAt: Date.now(),
      tradingEnabled: options.tradingEnabled ?? false,
      enforceLatency: this.enforceLatency,
      latencyLimits: { ...this.latencyLimits },
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
      aLatencyMs: null,
      bLatencyMs: null,
      aExchangeTimestampMs: null,
      bExchangeTimestampMs: null,
      maxWsLatencyMs: null,
      staleReason: null,
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

  setConfigReloader(fn) {
    this.configReloader = typeof fn === 'function' ? fn : null;
  }

  setManualSyncPositionHandler(fn) {
    this.manualSyncPositionHandler = typeof fn === 'function' ? fn : null;
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

  reloadConfigNow() {
    if (!this.configReloader) {
      throw new Error('config reloader not ready');
    }
    const result = this.configReloader();
    const bn = result?.strategy?.binanceSlippageBps;
    const gt = result?.strategy?.gateSlippageBps;
    this.#pushLog({
      level: 'info',
      message: `[CONFIG] 已重载 slippage bn=${bn ?? '-'} gt=${gt ?? '-'}`
    });
    this.#flushLogsUpdate();
    return result;
  }

  async syncSymbolPositionNow(symbol) {
    if (!this.manualSyncPositionHandler) {
      throw new Error('sync position handler not ready');
    }
    const normalized = String(symbol || '').replace(/[-_]/g, '').toUpperCase();
    if (!normalized) {
      throw new Error('invalid symbol');
    }
    this.#pushLog({
      level: 'info',
      symbol: normalized,
      message: `[SYNC_POSITION] ${normalized} 请求已提交`
    });
    this.#flushLogsUpdate();
    const result = await this.manualSyncPositionHandler(normalized);
    this.#pushLog({
      level: result?.ok ? 'info' : 'error',
      symbol: normalized,
      message: result?.ok
        ? `[SYNC_POSITION] ${normalized} 完成 A=${result?.aQty ?? '-'} B=${result?.bQty ?? '-'}`
        : `[SYNC_POSITION] ${normalized} 失败: ${result?.error || 'unknown'}`
    });
    this.#flushLogsUpdate();
    return result;
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
      setBaseline: () => this.setAccountBaseline(),
      reloadConfig: () => this.reloadConfigNow(),
      syncSymbolPosition: (symbol) => this.syncSymbolPositionNow(symbol)
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
    if (this._marketFlushTimer) {
      clearTimeout(this._marketFlushTimer);
      this._marketFlushTimer = null;
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

  /** 行情有更新时尽快推前端（200ms 节流），避免等 1s 定频导致 age 起步就几百 ms */
  #scheduleMarketFlush() {
    if (this._marketFlushTimer) return;
    this._marketFlushTimer = setTimeout(() => {
      this._marketFlushTimer = null;
      this.#flushMarketUpdate();
    }, this._marketPushThrottleMs);
    if (typeof this._marketFlushTimer.unref === 'function') {
      this._marketFlushTimer.unref();
    }
  }

  #applyTickTiming(sym, tick) {
    sym.aExchangeTimestampMs = tick.aExchangeTimestampMs ?? null;
    sym.bExchangeTimestampMs = tick.bExchangeTimestampMs ?? null;
    sym.aLatencyMs = tick.aLatencyMs ?? null;
    sym.bLatencyMs = tick.bLatencyMs ?? null;
    sym.maxWsLatencyMs = tick.maxWsLatencyMs ?? null;
  }

  #syncSymbolLatencyStatus(sym, tick, { windowReady = sym.windowReady } = {}) {
    if (!tick) return;
    if (!this.enforceLatency) {
      sym.staleReason = null;
      sym.status = windowReady ? 'ready' : 'collecting';
      return;
    }
    const pass = tickLatencyPass(tick, this.latencyLimits);
    sym.staleReason = pass ? null : describeLatencyFail(tick, this.latencyLimits);
    if (!pass) {
      sym.status = 'stale';
      return;
    }
    sym.status = windowReady ? 'ready' : 'collecting';
  }

  updateMarketSnapshot({ symbol, tick, spreads, signal, lock }) {
    if (!this.enabled) return;

    const sym = this.state.symbols[symbol] || this.#emptySymbol(symbol);
    if (!tick) {
      sym.status = 'waiting_quotes';
      sym.aLatencyMs = null;
      sym.bLatencyMs = null;
      sym.aExchangeTimestampMs = null;
      sym.bExchangeTimestampMs = null;
      sym.maxWsLatencyMs = null;
      sym.staleReason = null;
      sym.updatedAt = Date.now();
      this.state.symbols[symbol] = sym;
      this.#markMarketDirty(symbol);
      this.#scheduleMarketFlush();
      return;
    }

    this.#applyTickTiming(sym, tick);
    sym.windowReady = Boolean(signal?.windowReady);
    this.#syncSymbolLatencyStatus(sym, tick, { windowReady: sym.windowReady });
    if (!this.enforceLatency) {
      sym.status = sym.windowReady ? 'ready' : 'collecting';
      sym.staleReason = null;
    }
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
      this.#scheduleMarketFlush();
      return;
    }

    this.#markMarketDirty(symbol);
    this.#scheduleMarketFlush();
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
