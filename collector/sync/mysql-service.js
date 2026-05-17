/**
 * MySQL Service（精简版，专用于 Redis Stream 同步）
 */
import mysql from 'mysql2/promise';
import config from '../config.js';

class MySQLService {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  async connect() {
    // Step 1: connect without selecting database, create DB if missing.
    const adminPool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      connectionLimit: 2,
      waitForConnections: true,
      queueLimit: 0
    });
    try {
      await adminPool.execute(
        `CREATE DATABASE IF NOT EXISTS \`${config.mysql.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
    } finally {
      await adminPool.end();
    }

    // Step 2: reconnect with target database and initialize tables.
    this.pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      connectionLimit: config.mysql.connectionLimit,
      waitForConnections: true,
      queueLimit: 0
    });

    const conn = await this.pool.getConnection();
    await conn.ping();
    conn.release();
    this.isConnected = true;
    await this.ensureTables();
    console.log(
      `[MySQLService] connected ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`
    );
  }

  async ensureTables() {
    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS price_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(32) NOT NULL,
        timestamp BIGINT NOT NULL,
        datetime DATETIME(3) NOT NULL,
        cex_a_source VARCHAR(32),
        cex_b_source VARCHAR(32),
        cex_a_bid DECIMAL(36, 18),
        cex_a_ask DECIMAL(36, 18),
        cex_b_bid DECIMAL(36, 18),
        cex_b_ask DECIMAL(36, 18),
        spread_ab DECIMAL(16, 10),
        spread_ba DECIMAL(16, 10),
        binance_funding_rate DECIMAL(20, 12),
        gate_funding_rate DECIMAL(20, 12),
        binance_server_ts DECIMAL(20, 3),
        binance_local_ts DECIMAL(20, 3),
        binance_ws_latency_ms DECIMAL(20, 3),
        gate_server_ts DECIMAL(20, 3),
        gate_local_ts DECIMAL(20, 3),
        trigger_type VARCHAR(32),
        stream_id VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_symbol_timestamp (symbol, timestamp),
        INDEX idx_timestamp (timestamp),
        INDEX idx_symbol_stream (symbol, stream_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await this.pool.execute(`
      CREATE TABLE IF NOT EXISTS sync_status (
        id INT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(32) UNIQUE NOT NULL,
        last_sync_id VARCHAR(64),
        last_sync_time TIMESTAMP NULL,
        records_synced BIGINT DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  }

  async getSyncStatus(symbol) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM sync_status WHERE symbol = ?',
      [symbol]
    );
    return rows.length ? rows[0] : null;
  }

  async updateSyncStatus(symbol, lastSyncId, recordsSynced) {
    await this.pool.execute(
      `
        INSERT INTO sync_status (symbol, last_sync_id, last_sync_time, records_synced)
        VALUES (?, ?, NOW(), ?)
        ON DUPLICATE KEY UPDATE
          last_sync_id = VALUES(last_sync_id),
          last_sync_time = NOW(),
          records_synced = records_synced + VALUES(records_synced)
      `,
      [symbol, lastSyncId, recordsSynced]
    );
  }

  async ensureSyncStatusRows(symbols) {
    if (!symbols || !symbols.length) return 0;
    const uniqueSymbols = [...new Set(symbols.map((s) => String(s).trim()).filter(Boolean))];
    if (!uniqueSymbols.length) return 0;

    const placeholders = uniqueSymbols.map(() => '(?, NULL, NULL, 0)').join(', ');
    const sql = `
      INSERT IGNORE INTO sync_status (symbol, last_sync_id, last_sync_time, records_synced)
      VALUES ${placeholders}
    `;
    const [result] = await this.pool.execute(sql, uniqueSymbols);
    return result.affectedRows || 0;
  }

  async batchInsertPrices(records) {
    if (!records.length) return 0;
    const values = records.map((r) => [
      r.symbol,
      r.timestamp ? Number(r.timestamp) : Date.now(),
      resolveDisplayDatetime(r),
      r.cex_a_source || null,
      r.cex_b_source || null,
      toNum(r.cex_a_bid),
      toNum(r.cex_a_ask),
      toNum(r.cex_b_bid),
      toNum(r.cex_b_ask),
      toNum(r.spread_ab),
      toNum(r.spread_ba),
      toNum(r.binance_funding_rate),
      toNum(r.gate_funding_rate),
      toNum(r.binance_server_ts),
      toNum(r.binance_local_ts),
      toNum(r.binance_ws_latency_ms),
      toNum(r.gate_server_ts),
      toNum(r.gate_local_ts),
      r.trigger || null,
      r.id || null
    ]);

    const sql = `
      INSERT INTO price_history (
        symbol, timestamp, datetime,
        cex_a_source, cex_b_source,
        cex_a_bid, cex_a_ask, cex_b_bid, cex_b_ask,
        spread_ab, spread_ba,
        binance_funding_rate, gate_funding_rate,
        binance_server_ts, binance_local_ts, binance_ws_latency_ms,
        gate_server_ts, gate_local_ts,
        trigger_type, stream_id
      ) VALUES ?
    `;

    const [result] = await this.pool.query(sql, [values]);
    return result.affectedRows || 0;
  }

  async disconnect() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
    this.isConnected = false;
  }
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function resolveDisplayDatetime(record) {
  // 优先使用写入 Redis 时已格式化好的北京时间字符串，避免受运行环境时区影响。
  if (typeof record?.datetime === 'string' && record.datetime.trim()) {
    return record.datetime.trim();
  }
  return toBeijingDatetimeString(Number(record?.timestamp || Date.now()));
}

function toBeijingDatetimeString(timestampMs) {
  const date = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

const mysqlService = new MySQLService();
export { mysqlService, MySQLService };
export default mysqlService;
