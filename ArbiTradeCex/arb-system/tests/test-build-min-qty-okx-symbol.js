import assert from 'node:assert/strict';

function compactSymbol(symbol) {
  return String(symbol || '').replace(/[-_]/g, '').toUpperCase();
}

function okxInstIdToSymbolId(instId) {
  return String(instId || '').replace(/[-_]/g, '').replace(/SWAP$/i, '').toUpperCase();
}

function providerBSymbolKey(raw, providerB) {
  if (providerB === 'okx') return okxInstIdToSymbolId(raw);
  if (providerB === 'gate') return compactSymbol(raw);
  return String(raw);
}

assert.equal(okxInstIdToSymbolId('BTC-USDT-SWAP'), 'BTCUSDT');
assert.equal(okxInstIdToSymbolId('ETH-USDT-SWAP'), 'ETHUSDT');
assert.equal(providerBSymbolKey('BTC_USDT', 'gate'), 'BTCUSDT');
assert.equal(providerBSymbolKey('BTC-USDT-SWAP', 'okx'), 'BTCUSDT');
assert.notEqual(compactSymbol('BTC-USDT-SWAP'), 'BTCUSDT', 'old compactSymbol must not match binance id');

console.log('test-build-min-qty-okx-symbol: ok');
