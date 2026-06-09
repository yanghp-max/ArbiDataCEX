/**
 * 共享资源（对标 shared-resources.js）
 */
import { CexManager } from '../../cex/manager.js';
import { AccountCache, ReservationManager, bindAccountStream } from '../cache/index.js';
import { OrderExecutor } from '../execution/order-executor.js';
import { ResultReporter } from '../execution/result-reporter.js';
import { TradeCsvWriter } from '../execution/trade-csv-writer.js';
import { QuoteAggregator } from '../services/quote-aggregator.js';
import { CexMarketWorkerClient } from './cex-market-worker-client.js';
import { CexPriceHub } from './cex-price-hub.js';
import eventBus from '../event-bus/index.js';
import { DashboardBridge } from '../dashboard/dashboard-bridge.js';
import { resolveEnforceLatency, getRootDir } from '../../config/global-config.js';

function isCexMarketWorkerEnabled(strat) {
  if (strat.cexMarketWorkerEnabled === false) return false;
  if (strat.binanceMarketWorkerEnabled === false) return false;
  if (process.env.ARB_CEX_MARKET_WORKER_ENABLED === '0') return false;
  if (process.env.ARB_BINANCE_MARKET_WORKER_ENABLED === '0') return false;
  return true;
}

function buildWorkerStaleMs(strat) {
  return strat.maxPriceAgeMs != null ? Math.max(900, strat.maxPriceAgeMs - 100) : 900;
}

export class SharedResources {
  constructor(config, options = {}) {
    this.config = config;
    this.tradingEnabled = options.tradingEnabled ?? false;
    this.cexManager = null;
    this.accountCache = new AccountCache();
    this.quoteAggregator = new QuoteAggregator();
    this.reservationManager = null;
    this.orderExecutor = null;
    this.resultReporter = null;
    this.tradeCsvWriter = null;
    this.eventBus = eventBus;
    this.dashboardBridge = null;
    this.inFlightCount = 0;
    this.useMockAccount = false;
    this.accountStreamBridge = null;
    this.cexMarketWorkerClient = null;
    this.cexPriceHub = null;
    this.useCexMarketWorker = false;
  }

  async init() {
    const strat = this.config.strategy;
    const dashCfg = this.config.dashboard || {};
    this.enforceLatency = resolveEnforceLatency(strat, this.tradingEnabled);
    this.dashboardBridge = new DashboardBridge({
      enabled: dashCfg.enabled !== false,
      port: dashCfg.port ?? 3456,
      broadcastIntervalMs: dashCfg.broadcastIntervalMs ?? 1000,
      windowSeconds: strat.windowSeconds,
      minDataPoints: strat.minDataPoints,
      maxPriceAgeMs: strat.maxPriceAgeMs ?? 1000,
      maxLegSkewMs: strat.maxLegSkewMs ?? 2000,
      maxWsLatencyMs: strat.maxWsLatencyMs ?? 100,
      symbols: strat.symbols,
      tradingEnabled: this.tradingEnabled,
      enforceLatency: this.enforceLatency,
      useMockAccount: Boolean(strat.useMockAccount) && !this.tradingEnabled
    });
    await this.dashboardBridge.start();
    this.eventBus.on('execution.status', (payload) => {
      this.dashboardBridge?.recordExecutionStatus(payload);
    });

    this.useCexMarketWorker = isCexMarketWorkerEnabled(strat);
    const staleMs = buildWorkerStaleMs(strat);

    if (this.useCexMarketWorker) {
      this.cexMarketWorkerClient = new CexMarketWorkerClient({
        debug: Boolean(strat.debugCexMarketWorker ?? strat.debugBinanceMarketWorker),
        configProvider: () => ({
          binance: {
            listenKeyKeepaliveMin: strat.listenKeyKeepaliveMin ?? 30,
            symbolStaleMs: staleMs
          },
          gate: {
            accountMode: strat.gateAccountMode,
            symbolStaleMs: staleMs
          }
        })
      });
      try {
        await this.cexMarketWorkerClient.initialize();
        console.log('[SharedResources] CEX market worker ready (Binance+Gate public WS in child process)');
      } catch (error) {
        console.warn(`[SharedResources] CEX market worker failed, fallback to main adapter WS: ${error.message}`);
        await this.cexMarketWorkerClient.cleanup().catch(() => {});
        this.cexMarketWorkerClient = null;
      }
    }

    const useWorker = Boolean(this.cexMarketWorkerClient);
    this.cexManager = await CexManager.createDefault(strat, {
      enablePublicStream: !useWorker
    });

    this.cexPriceHub = new CexPriceHub({
      marketWorker: this.cexMarketWorkerClient,
      binanceSource: this.cexManager.getAdapter('binance'),
      gateAdapter: this.cexManager.getAdapter('gate')
    });
    this.useMockAccount = Boolean(strat.useMockAccount) && !this.tradingEnabled;

    const defaultLeverage = Number(strat.defaultLeverage);
    if (!this.useMockAccount && defaultLeverage >= 1 && strat.symbols?.length) {
      await this.cexManager.applyDefaultLeverage(strat.symbols, defaultLeverage);
    }

    this.accountCache.minAvailableUsdt = strat.minAvailableUsdt;
    this.accountCache.accountCacheMaxAgeMs = Number(strat.accountCacheMaxAgeMs) || 5000;
    this.accountCache.setTrackedSymbols(strat.symbols);

    if (this.useMockAccount) {
      const balanceUsdt = Number(strat.mockBalanceUsdt) || 10000;
      this.accountCache.seedMock({ balanceUsdt });
      console.log(`[SharedResources] mock account: ${balanceUsdt} USDT per exchange (skip balance REST)`);
    } else {
      await this.accountCache.refreshFromCexManager(this.cexManager, { fullReplace: true });
      this.accountStreamBridge = bindAccountStream({
        cexManager: this.cexManager,
        accountCache: this.accountCache,
        symbols: strat.symbols
      });
    }
    this.reservationManager = new ReservationManager({
      accountCache: this.accountCache,
      ttlMs: this.config.strategy.reservationTtlMs
    });
    this.orderExecutor = new OrderExecutor({
      cexManager: this.cexManager,
      tradingEnabled: this.tradingEnabled,
      accountCache: this.accountCache,
      reservationManager: this.reservationManager
    });

    if (this.tradingEnabled && strat.tradeLogCsv) {
      this.tradeCsvWriter = new TradeCsvWriter({
        filePath: strat.tradeLogCsv,
        rootDir: getRootDir()
      });
      console.log(`[SharedResources] live trade CSV -> ${this.tradeCsvWriter.filePath}`);
    }
    this.resultReporter = new ResultReporter({ tradeCsvWriter: this.tradeCsvWriter });

    this.dashboardBridge.setAccountServices({
      accountCache: this.accountCache,
      cexManager: this.cexManager,
      quoteAggregator: this.quoteAggregator,
      symbols: strat.symbols
    });
    this.dashboardBridge.refreshAccountSnapshot().catch((err) => {
      console.warn('[Dashboard] initial account snapshot failed:', err.message);
    });
  }

  getAdapter(exchange) {
    return this.cexManager.getAdapter(exchange);
  }

  async shutdown() {
    await Promise.all([
      this.cexPriceHub?.stop(),
      this.cexMarketWorkerClient?.cleanup(),
      this.accountStreamBridge?.stop(),
      this.cexManager?.disconnectAll(),
      this.dashboardBridge?.stop()
    ]);
  }
}

export default SharedResources;
