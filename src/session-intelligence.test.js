import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSessionCandles, formatDuration, getSessionSnapshot } from './session-intelligence.js';

test('session snapshot identifies the London-New York overlap using local clocks', () => {
  const snapshot = getSessionSnapshot(Date.parse('2026-11-20T14:00:00.000Z'));
  assert.equal(snapshot.londonNewYorkOverlap, true);
  assert.deepEqual(snapshot.activeSessionNames.sort(), ['London', 'New York']);
});

test('session snapshot handles US and UK daylight-saving transition independently', () => {
  const winter = getSessionSnapshot(Date.parse('2026-11-20T13:30:00.000Z'));
  const summer = getSessionSnapshot(Date.parse('2026-07-20T13:30:00.000Z'));
  assert.equal(winter.londonNewYorkOverlap, true);
  assert.equal(summer.londonNewYorkOverlap, true);
  assert.equal(winter.sessions.find(item => item.id === 'new-york').localTime, '08:30');
  assert.equal(summer.sessions.find(item => item.id === 'new-york').localTime, '09:30');
});

test('session candle analytics calculate daily highs, lows, range and change', () => {
  const now = Date.parse('2026-11-20T14:00:00.000Z');
  const candles = [
    [Date.parse('2026-11-20T08:00:00Z'), 100, 105, 99, 104, 10],
    [Date.parse('2026-11-20T09:00:00Z'), 104, 108, 102, 106, 12],
    [Date.parse('2026-11-20T10:00:00Z'), 106, 107, 101, 102, 8],
    [Date.parse('2026-11-20T13:00:00Z'), 102, 110, 100, 109, 20]
  ];
  const result = analyzeSessionCandles(candles, now);
  const london = result.today.london;
  assert.equal(london.high, 110);
  assert.equal(london.low, 99);
  assert.equal(london.range, 11);
  assert.equal(london.changePercent, 9);
  assert.equal(result.today['new-york'].high, 110);
});

test('analytics excludes malformed candle rows and calculates historical session samples', () => {
  const candles = [
    [Date.parse('2026-11-19T08:00:00Z'), 100, 104, 98, 102, 5],
    [Date.parse('2026-11-20T08:00:00Z'), 102, 107, 100, 105, 6],
    [Date.parse('2026-11-20T09:00:00Z'), 105, 108, 103, 107, 7],
    ['bad', 1, 2, 0, 1, 2]
  ];
  const result = analyzeSessionCandles(candles, Date.parse('2026-11-20T14:00:00Z'));
  assert.equal(result.candleCount, 3);
  assert.equal(result.history.london.observations, 1);
  assert.equal(result.history.london.averageRange, 6);
});

test('duration formatter is stable for hours and minutes', () => {
  assert.equal(formatDuration(125), '2h 5m');
  assert.equal(formatDuration(35), '35m');
  assert.equal(formatDuration(-1), '—');
});
