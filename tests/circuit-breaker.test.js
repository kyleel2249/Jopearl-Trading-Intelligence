import test from 'node:test';
import assert from 'node:assert/strict';
import { createBreaker, recordTrade, canTrade, tick, resume } from '../src/lib/circuit-breaker.js';

const T0 = Date.UTC(2026, 10, 25, 12, 0, 0);
const HOUR = 3600000;

test('stays closed while losses are inside every limit', () => {
  let s = createBreaker(10000, {}, T0);
  s = recordTrade(s, { pnl: -50, equity: 9950, at: T0 });
  assert.equal(canTrade(s, T0).allowed, true);
  assert.equal(s.consecutiveLosses, 1);
});

test('daily loss trips and clears at the next UTC day, not before', () => {
  let s = createBreaker(10000, { maxDrawdownPct: 50 }, T0);
  s = recordTrade(s, { pnl: -300, equity: 9700, at: T0 });
  assert.equal(s.status, 'open');
  assert.match(s.reasons[0], /daily loss 3\.00%/);
  assert.equal(canTrade(s, T0 + 11 * HOUR).allowed, false);
  const nextDay = Date.UTC(2026, 10, 26);
  assert.equal(canTrade(s, nextDay).allowed, true);
  const t = tick(s, nextDay);
  assert.equal(t.status, 'closed'); assert.equal(t.dayStartEquity, 9700);
  assert.equal(t.history.at(-1).type, 'auto_reset');
});

test('drawdown needs a manual resume with an audit trail and resets the peak', () => {
  let s = createBreaker(10000, { maxDailyLossPct: 100 }, T0);
  s = recordTrade(s, { pnl: -600, equity: 9400, at: T0 });
  assert.equal(s.status, 'open'); assert.equal(s.manualResumeRequired, true);
  assert.equal(canTrade(s, T0 + 1000 * HOUR).allowed, false);
  assert.equal(tick(s, T0 + 1000 * HOUR).status, 'open');
  assert.throws(() => resume(s, {}), TypeError);
  const r = resume(s, { by: 'ops', reason: 'reviewed', at: T0 + HOUR });
  assert.equal(r.status, 'closed'); assert.equal(r.peakEquity, 9400);
  assert.equal(r.history.at(-1).by, 'ops');
  assert.equal(recordTrade(r, { pnl: -10, equity: 9390, at: T0 + 2 * HOUR }).status, 'closed');
});

test('consecutive losses trip, cool down, and a win resets the streak', () => {
  const cfg = { maxDrawdownPct: 100, maxDailyLossPct: 100, maxConsecutiveLosses: 3, cooldownMs: HOUR };
  let s = createBreaker(10000, cfg, T0);
  s = recordTrade(s, { pnl: -10, equity: 9990, at: T0 });
  s = recordTrade(s, { pnl: 20, equity: 10010, at: T0 });
  assert.equal(s.consecutiveLosses, 0);
  for (let i = 0; i < 3; i++) s = recordTrade(s, { pnl: -10, equity: 10000 - 10 * (i + 1), at: T0 + i * 1000 });
  assert.equal(s.status, 'open');
  assert.equal(canTrade(s, T0 + 30 * 60000).allowed, false);
  assert.equal(canTrade(s, T0 + 2000 + HOUR).allowed, true);
  assert.equal(tick(s, T0 + 2000 + HOUR).consecutiveLosses, 0);
});

test('multiple breaches are all reported; manual drawdown wins over auto resume', () => {
  let s = createBreaker(10000, { maxConsecutiveLosses: 1 }, T0);
  s = recordTrade(s, { pnl: -1000, equity: 9000, at: T0 });
  assert.equal(s.reasons.length, 3);
  assert.equal(s.resumeAt, null);
});

test('history is capped and bad input is rejected', () => {
  let s = createBreaker(10000, { historyLimit: 2, maxDrawdownPct: 1, maxDailyLossPct: 100 }, T0);
  for (let i = 0; i < 4; i++) {
    s = recordTrade(s, { pnl: -200, equity: 9800 - i, at: T0 + i });
    s = resume(s, { by: 'ops', reason: 'test', at: T0 + i });
  }
  assert.ok(s.history.length <= 2);
  assert.throws(() => createBreaker(0), TypeError);
  assert.throws(() => recordTrade(s, { pnl: 'x', equity: 100 }), TypeError);
});

test('functions do not mutate the input state', () => {
  const s = createBreaker(10000, {}, T0);
  const snap = JSON.stringify(s);
  recordTrade(s, { pnl: -900, equity: 9100, at: T0 });
  assert.equal(JSON.stringify(s), snap);
});
