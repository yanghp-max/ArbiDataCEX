/**
 * 构建 min-order-qty 时拉取交易所元数据（Gate 带小数头）。
 */
import axios from 'axios';

const BINANCE_REST = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const GATE_REST = process.env.GATE_REST_URL || 'https://api.gateio.ws/api/v4';

export const GATE_DECIMAL_SIZE_HEADERS = { 'X-Gate-Size-Decimal': '1' };

export async function fetchGateContractsDecimal() {
  const { data } = await axios.get(`${GATE_REST}/futures/usdt/contracts`, {
    headers: GATE_DECIMAL_SIZE_HEADERS,
    timeout: 30000
  });
  return data;
}

export async function fetchGateContractDecimal(gateSymbol) {
  const contract = String(gateSymbol || '');
  const { data } = await axios.get(`${GATE_REST}/futures/usdt/contracts/${contract}`, {
    headers: GATE_DECIMAL_SIZE_HEADERS,
    timeout: 15000
  });
  return data;
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const i = index;
      index += 1;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => run()
  );
  await Promise.all(workers);
  return results;
}

export { BINANCE_REST, GATE_REST };

export default {
  GATE_DECIMAL_SIZE_HEADERS,
  fetchGateContractsDecimal,
  fetchGateContractDecimal,
  mapWithConcurrency
};
