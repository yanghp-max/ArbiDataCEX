/**
 * Collector 配置模块（参考 ArbiData 结构）
 */
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

export const config = {
  app: {
    symbolConfig: process.env.SYMBOL_CONFIG || 'config/symbols_config.json',
    topN: parseInt(process.env.TOP_N || '52', 10),
    fundingIntervalSec: parseInt(process.env.FUNDING_INTERVAL_SEC || '15', 10),
    logLevel: process.env.LOG_LEVEL || 'info'
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || null,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    streamMaxLen: parseInt(process.env.REDIS_STREAM_MAXLEN || '200000', 10)
  },
  binance: {
    wsUrl: process.env.BINANCE_WS_URL || 'wss://fstream.binance.com/ws',
    restUrl: process.env.BINANCE_REST_URL || 'https://fapi.binance.com', // 公共行情 / exchangeInfo
    papiRestUrl: process.env.BINANCE_PAPI_REST_URL || 'https://papi.binance.com' // 统一账户：余额 / 下单 / listenKey
  },
  gate: {
    wsUrl: process.env.GATE_WS_URL || 'wss://fx-ws.gateio.ws/v4/ws/usdt',
    unifiedWsUrl: process.env.GATE_UNIFIED_WS_URL || 'wss://ws.gate.com/v4/ws/unified',
    restUrl: process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4'
  },
  writer: {
    enableLog: process.env.WRITER_ENABLE_LOG === 'true',
    enableStatsLog: process.env.WRITER_ENABLE_STATS !== 'false',
    statsInterval: parseInt(process.env.WRITER_STATS_INTERVAL || '60000', 10)
  },
  mysql: {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'arbidata',
    connectionLimit: parseInt(process.env.MYSQL_CONNECTION_LIMIT || '10', 10)
  },
  sync: {
    enabled: process.env.SYNC_ENABLED === 'true',
    intervalMs: parseInt(process.env.SYNC_INTERVAL_MS || '300000', 10),
    trimById: process.env.SYNC_TRIM_BY_ID !== 'false',
    maxAgeMs: parseInt(process.env.REDIS_MAX_AGE_MS || '3600000', 10),
    syncBeforeMs: parseInt(process.env.SYNC_BEFORE_MS || '300000', 10),
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '1000', 10),
    concurrency: parseInt(process.env.SYNC_CONCURRENCY || '5', 10)
  }
};

export function getRedisConfig(override = {}) {
  return {
    ...config.redis,
    ...override
  };
}

export default config;
