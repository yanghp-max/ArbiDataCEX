/**
 * Redis 客户端封装（参考 ArbiData 结构）
 */
import redis from 'redis';
import { getRedisConfig } from '../config.js';

export class RedisClient {
  constructor(config = {}) {
    const baseConfig = getRedisConfig(config);
    this.config = {
      ...baseConfig,
      retryStrategy: config.retryStrategy || this.defaultRetryStrategy.bind(this),
      ...config
    };

    this.client = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.stats = {
      writes: 0,
      errors: 0,
      reconnects: 0,
      lastWriteTime: null
    };
  }

  async connect() {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;

    this.client = redis.createClient({
      socket: {
        host: this.config.host,
        port: this.config.port,
        reconnectStrategy: this.config.retryStrategy
      },
      password: this.config.password,
      database: this.config.db
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      this.isConnecting = false;
      console.log(`[RedisClient] connected ${this.config.host}:${this.config.port}`);
    });
    this.client.on('reconnecting', () => {
      this.stats.reconnects++;
      this.isConnected = false;
    });
    this.client.on('error', (error) => {
      this.stats.errors++;
      console.error('[RedisClient] error:', error.message);
    });
    this.client.on('end', () => {
      this.isConnected = false;
      this.isConnecting = false;
    });

    await this.client.connect();
  }

  async xadd(key, fields, options = {}) {
    if (!this.isConnected) throw new Error('Redis未连接');
    const xAddOptions = {};
    if (options.maxLen) {
      xAddOptions.TRIM = {
        strategy: 'MAXLEN',
        strategyModifier: options.approximate !== false ? '~' : '=',
        threshold: options.maxLen
      };
    }
    const id = await this.client.xAdd(key, '*', fields, xAddOptions);
    this.stats.writes++;
    this.stats.lastWriteTime = Date.now();
    return id;
  }

  isReady() {
    return this.isConnected && this.client !== null;
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
    }
  }

  defaultRetryStrategy(retries) {
    if (retries > 20) return new Error('重连次数超限');
    return Math.min(retries * 100, 2000);
  }
}

export default RedisClient;
