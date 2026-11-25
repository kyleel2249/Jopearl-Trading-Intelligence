import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStep, overallStatus, candleFreshness, probeProduct, probeAll } from '../src/lib/bitget-health.js';
import { resolveInstrument, fetchProductCatalog, instrumentQuery } from '../src/lib/bitget-instruments.js';

const now = 1_700_000_000_000;
const healthyApi = (overrides = {}) => async (path) => {
  for (const [needle, handler] of Object.entries(overrides)) if (path.includes(needle)) return handler(path);
  const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
  if (path.includes('/markets')) return json({ markets: [{ symbol: path.includes('usdc') ? 'BTC/USDC:USDC' : 'BTC/USDT', id: path.includes('usdc') ? 'BTCPERP' : 'BTCUSDT' }], counts: { spot: 600 } });
  if (path.includes('/ticker/')) return json({ last: 100 });
  if (path.includes('/ohlcv/')) return json({ candles: [[now - 300000, 1, 2, 0, 1, 5], [now - 1000, 1, 2, 0, 1, 5]] });
  return json({}, false, 404);
};

test('step and overall classification', () => {
  assert.equal(classifyStep({ ok: true }), 'ok');
  assert.equal(classifyStep({ ok: true, slow: true }), 'degraded');
  assert.equal(classifyStep({ ok: false }), 'down');
  assert.equal(overallStatus({ a: { ok: true }, b: { ok: true } }), 'ok');
  assert.equal(overallStatus({ a: { ok: true }, b: { ok: false } }), 'degraded');
  assert.equal(overallStatus({ a: { ok: false }, b: { ok: false } }), 'down');
  assert.equal(overallStatus({}), 'unknown');
});

test('candle freshness flags data older than three bars', () => {
  assert.equal(candleFreshness(now - 1000, '5m', now).stale, false);
  assert.equal(candleFreshness(now - 4 * 300000, '5m', now).stale, true);
  assert.equal(candleFreshness(NaN, '5m', now).stale, null);
});

test('a healthy product passes catalogue, ticker and candles', async () => {
  const result = await probeProduct(healthyApi(), 'spot', { clock: () => now });
  assert.equal(result.status, 'ok');
  assert.equal(result.sample, 'BTC/USDT');
  assert.equal(result.steps.candles.count, 2);
});

test('USDC-M probes use the exact instrument id from the catalogue', async () => {
  const seen = [];
  const api = healthyApi({ '/ticker/': (path) => { seen.push(path); return { ok: true, json: async () => ({ last: 5 }) }; } });
  await probeProduct(api, 'usdc-futures', { clock: () => now });
  assert.ok(seen[0].includes('instrumentId=BTCPERP'), seen[0]);
});

test('failures are surfaced per step: empty catalogue, failing candles, stale candles', async () => {
  const empty = await probeProduct(healthyApi({ '/markets': () => ({ ok: true, json: async () => ({ markets: [] }) }) }), 'futures', { clock: () => now });
  assert.equal(empty.status, 'down'); assert.match(empty.steps.catalog.error, /empty/);
  const broken = await probeProduct(healthyApi({ '/ohlcv/': () => ({ ok: false, status: 502, json: async () => ({ error: 'upstream' }) }) }), 'futures', { clock: () => now });
  assert.equal(broken.status, 'degraded'); assert.equal(broken.steps.candles.error, 'upstream');
  const stale = await probeProduct(healthyApi({ '/ohlcv/': () => ({ ok: true, json: async () => ({ candles: [[now - 3600000, 1, 2, 0, 1, 5]] }) }) }), 'spot', { clock: () => now });
  assert.equal(stale.status, 'degraded'); assert.equal(stale.steps.candles.stale, true);
});

test('CFD is reported unavailable (not failed) outside Cloudflare mode, and probeAll summarizes', async () => {
  assert.equal((await probeProduct(healthyApi(), 'cfd', { clock: () => now })).status, 'unavailable');
  const all = await probeAll(healthyApi(), { clock: () => now });
  assert.equal(all.results.length, 6);
  assert.equal(all.total, 5);
  assert.equal(all.working, 5);
});

test('instrument lookup resolves loose pairs to exact ids and surfaces catalogue errors', async () => {
  const api = healthyApi();
  assert.deepEqual(await resolveInstrument(api, 'usdc-futures', 'BTC/USDC'), { symbol: 'BTC/USDC:USDC', id: 'BTCPERP' });
  assert.equal(await resolveInstrument(api, 'spot', 'ETH/USDT'), null);
  await assert.rejects(fetchProductCatalog(async () => ({ ok: false, json: async () => ({ error: 'nope' }) }), 'spot'), /nope/);
  assert.equal(instrumentQuery('BTCPERP'), '&instrumentId=BTCPERP');
  assert.equal(instrumentQuery(''), '');
});
