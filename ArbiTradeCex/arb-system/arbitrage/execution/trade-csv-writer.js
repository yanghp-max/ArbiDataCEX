import fs from 'node:fs/promises';
import path from 'node:path';

const CSV_COLUMNS = [
  'timestamp_ms',
  'timestamp_iso',
  'symbol',
  'action',
  'direction',
  'locked_direction',
  'a_bid',
  'a_ask',
  'b_bid',
  'b_ask',
  'spread_ab_pct',
  'spread_ba_pct',
  'a_side',
  'a_price_nominal',
  'b_side',
  'b_price_nominal',
  'a_fill_price',
  'b_fill_price',
  'qty',
  'a_filled_qty',
  'b_filled_qty',
  'a_order_id',
  'b_order_id',
  'a_usdt_change',
  'b_usdt_change',
  'a_fee',
  'b_fee',
  'gross_pnl',
  'fee_cost',
  'net_pnl',
  'cum_pnl',
  'a_pos_qty',
  'b_pos_qty',
  'leg_mismatch',
  'leg_exposure',
  'failed_leg',
  'fail_reason',
  'lat_local_old_to_order_ms',
  'lat_local_new_to_order_ms',
  'lat_old_data_freshness_ms',
  'lat_new_data_freshness_ms',
  'local_span_old_to_new_ms',
  'official_span_old_to_new_ms'
];

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowToLine(row) {
  return `${CSV_COLUMNS.map((key) => csvEscape(row[key])).join(',')}\n`;
}

/** 列顺序变更时递增，用于检测旧版 CSV 表头（曾用 gross_pnl/fee_cost 紧接 b_order_id，无 leg usdt 列） */
export const TRADE_CSV_SCHEMA_VERSION = 2;

export class TradeCsvWriter {
  constructor({ filePath, rootDir }) {
    if (!filePath) throw new Error('TradeCsvWriter requires filePath');
    this.filePath = path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
    this.initialized = false;
    this.writeChain = Promise.resolve();
  }

  async appendRow(row) {
    this.writeChain = this.writeChain.then(() => this.#appendRow(row));
    return this.writeChain;
  }

  async #ensureHeader() {
    const expected = CSV_COLUMNS.join(',');
    let existingHeader = null;
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const firstLine = content.split(/\r?\n/)[0];
      if (firstLine?.trim()) existingHeader = firstLine.trim();
    } catch {
      existingHeader = null;
    }

    if (existingHeader && existingHeader !== expected) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotated = this.filePath.replace(/\.csv$/i, `.schema-v1-${stamp}.csv`);
      await fs.rename(this.filePath, rotated);
      console.warn(
        `[TradeCsvWriter] CSV 表头与当前 schema v${TRADE_CSV_SCHEMA_VERSION} 不一致，`
        + `已归档旧文件: ${rotated}`
      );
      existingHeader = null;
    }

    if (!existingHeader) {
      await fs.writeFile(this.filePath, `${expected}\n`, 'utf8');
    }
  }

  async #appendRow(row) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!this.initialized) {
      await this.#ensureHeader();
      this.initialized = true;
    }
    await fs.appendFile(this.filePath, rowToLine(row), 'utf8');
  }
}

export default TradeCsvWriter;
