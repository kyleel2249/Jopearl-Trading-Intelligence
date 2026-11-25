import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchIndex, searchMarkets, parseQuery, resolveSymbol } from '../src/lib/bitget-search.js';

const index = buildSearchIndex({
  spot: [{ symbol: 'BTC/USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT' }, { symbol: 'BTC/USDC', base: 'BTC', quote: 'USDC' }, { symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT' }],
  futures: [{ symbol: 'BTC/USDT:USDT', id: 'BTCUSDT', base: 'BTC', quote: 'USDT' }, { symbol: 'ETH/USDT:USDT', base: 'ETH', quote: 'USDT' }],
  'coin-futures': [{ symbol: 'BTC/USD:BTC', id: 'BTCUSD', base: 'BTC', quote: 'USD' }],
  cfd: [{ symbol: 'XAUUSD', base: 'XAU', quote: 'USD' }]
});

test('an exact pair ranks first and futures outrank spot on a tie', () => {
  const results = searchMarkets(index, 'btc/usdt');
  assert.equal(results[0].symbol, 'BTC/USDT:USDT');
  assert.equal(results[0].product, 'futures');
  assert.ok(results.some((r) => r.product === 'spot' && r.symbol === 'BTC/USDT'));
});

test('loose spellings of the same pair match (BTCUSDT, btc-usdt, BTC USDT)', () => {
  for (const q of ['BTCUSDT', 'btc-usdt', 'btc_usdt']) assert.ok(searchMarkets(index, q).some((r) => r.symbol === 'BTC/USDT'), q);
});

test('product words narrow the search to that product', () => {
  assert.deepEqual([...new Set(searchMarkets(index, 'btc spot').map((r) => r.product))], ['spot']);
  assert.deepEqual([...new Set(searchMarkets(index, 'btc coin').map((r) => r.product))], ['coin-futures']);
  assert.deepEqual(searchMarkets(index, 'xau cfd').map((r) => r.symbol), ['XAUUSD']);
});

test('a lone product word is searched as text, not treated as a filter', () => {
  assert.deepEqual(parseQuery('usdt'), { text: 'USDT', products: [] });
  assert.deepEqual(parseQuery('btc perp'), { text: 'BTC', products: ['futures'] });
});

test('prefix on the base asset matches and empty queries return nothing', () => {
  assert.ok(searchMarkets(index, 'et').every((r) => r.base === 'ETH'));
  assert.deepEqual(searchMarkets(index, ''), []);
  assert.deepEqual(searchMarkets(index, 'zzzz'), []);
});

test('limit is honoured and resolveSymbol maps a loose pair to the listed symbol', () => {
  assert.equal(searchMarkets(index, 'btc', { limit: 2 }).length, 2);
  assert.equal(resolveSymbol(index, 'futures', 'BTC/USDT'), 'BTC/USDT:USDT');
  assert.equal(resolveSymbol(index, 'spot', 'BTC/USDT'), 'BTC/USDT');
  assert.equal(resolveSymbol(index, 'margin', 'BTC/USDT'), null);
});

test('malformed catalog rows are ignored instead of throwing', () => {
  assert.deepEqual(buildSearchIndex({ spot: [null, {}, { symbol: '' }], futures: 'nope' }), []);
});
