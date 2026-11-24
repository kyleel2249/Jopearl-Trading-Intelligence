import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeframeMs, candleCloseAt, candleCountdown, formatCountdown, mergeLiveTick,
  resolvePipSize, pipIncrementFor, pipDistance, buildPriceAxis, axisWidthFor, applyPriceZoom
} from './chart-live.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 24, 10, 0, 0); // 10:00Z candle open

test('timeframe maths covers fixed frames and calendar months', () => {
  assert.equal(timeframeMs('15m'), 900_000);
  assert.equal(timeframeMs('1d'), 86_400_000);
  assert.equal(timeframeMs('nope'), null);
  assert.equal(candleCloseAt(T0, '1h'), T0 + HOUR);
  assert.equal(candleCloseAt(Date.UTC(2026, 1, 1), '1M'), Date.UTC(2026, 2, 1)); // February has 28 days in 2026
  assert.equal(candleCloseAt(Date.UTC(2026, 11, 1), '1M'), Date.UTC(2027, 0, 1)); // year rollover
  assert.equal(candleCloseAt(T0, 'bogus'), null);
});

test('countdown label and expiry', () => {
  assert.equal(formatCountdown(65_000), '01:05');
  assert.equal(formatCountdown(3_725_000), '1:02:05');
  assert.equal(formatCountdown(90_000_000), '1d 01h');
  assert.equal(formatCountdown(-5), '00:00');
  const live = candleCountdown(T0, '1h', T0 + 30 * 60_000);
  assert.equal(live.expired, false);
  assert.equal(live.remainingMs, 30 * 60_000);
  assert.equal(live.label, '30:00');
  const done = candleCountdown(T0, '1h', T0 + HOUR + 1);
  assert.equal(done.expired, true);
  assert.equal(done.label, '00:00');
  assert.equal(candleCountdown(T0, 'bogus', T0), null);
});

test('mergeLiveTick updates only the forming candle and preserves length and timestamps', () => {
  const candles = [[T0 - HOUR, 100, 105, 99, 102, 10], [T0, 102, 104, 101, 103, 5]];
  const up = mergeLiveTick(candles, 106, { timeframe: '1h', now: T0 + 20 * 60_000 });
  assert.equal(up.length, 2);
  assert.deepEqual(up[0], candles[0]);
  assert.deepEqual(up[1], [T0, 102, 106, 101, 106, 5]);
  const down = mergeLiveTick(candles, 100.5, { timeframe: '1h', now: T0 + 20 * 60_000 });
  assert.deepEqual(down[1], [T0, 102, 104, 100.5, 100.5, 5]);
  assert.deepEqual(candles[1], [T0, 102, 104, 101, 103, 5], 'input must not be mutated');
});

test('mergeLiveTick never fabricates or corrupts a candle', () => {
  const candles = [[T0, 102, 104, 101, 103, 5]];
  assert.equal(mergeLiveTick(candles, 106, { timeframe: '1h', now: T0 + HOUR }), candles, 'closed candle is left alone');
  assert.equal(mergeLiveTick(candles, 106, { timeframe: '1h', now: T0 - 1 }), candles, 'candle in the future is left alone');
  assert.equal(mergeLiveTick(candles, Number.NaN, { timeframe: '1h', now: T0 + 1 }), candles);
  assert.equal(mergeLiveTick(candles, 0, { timeframe: '1h', now: T0 + 1 }), candles);
  assert.equal(mergeLiveTick(candles, 106, { timeframe: 'bogus', now: T0 + 1 }), candles);
  assert.equal(mergeLiveTick(candles, 103, { timeframe: '1h', now: T0 + 1 }), candles, 'unchanged price keeps identity');
  const empty = [];
  assert.equal(mergeLiveTick(empty, 1, { timeframe: '1h' }), empty);
});

test('pip resolution prefers provider metadata, then profile, then heuristics, never finer than the tick', () => {
  assert.deepEqual(resolvePipSize({ symbol: 'EUR/USD', price: 1.08, precision: { pipSize: 0.0001 } }), { pip: 0.0001, source: 'instrument-pip' });
  assert.deepEqual(resolvePipSize({ symbol: 'BTC/USDT', price: 67000, profilePip: 1 }), { pip: 1, source: 'instrument-profile' });
  assert.deepEqual(resolvePipSize({ symbol: 'EUR/USD', price: 1.08 }), { pip: 0.0001, source: 'heuristic' });
  assert.deepEqual(resolvePipSize({ symbol: 'USD/JPY', price: 150 }), { pip: 0.01, source: 'heuristic' });
  assert.deepEqual(resolvePipSize({ symbol: 'BTC/USDT', price: 67000 }), { pip: 1, source: 'heuristic' });
  assert.deepEqual(resolvePipSize({ symbol: 'X/Y', price: 5, precision: { pipSize: 0.001, tickSize: 0.01 } }), { pip: 0.01, source: 'instrument-tick' });
  assert.equal(pipIncrementFor('DOGE/USDT', 0.15), 0.0001);
  assert.equal(pipDistance(1.08, 1.0812, 0.0001), 12);
  assert.equal(pipDistance(1, 1, 0), null);
});

test('price axis labels every pip when there is room', () => {
  // EUR/USD: 40 pips visible across 400px -> 10px per pip -> too tight for 14px labels at 1 pip, so every 2 pips
  const tight = buildPriceAxis({ min: 1.0800, max: 1.0840, heightPx: 400, pip: 0.0001, minLabelPx: 14 });
  assert.equal(tight.everyPip, false);
  assert.equal(tight.multiple, 2);
  // 20 pips across 400px -> 20px per pip -> every pip
  const roomy = buildPriceAxis({ min: 1.0800, max: 1.0820, heightPx: 400, pip: 0.0001, minLabelPx: 14 });
  assert.equal(roomy.everyPip, true);
  assert.equal(roomy.ticks.length, 21);
  assert.deepEqual(roomy.ticks.slice(0, 3).map((t) => t.label), ['1.0800', '1.0801', '1.0802']);
  assert.equal(roomy.decimals, 4);
  assert.equal(roomy.minor.length, 0);
  // consecutive labels are exactly one pip apart (no floating-point drift)
  for (let i = 1; i < roomy.ticks.length; i += 1) assert.equal(Number((roomy.ticks[i].price - roomy.ticks[i - 1].price).toFixed(10)), 0.0001);
});

test('price axis coarsens with 1-2-5 steps, keeps pip minor lines and never overlaps labels', () => {
  const axis = buildPriceAxis({ min: 66000, max: 68000, heightPx: 500, pip: 1, minLabelPx: 14 });
  assert.equal(axis.everyPip, false);
  assert.ok(axis.multiple >= 50 && [50, 100].includes(axis.multiple), 'multiple was ' + axis.multiple);
  const spacing = (axis.ticks[1].price - axis.ticks[0].price) / (2000 / 500);
  assert.ok(spacing >= 14, 'label spacing ' + spacing);
  assert.equal(axis.minor.length, 0, 'pips are denser than 3.5px so no minor lines');
  const mid = buildPriceAxis({ min: 100, max: 160, heightPx: 400, pip: 1, minLabelPx: 14 }); // 6.67px per pip
  assert.equal(mid.multiple, 5);
  assert.ok(mid.minor.length > 0 && mid.minor.every((p) => p % 5 !== 0), 'minor lines are the skipped pips');
  const frac = buildPriceAxis({ min: 150.00, max: 150.30, heightPx: 600, pip: 0.01, minLabelPx: 14 }); // USD/JPY, 30 pips
  assert.equal(frac.everyPip, true);
  assert.equal(frac.decimals, 2);
});

test('price axis rejects unusable input safely', () => {
  for (const input of [{}, { min: 1, max: 1, heightPx: 100, pip: 1 }, { min: 2, max: 1, heightPx: 100, pip: 1 }, { min: 1, max: 2, heightPx: 0, pip: 1 }, { min: 1, max: 2, heightPx: 100, pip: 0 }]) {
    const axis = buildPriceAxis(input);
    assert.deepEqual(axis.ticks, []);
    assert.equal(axis.everyPip, false);
  }
});

test('axis width fits the longest label and price zoom magnifies about a centre', () => {
  assert.equal(axisWidthFor(['1.0800', '1.0801']), 55); // 6 chars: ceil(6 * 6.4) + 16
  assert.equal(axisWidthFor(['67123.45', '1']), 68); // 8 chars: ceil(8 * 6.4) + 16
  assert.equal(axisWidthFor([]), 54);
  assert.equal(axisWidthFor(['x'.repeat(40)]), 118);
  assert.deepEqual(applyPriceZoom(100, 200, 1), { low: 100, high: 200 });
  assert.deepEqual(applyPriceZoom(100, 200, 2), { low: 125, high: 175 });
  assert.deepEqual(applyPriceZoom(100, 200, 2, 110), { low: 85, high: 135 });
  assert.deepEqual(applyPriceZoom(100, 200, 0.5), { low: 50, high: 250 });
  assert.deepEqual(applyPriceZoom(100, 200, -3), { low: 100, high: 200 });
});
