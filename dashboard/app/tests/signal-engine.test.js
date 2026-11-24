import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSignal, atr, ema, rsi, timeframeMs } from '../engines/signal-engine.js';

function candles(count = 100, start = 1_700_000_000_000, slope = 2) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * slope;
    return [start + index * 3_600_000, close - 0.5, close + 1, close - 1, close, 1000 + index * 3];
  });
}

test('EMA, RSI and ATR return finite values on valid series', () => {
  const rows = candles();
  assert.equal(ema(rows.map((row) => row[4]), 20).length, 100);
  assert.ok(rsi(rows.map((row) => row[4])) > 90);
  assert.ok(atr(rows) > 0);
});

test('signal engine excludes a still-forming candle and emits deterministic levels', () => {
  const rows = candles();
  const result = analyzeSignal(rows, { now: rows.at(-1)[0] + 3_600_000 - 1 });
  assert.equal(result.dataQuality.formingCandleExcluded, true);
  assert.equal(result.dataQuality.completedCandles, 99);
  assert.equal(result.targets.length, 3);
  assert.ok(result.stopLoss < result.referencePrice);
  assert.ok(result.score <= 100);
});

test('insufficient history fails closed without fabricating a signal', () => {
  const result = analyzeSignal(candles(30), { now: Date.now() + 10_000_000 });
  assert.equal(result.status, 'insufficient-data');
  assert.equal(result.score, null);
});

test('timeframe parsing handles supported intervals', () => {
  assert.equal(timeframeMs('15m'), 900000);
  assert.equal(timeframeMs('4h'), 14400000);
});
