import test from 'node:test';
import assert from 'node:assert/strict';
import { reliabilityCurve, calibrationScores, edgeDecay, calibrationReport, orderRecords, statusRank } from './calibration.js';

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const HOUR = 3600e3, T0 = Date.UTC(2026, 0, 1);

/** n records whose win probability is winP(i); wins return +2R, losses -1R. */
function series(n, winP, { confidence = 60, preset = 'balanced', setupType = 'sweep', session = 'london', symbol = 'BTC/USDT', seed = 11 } = {}) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const win = r() < winP(i);
    out.push({ id: preset + setupType + i, candleTs: T0 + i * HOUR, confidence: typeof confidence === 'function' ? confidence(i) : confidence, outcome: win ? 'win' : 'loss', returnR: win ? 2 : -1, preset, setupType, session, symbol, timeframe: '1h' });
  }
  return out;
}

test('orderRecords sorts oldest first, drops rows without a timestamp and does not mutate its input', () => {
  const input = [{ candleTs: 30 }, { candleTs: 10 }, { id: 'no-ts' }, null, { candleTs: 20 }];
  const copy = JSON.parse(JSON.stringify(input));
  assert.deepEqual(orderRecords(input).map((r) => r.candleTs), [10, 20, 30]);
  assert.deepEqual(input, copy);
  assert.deepEqual(orderRecords('nope'), []);
});

test('a calibrated confidence stream scores near zero ECE and its bins read calibrated', () => {
  const rows = series(1500, () => 0.6, { confidence: 60 });
  const curve = reliabilityCurve(rows);
  assert.equal(curve.length, 1);
  assert.equal(curve[0].status, 'calibrated');
  assert.ok(Math.abs(curve[0].gap) < 0.05, 'gap ' + curve[0].gap);
  const scores = calibrationScores(rows);
  assert.ok(scores.ece < 0.05);
  assert.ok(scores.brier > 0 && scores.brier <= 0.3);
});

test('an overconfident model is flagged: stated 85% but winning about 50%', () => {
  const rows = series(800, () => 0.5, { confidence: 85 });
  const [bin] = reliabilityCurve(rows);
  assert.equal(bin.status, 'overconfident');
  assert.ok(bin.gap < -0.25);
  const report = calibrationReport(rows);
  assert.equal(report.overall.miscalibrated, true);
  assert.ok(report.overall.skill < 0, 'worse than predicting the base rate');
});

test('an underconfident model is flagged and thin bins stay insufficient rather than guessed', () => {
  const rows = series(600, () => 0.8, { confidence: 55 });
  assert.equal(reliabilityCurve(rows)[0].status, 'underconfident');
  const thin = series(5, () => 0.5, { confidence: 70 });
  assert.equal(reliabilityCurve(thin)[0].status, 'insufficient');
  assert.equal(calibrationScores(thin).ece, null);
});

test('confidence of exactly 100 lands in the top bin and out-of-range values are clamped', () => {
  const rows = [100, 100, 130, -5].map((confidence, i) => ({ candleTs: i + 1, confidence, outcome: 'win', returnR: 1 }));
  const curve = reliabilityCurve(rows, { minBin: 1 });
  assert.deepEqual(curve.map((b) => [b.min, b.max, b.n]), [[0, 10, 1], [90, 100, 3]]);
});

test('edgeDecay reports insufficient until there are enough closed trades', () => {
  const result = edgeDecay(series(30, () => 0.6));
  assert.equal(result.status, 'insufficient');
  assert.equal(result.needed, 60);
});

test('edgeDecay stays healthy on a stationary strategy', () => {
  const result = edgeDecay(series(400, () => 0.5, { seed: 3 }));
  assert.equal(result.status, 'healthy');
  assert.ok(result.z === null || result.z > -1.64);
});

test('edgeDecay flags a strategy whose win rate collapses in the most recent trades', () => {
  const rows = series(300, (i) => (i < 240 ? 0.55 : 0.1), { seed: 5 });
  const result = edgeDecay(rows);
  assert.equal(result.status, 'decaying');
  assert.ok(result.recent.expectancy < 0 && result.baseline.expectancy > 0);
  assert.ok(result.z <= -1.64);
  assert.equal(result.cusum.triggered, true);
});

test('edgeDecay watches (not decays) a mild slowdown that stays profitable', () => {
  const rows = series(400, (i) => (i < 340 ? 0.62 : 0.5), { seed: 9 });
  const result = edgeDecay(rows);
  assert.ok(['healthy', 'watch'].includes(result.status), result.status);
  assert.notEqual(result.status, 'decaying');
});

test('edgeDecay handles a zero-variance history without dividing by zero', () => {
  const rows = Array.from({ length: 120 }, (_, i) => ({ candleTs: i + 1, returnR: 1, outcome: 'win' }));
  const result = edgeDecay(rows);
  assert.equal(result.z, null);
  assert.equal(result.status, 'healthy');
});

test('calibrationReport groups by strategy, session and market and surfaces only the decaying one', () => {
  const good = series(200, () => 0.58, { preset: 'balanced', setupType: 'sweep', session: 'london', symbol: 'BTC/USDT', seed: 21 });
  const bad = series(300, (i) => (i < 240 ? 0.55 : 0.08), { preset: 'alpha', setupType: 'reversal', session: 'new-york', symbol: 'ETH/USDT', seed: 22 });
  const report = calibrationReport([...good, ...bad], { now: 1234 });
  assert.equal(report.status, 'ok');
  assert.equal(report.asOf, 1234);
  assert.equal(report.n, 500);
  const strategy = Object.fromEntries(report.groups.strategy.map((g) => [g.key, g.status]));
  assert.equal(strategy['alpha / reversal'], 'decaying');
  assert.notEqual(strategy['balanced / sweep'], 'decaying');
  assert.equal(report.groups.session[0].key, 'new-york', 'worst status sorts first');
  assert.ok(report.flagged.some((f) => f.dimension === 'market' && f.key === 'ETH/USDT 1h' && f.status === 'decaying'));
  assert.ok(report.flagged.every((f) => statusRank(f.status) >= statusRank('watch')));
});

test('calibrationReport on no data is an explicit empty report, not an error', () => {
  const report = calibrationReport([]);
  assert.equal(report.status, 'empty');
  assert.equal(report.n, 0);
  assert.deepEqual(report.flagged, []);
  assert.equal(report.overall.edge.status, 'insufficient');
  assert.equal(report.overall.ece, null);
});

test('calibrationReport is deterministic and leaves the caller\'s array untouched', () => {
  const rows = series(250, () => 0.5, { seed: 31 }).reverse();
  const before = JSON.stringify(rows);
  const a = calibrationReport(rows), b = calibrationReport(rows);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(rows), before);
});
