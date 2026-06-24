const DEFAULT_PROVIDER_A = 'binance';
const DEFAULT_PROVIDER_B = 'gate';

function normalizeProviderName(value, fallback) {
  const name = String(value || fallback || '').trim().toLowerCase();
  return name || fallback;
}

export function resolveAdapterPair(config = {}) {
  const adapters = config?.adapters || {};
  const providerA = normalizeProviderName(adapters?.A?.provider, DEFAULT_PROVIDER_A);
  const providerB = normalizeProviderName(adapters?.B?.provider, DEFAULT_PROVIDER_B);
  return {
    providerA,
    providerB,
    providers: [providerA, providerB],
    byLeg: {
      A: providerA,
      B: providerB
    }
  };
}

export function isBinanceGatePair(pair) {
  if (!pair) return false;
  return pair.providerA === 'binance' && pair.providerB === 'gate';
}

/** A 腿为 binance 时走 market worker；也可显式 ARB_CEX_MARKET_WORKER_ENABLED=1 强制启用 */
export function shouldUseBinanceMarketWorker(pair) {
  if (process.env.ARB_CEX_MARKET_WORKER_ENABLED === '1') return true;
  return pair?.providerA === 'binance';
}

export default {
  resolveAdapterPair,
  isBinanceGatePair,
  shouldUseBinanceMarketWorker
};
