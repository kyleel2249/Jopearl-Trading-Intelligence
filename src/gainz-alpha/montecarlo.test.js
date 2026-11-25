import test from 'node:test';
import assert from 'node:assert/strict';
import { monteCarloDrawdown, seededRandom, percentile } from './montecarlo.js';

const alternating = (n, win = 2, loss = -1, winEvery = 2) => Array.from({ length: n }, (_, i) => (i % winEvery === 0 ? win : loss));

test('seededRandom is deterministic per seed, differs across seeds and stays in [0, 1)', () => {
  const a = seededRandom(42), b = seededRandom(42), c = seededRandom(43);
  const first = Array.from({ length: 5 }, a), second = Array.from({ length: 5 }, b), other = Array.from({ length: 5 }, c);
  assert.deepEqual(first, second);
  assert.notDeepEqual(first, other);
  const r = seededRandom(7);
  for (let i = 0; i < 5000; i++) { const v = r(); assert.ok(v >= 0 && v < 1); }
});

test('percentile interpolates and handles empty and out-of-range input', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 90), 10);
  assert.equal(percentile([0, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 100), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 250), 5);
});

test('too few trades is reported as insufficient instead of producing misleading bands', () => {
  const result = monteCarloDrawdown([1, -1, 2]);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.needed, 20);
  assert.equal(monteCarloDrawdown(undefined).status, 'insufficient');
  assert.equal(monteCarloDrawdown(['x', null, NaN]).n, 0);
});

test('missing or non-numeric results are dropped, never counted as break-even trades', () => {
  const dirty = [...alternating(30), null, undefined, '', '  ', [], {}, true, 'abc', NaN, Infinity];
  const result = monteCarloDrawdown(dirty, { seed: 4 });
  assert.equal(result.n, 30);
  assert.deepEqual(result, monteCarloDrawdown(alternating(30), { seed: 4 }));
  assert.equal(monteCarloDrawdown([...alternating(25), '1.5', ' -2 ']).n, 27, 'numeric strings are accepted');
});

test('the same seed reproduces the same bands and a different seed changes them', () => {
  const R = alternating(60);
  assert.deepEqual(monteCarloDrawdown(R, { seed: 5 }), monteCarloDrawdown(R, { seed: 5 }));
  assert.notDeepEqual(monteCarloDrawdown(R, { seed: 5 }).maxDrawdownPct, monteCarloDrawdown(R, { seed: 6 }).maxDrawdownPct);
});

test('bands are ordered and a strongly positive edge has low ruin probability and rarely ends below start', () => {
  const R = alternating(100, 2, -1, 2); // +0.5R per trade
  const result = monteCarloDrawdown(R, { runs: 3000, riskPerTradePct: 1, seed: 11 });
  assert.equal(result.status, 'ok');
  const dd = result.maxDrawdownPct, fin = result.finalReturnPct;
  assert.ok(dd.p5 <= dd.p25 && dd.p25 <= dd.p50 && dd.p50 <= dd.p75 && dd.p75 <= dd.p95);
  assert.ok(fin.p5 <= fin.p50 && fin.p50 <= fin.p95);
  assert.ok(fin.p50 > 0);
  assert.ok(result.probabilityOfRuin < 0.01);
  assert.ok(result.probabilityOfLoss < 0.05);
});

test('a negative edge is flagged: median result is a loss and ruin becomes likely at high risk', () => {
  const R = alternating(100, 1, -1, 3); // wins 1/3 of the time, +1R vs -1R
  const result = monteCarloDrawdown(R, { runs: 3000, riskPerTradePct: 5, seed: 3, horizon: 200 });
  assert.ok(result.finalReturnPct.p50 < 0);
  assert.ok(result.probabilityOfLoss > 0.9);
  assert.ok(result.probabilityOfRuin > 0.5);
});

test('risk per trade scales drawdown: five times the risk gives a clearly deeper median drawdown', () => {
  const R = alternating(80, 2, -1, 2);
  const low = monteCarloDrawdown(R, { runs: 2000, riskPerTradePct: 0.5, seed: 9 });
  const high = monteCarloDrawdown(R, { runs: 2000, riskPerTradePct: 2.5, seed: 9 });
  assert.ok(high.maxDrawdownPct.p50 > low.maxDrawdownPct.p50 * 3);
});

test('block bootstrap keeps loss clusters and therefore reports deeper tail drawdowns than an independent one', () => {
  // 10 wins then 10 losses, repeated: identical marginal distribution to a shuffled series, but clustered.
  const clustered = Array.from({ length: 200 }, (_, i) => (Math.floor(i / 10) % 2 === 0 ? 1 : -1));
  const independent = monteCarloDrawdown(clustered, { runs: 4000, seed: 21, riskPerTradePct: 2 });
  const blocked = monteCarloDrawdown(clustered, { runs: 4000, seed: 21, riskPerTradePct: 2, blockSize: 10 });
  assert.equal(blocked.blockSize, 10);
  assert.match(blocked.assumptions.resampling, /block bootstrap/);
  assert.ok(blocked.maxDrawdownPct.p95 > independent.maxDrawdownPct.p95 + 3, 'block p95 ' + blocked.maxDrawdownPct.p95 + ' vs independent ' + independent.maxDrawdownPct.p95);
});

test('options are clamped to safe ranges instead of hanging or producing NaN', () => {
  const R = alternating(40);
  const huge = monteCarloDrawdown(R, { runs: 1e9, horizon: 1e9, riskPerTradePct: 1000, blockSize: 1e6, seed: 1, ruinDrawdownPct: 500 });
  assert.equal(huge.runs, 20000);
  assert.equal(huge.horizon, 5000);
  assert.equal(huge.assumptions.riskPerTradePct, 10);
  assert.equal(huge.blockSize, 40);
  assert.equal(huge.assumptions.ruinDrawdownPct, 99);
  for (const v of Object.values(huge.maxDrawdownPct)) assert.ok(Number.isFinite(v));
  const tiny = monteCarloDrawdown(R, { runs: 1, horizon: 1 });
  assert.equal(tiny.runs, 100);
  assert.equal(tiny.horizon, 5);
});

test('equity cannot go below zero: a -100R loss at full risk is a total loss, not a negative balance', () => {
  const R = Array.from({ length: 30 }, () => -100);
  const result = monteCarloDrawdown(R, { runs: 200, riskPerTradePct: 10, seed: 2 });
  assert.equal(result.finalReturnPct.p5, -100);
  assert.equal(result.maxDrawdownPct.p95, 100);
  assert.equal(result.probabilityOfRuin, 1);
});
