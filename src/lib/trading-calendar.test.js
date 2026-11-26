import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTradingWindow } from '../src/lib/trading-calendar.js';

test('weekday major-session windows permit entries subject to downstream quality and risk gates', () => {
  const result = evaluateTradingWindow(Date.parse('2026-11-23T12:00:00.000Z'));
  assert.equal(result.weekdayAllowed, true);
  assert.equal(result.sessionAllowed, true);
  assert.equal(result.eligible, true);
  assert.ok(result.activeSessions.includes('London'));
});

test('Saturday and Sunday UTC block new entries even when a market session is locally open', () => {
  for (const timestamp of ['2026-11-28T12:00:00.000Z', '2026-11-29T12:00:00.000Z']) {
    const result = evaluateTradingWindow(Date.parse(timestamp));
    assert.equal(result.weekdayAllowed, false);
    assert.equal(result.eligible, false);
    assert.match(result.reason, /Weekend protection/);
  }
});

test('invalid timestamps fail closed', () => {
  assert.throws(() => evaluateTradingWindow(Number.NaN), /valid trading-window timestamp/);
});
