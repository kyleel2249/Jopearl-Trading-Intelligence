import test from 'node:test';
import assert from 'node:assert/strict';
import { venueSymbolFromPair, parseDerivativesTicker, parseFundingRate, parseOpenInterest, annualizeFunding, computeBasis, fetchDerivativesSnapshot } from '../src/lib/bitget-derivatives.js';

const ok = (data) => ({ code: '00000', msg: 'success', data });

test('symbols map to the venue format and prefer the exact instrument id', () => {
  assert.equal(venueSymbolFromPair('BTC/USDT:USDT'), 'BTCUSDT');
  assert.equal(venueSymbolFromPair('BTC/USD:BTC', 'btcusd'), 'BTCUSD');
});

test('ticker, funding and open-interest payloads are parsed tolerantly', () => {
  assert.deepEqual(parseDerivativesTicker(ok([{ lastPrice: '100.5', markPrice: '100.4', indexPrice: '100.3', fundingRate: '0.0001', openInterest: '5000', ts: '1' }])), { last: 100.5, mark: 100.4, index: 100.3, fundingRate: 0.0001, openInterest: 5000, timestamp: 1 });
  assert.equal(parseDerivativesTicker({ code: '40000' }), null);
  assert.deepEqual(parseFundingRate(ok([{ fundingRate: '-0.0002', fundingRateInterval: '4', nextUpdate: '99' }])), { rate: -0.0002, intervalHours: 4, nextUpdate: 99 });
  assert.equal(parseOpenInterest(ok({ openInterestList: [{ symbol: 'BTCUSDT', size: '1234.5' }] })), 1234.5);
  assert.equal(parseOpenInterest(ok({ openInterestList: [] })), null);
});

test('funding annualisation and basis maths are exact', () => {
  assert.ok(Math.abs(annualizeFunding(0.0001, 8) - 0.1095) < 1e-12);
  assert.ok(Math.abs(annualizeFunding(0.0001, 4) - 0.219) < 1e-12);
  assert.equal(annualizeFunding(null), null);
  assert.deepEqual(computeBasis({ derivativePrice: 101, spotPrice: 100 }), { absolute: 1, pct: 1, annualizedPct: null, daysToExpiry: null });
  const dated = computeBasis({ derivativePrice: 102, spotPrice: 100, expiryMs: 73 * 86400000, nowMs: 0 });
  assert.ok(Math.abs(dated.annualizedPct - 10) < 1e-9);
  assert.equal(computeBasis({ derivativePrice: 1, spotPrice: 0 }), null);
});

test('a snapshot combines all sources and degrades honestly when some fail', async () => {
  const routes = {
    'tickers?category=USDT-FUTURES': ok([{ lastPrice: '101', markPrice: '100.9', indexPrice: '100.8', fundingRate: '0.0003', openInterest: '777' }]),
    'current-fund-rate': ok([{ fundingRate: '0.0001', fundingRateInterval: '8', nextUpdate: '5' }]),
    'open-interest': ok({ openInterestList: [{ size: '999' }] }),
    'tickers?category=SPOT': ok([{ lastPrice: '100' }])
  };
  const fetchImpl = async (url) => { const key = Object.keys(routes).find((k) => url.includes(k)); return { ok: true, json: async () => routes[key] }; };
  const snap = await fetchDerivativesSnapshot({ product: 'futures', pair: 'BTC/USDT:USDT', fetchImpl, now: () => 0 });
  assert.equal(snap.ok, true);
  assert.equal(snap.symbol, 'BTCUSDT');
  assert.equal(snap.funding.rate, 0.0001);
  assert.equal(snap.openInterest, 999);
  assert.equal(snap.prices.spot, 100);
  assert.ok(Math.abs(snap.basis.pct - 0.9) < 1e-9);

  const partial = await fetchDerivativesSnapshot({ product: 'usdc-futures', pair: 'ETH/USDC:USDC', now: () => 0, fetchImpl: async (url) => { if (url.includes('current-fund-rate')) throw new Error('boom'); return { ok: true, json: async () => routes[Object.keys(routes).find((k) => url.includes(k)) || 'tickers?category=SPOT'] }; } });
  assert.equal(partial.ok, true);
  assert.equal(partial.errors.funding, 'boom');
  assert.equal(partial.funding.annualizedAssumesEightHours, true, 'unknown interval is flagged, not hidden');
});

test('non-futures products and total outages are reported, never faked', async () => {
  assert.equal((await fetchDerivativesSnapshot({ product: 'spot', pair: 'BTC/USDT' })).ok, false);
  const down = await fetchDerivativesSnapshot({ product: 'futures', pair: 'BTC/USDT:USDT', fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(down.ok, false);
  assert.match(down.reason, /unreachable/);
  assert.equal(down.prices.last, null);
});
