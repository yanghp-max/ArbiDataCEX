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
  'lat_ws_a_ms',
  'lat_ws_b_ms',
  'lat_ws_max_ms',
  'lat_price_age_ms',
  'lat_leg_skew_ms',
  'lat_decision_ms',
  'lat_order_build_ms',
  'lat_pre_order_ms',
  'lat_account_fresh_ms',
  'lat_reserve_ms',
  'lat_async_queue_ms',
  'lat_recheck_ms',
  'lat_depth_fetch_ms',
  'lat_order_place_binance_ms',
  'lat_order_place_gate_ms',
  'lat_order_place_max_ms',
  'lat_order_poll_binance_ms',
  'lat_order_poll_gate_ms',
  'lat_pos_refresh_ms',
  'lat_total_ms'
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

  async #appendRow(row) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (!this.initialized) {
      try {
        await fs.access(this.filePath);
      } catch {
        await fs.writeFile(this.filePath, `${CSV_COLUMNS.join(',')}\n`, 'utf8');
      }
      this.initialized = true;
    }
    await fs.appendFile(this.filePath, rowToLine(row), 'utf8');
  }
}

export default TradeCsvWriter;
