import test from 'node:test';
import assert from 'node:assert/strict';
import { higherTimeframe, htfLevels, summarizeBook, bucketDepth, summarizeDerivatives, fundingLabel } from './chart-market.js';
import { subscribeCrosshair, publishCrosshair, shouldMirror } from './chart-sync.js';
import { streamPlan, decodeStreamMessage, venueMarketId, streamIsFresh, backoffMs } from './chart-stream.js';

const H = 3_600_000, T = Date.UTC(2026, 10, 24, 8, 0, 0);

test('higher timeframe ladder and level extraction', () => {
  assert.equal(higherTimeframe('15m'), '1h');
  assert.equal(higherTimeframe('1w'), '1M');
  assert.equal(higherTimeframe('1M'), null);
  const c = [[T - 2 * H, 10, 12, 9, 11, 1], [T - H, 11, 14, 10, 13, 1], [T, 13, 15, 12, 14, 1]];
  const live = htfLevels(c, '1h', T + 20 * 60_000);
  assert.equal(live.forming, true);
  assert.deepEqual(live.levels.map((l) => [l.id, l.price]), [['fO', 13], ['pH', 14], ['pL', 10], ['pC', 13]]);
  const closed = htfLevels(c, '1h', T + 2 * H);
  assert.equal(closed.forming, false);
  assert.deepEqual(closed.levels.map((l) => l.id), ['pH', 'pL', 'pC']);
  assert.deepEqual(closed.levels.map((l) => l.price), [15, 12, 14]);
  assert.equal(htfLevels([c[0]], '1h', T), null);
  assert.equal(htfLevels([[1, 'x', 1, 1, 1]], '1h'), null);
});

test('order book summary: spread, pips, imbalance and crossed detection', () => {
  const b = summarizeBook({ bids: [[99.5, 2], [99, 1], ['bad', 1]], asks: [[100.5, 1], [101, 4]] }, { pip: 0.5 });
  assert.deepEqual([b.bestBid, b.bestAsk, b.mid, b.spread, b.spreadPips, b.crossed], [99.5, 100.5, 100, 1, 2, false]);
  assert.ok(Math.abs(b.bidDepth - (99.5 * 2 + 99)) < 1e-9);
  assert.ok(b.imbalance < 0, 'ask side is deeper');
  assert.equal(summarizeBook({ bids: [], asks: [[1, 1]] }), null);
  assert.equal(summarizeBook(null), null);
  assert.equal(summarizeBook({ bids: [[101, 1]], asks: [[100, 1]] }).crossed, true);
});

test('depth buckets conserve in-range notional and clip the rest', () => {
  const { buckets, max } = bucketDepth([[100, 1], [101, 2], [109, 1], [200, 5], [1, 5]], { lo: 100, hi: 110, bins: 5 });
  assert.equal(buckets.length, 5);
  assert.ok(Math.abs(buckets.reduce((s, x) => s + x.notional, 0) - (100 + 202 + 109)) < 1e-9);
  assert.equal(max, buckets[0].notional);
  assert.deepEqual(bucketDepth([], { lo: 5, hi: 5, bins: 3 }), { buckets: [], max: 0 });
});

test('derivatives summary only reports what the venue supplied', () => {
  const now = 1_000_000;
  const d = summarizeDerivatives({ funding: { fundingRate: 0.0001, markPrice: 101, indexPrice: 100, nextFundingTimestamp: now + 3600_000 }, openInterest: { openInterestAmount: 5, openInterestValue: 500 }, ticker: { unavailable: 'x' }, liquidationClusters: { status: 'unavailable' } }, now);
  assert.deepEqual([d.fundingPct, d.fundingInMs, d.markPrice, d.basis, d.openInterest, d.openInterestValue, d.liquidationStatus], [0.01, 3600_000, 101, 1, 5, 500, 'unavailable']);
  assert.equal(fundingLabel(0.01), '+0.0100%');
  assert.equal(fundingLabel(null), '—');
  assert.equal(summarizeDerivatives({ funding: { unavailable: 'no' }, openInterest: { unavailable: 'no' } }), null);
  assert.equal(summarizeDerivatives(null), null);
  const liq = summarizeDerivatives({ funding: { unavailable: 'x' }, liquidations: [{ timestamp: 5, price: 100, side: 'sell', baseValue: 2 }, { timestamp: null, price: 1 }] }, now);
  assert.deepEqual(liq.liquidations, [{ ts: 5, price: 100, side: 'long-liquidated', value: 200 }]);
  assert.equal(liq.liquidationStatus, 'reported');
});

test('crosshair link mirrors only other charts of the same market', () => {
  const seen = [];
  const off = subscribeCrosshair((e) => seen.push(e));
  publishCrosshair({ source: 'a', symbol: 'BTC/USDT', marketType: 'spot', ts: 5, price: 1 });
  publishCrosshair({ nope: true });
  off();
  publishCrosshair({ source: 'a', symbol: 'BTC/USDT', ts: 6 });
  assert.equal(seen.length, 1);
  const self = { source: 'b', symbol: 'BTC/USDT', marketType: 'spot' };
  assert.equal(shouldMirror(seen[0], self), true);
  assert.equal(shouldMirror(seen[0], { ...self, source: 'a' }), false);
  assert.equal(shouldMirror(seen[0], { ...self, symbol: 'ETH/USDT' }), false);
  assert.equal(shouldMirror(seen[0], { ...self, marketType: 'futures' }), false);
  assert.equal(shouldMirror({ ...seen[0], ts: null }, self), false);
  subscribeCrosshair(() => { throw new Error('bad listener'); })();
});

test('stream plans cover spot on four venues and Bitget derivatives, and refuse the rest', () => {
  assert.equal(venueMarketId('okx', 'BTC/USDT'), 'BTC-USDT');
  assert.equal(venueMarketId('binance', 'BTC/USDT:USDT'), 'BTCUSDT');
  assert.equal(venueMarketId('binance', 'junk'), null);
  assert.match(streamPlan({ exchange: 'binance', symbol: 'BTC/USDT' }).url, /btcusdt@ticker$/);
  assert.equal(streamPlan({ exchange: 'okx', symbol: 'BTC/USDT' }).subscribe.args[0].instId, 'BTC-USDT');
  const mix = streamPlan({ exchange: 'bitget', symbol: 'BTC/USDT', marketType: 'futures' });
  assert.equal(mix.subscribe.args[0].instType, 'USDT-FUTURES');
  assert.equal(mix.subscribe.args[0].instId, 'BTCUSDT');
  assert.equal(streamPlan({ exchange: 'bitget', symbol: 'BTC/USD', marketType: 'coin-futures', instrumentId: 'BTCUSD' }).subscribe.args[0].instId, 'BTCUSD');
  assert.equal(streamPlan({ exchange: 'bitget', symbol: 'BTC/USDT', marketType: 'margin' }).subscribe.args[0].instType, 'SPOT');
  assert.equal(streamPlan({ exchange: 'binance', symbol: 'BTC/USDT', marketType: 'futures' }), null);
  assert.equal(streamPlan({ exchange: 'kraken', symbol: 'BTC/USDT' }), null);
  assert.equal(streamPlan({ exchange: 'bitget', symbol: 'BTC/USDT', marketType: 'cfd' }), null);
});

test('stream messages decode through the shared native parser; noise is ignored', () => {
  const plan = streamPlan({ exchange: 'bitget', symbol: 'BTC/USDT', marketType: 'futures' });
  const frame = JSON.stringify({ arg: { channel: 'ticker', instId: 'BTCUSDT' }, data: [{ lastPr: '67000.5', bidPr: '67000', askPr: '67001', ts: '1000' }] });
  const t = decodeStreamMessage(plan, frame, 2000);
  assert.deepEqual([t.price, t.bid, t.ask, t.ts], [67000.5, 67000, 67001, 1000]);
  assert.equal(decodeStreamMessage(plan, 'pong'), null);
  assert.equal(decodeStreamMessage(plan, '{"event":"subscribe"}'), null);
  assert.equal(decodeStreamMessage(plan, '{bad'), null);
  assert.equal(decodeStreamMessage(null, frame), null);
  assert.equal(streamIsFresh(1000, 5000), true);
  assert.equal(streamIsFresh(1000, 20000), false);
  assert.equal(streamIsFresh(undefined, 1), false);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffMs), [1000, 2000, 4000, 8000, 15000, 15000]);
});
