import fs from 'node:fs/promises';
import path from 'node:path';

const CSV_COLUMNS = [
  'timestamp_ms',
  'timestamp_iso',
  'symbol',
  'action',
  'direction',
  'locked_direction',
  'a_side',
  'a_price',
  'b_side',
  'b_price',
  'qty',
  'a_filled_qty',
  'b_filled_qty',
  'a_order_id',
  'b_order_id',
  'net_pnl',
  'cum_pnl',
  'a_pos_qty',
  'b_pos_qty',
  'leg_mismatch'
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
