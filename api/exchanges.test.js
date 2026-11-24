import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarket, isMarketCacheStale } from './exchanges.js';

test('market catalogue freshness uses a bounded TTL', () => {
  assert.equal(isMarketCacheStale(0, 1000, 300000), true);
  assert.equal(isMarketCacheStale(1000, 299999, 300000), false);
  assert.equal(isMarketCacheStale(1000, 301000, 300000), true);
});

test('market catalogue refresh treats missing timestamps as stale', () => {
  assert.equal(isMarketCacheStale(undefined, 1000, 300000), true);
  assert.equal(isMarketCacheStale(Number.NaN, 1000, 300000), true);
});

test('market classification preserves spot and derivatives categories', () => {
  assert.deepEqual(classifyMarket({ type: 'spot', spot: true }).categories, ['spot']);
  assert.deepEqual(classifyMarket({ type: 'swap', swap: true, contract: true, linear: true }).categories, ['perpetual']);
  assert.deepEqual(classifyMarket({ type: 'future', future: true, contract: true, inverse: true }).categories, ['futures']);
  assert.deepEqual(classifyMarket({ type: 'option', option: true }).categories, ['options']);
});

test('market classification retains margin and CFD metadata', () => {
  assert.deepEqual(classifyMarket({ type: 'spot', spot: true, margin: true }).categories, ['spot', 'margin']);
  assert.deepEqual(classifyMarket({ type: 'cfd', cfd: true }).categories, ['cfd']);
});

test('matchesProductType keeps legacy filters and adds Coin-M and USDC-M products', async () => {
  const { matchesProductType } = await import('./exchanges.js');
  const spot = { type: 'spot', spot: true };
  const usdtPerp = { type: 'swap', swap: true, contract: true, linear: true, settle: 'USDT' };
  const usdcPerp = { type: 'swap', swap: true, contract: true, linear: true, settle: 'USDC' };
  const coinPerp = { type: 'swap', swap: true, contract: true, inverse: true, settle: 'BTC' };
  const coinFuture = { type: 'future', future: true, contract: true, inverse: true, settle: 'ETH' };
  assert.equal(matchesProductType(spot, 'all'), true);
  assert.equal(matchesProductType(spot, 'spot'), true);
  assert.equal(matchesProductType(spot, 'futures'), false);
  assert.equal(matchesProductType(usdtPerp, 'futures'), true, 'futures still includes perpetuals');
  assert.equal(matchesProductType(usdtPerp, 'usdc-futures'), false);
  assert.equal(matchesProductType(usdcPerp, 'usdc-futures'), true);
  assert.equal(matchesProductType(usdcPerp, 'coin-futures'), false);
  assert.equal(matchesProductType(coinPerp, 'coin-futures'), true);
  assert.equal(matchesProductType(coinFuture, 'coin-futures'), true);
  assert.equal(matchesProductType(spot, 'coin-futures'), false);
  assert.equal(matchesProductType({ ...usdcPerp, categories: ['perpetual'] }, 'usdc-futures'), true, 'accepts the already-mapped catalogue shape');
});
