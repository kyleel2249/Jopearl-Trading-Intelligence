import test from 'node:test';
import assert from 'node:assert/strict';
import { rollingWalkForward, walkForwardVerdict, minimumBars, DEFAULT_GRID } from './walkforward.js';

const base = Date.UTC(2026, 0, 1), HOUR = 3600e3;
function longSeries(n, seed = 7) {
  let s = seed, p = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, rows = [];
  for (let i = 0; i < n; i++) { const o = p, cl = Math.max(1, o + (rnd() - 0.5) * 1.4 + Math.sin(i / 17) * 0.15); rows.push([base + i * HOUR, o, Math.max(o, cl) + rnd() * 0.5, Math.min(o, cl) - rnd() * 0.5, cl, 100 + rnd() * 50]); p = cl; }
  return rows;
}
const OPTS = { symbol: 'SYN', timeframe: '1h', trainBars: 200, testBars: 100, window: 150, minTrainTrades: 5, grid: [{ id: 'balanced', preset: 'balanced' }, { id: 'alpha', preset: 'alpha' }] };
const rows = longSeries(800);

test('verdict rules: insufficient, failing, fragile and robust', () => {
  assert.equal(walkForwardVerdict({ trades: 29, expectancy: 1, positiveShare: 1, efficiency: 1 }), 'insufficient');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: 0, positiveShare: 1, efficiency: 1 }), 'failing');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: -0.2, positiveShare: 0.9, efficiency: 1 }), 'failing');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: 0.3, positiveShare: 0.5, efficiency: 0.9 }), 'fragile');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: 0.3, positiveShare: 0.8, efficiency: 0.3 }), 'fragile');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: 0.3, positiveShare: 0.8, efficiency: 0.5 }), 'robust');
  assert.equal(walkForwardVerdict({ trades: 80, expectancy: 0.3, positiveShare: 0.6, efficiency: null }), 'robust');
  assert.equal(walkForwardVerdict({ trades: undefined, expectancy: 1, positiveShare: 1, efficiency: 1 }), 'insufficient');
});

test('invalid configuration is rejected with a clear reason instead of throwing', () => {
  assert.equal(rollingWalkForward(rows, { ...OPTS, timeframe: 'bogus' }).status, 'error');
  assert.match(rollingWalkForward(rows, { ...OPTS, grid: [] }).reason, /at least one candidate/);
  assert.match(rollingWalkForward(rows, { ...OPTS, grid: [{ id: 'a', preset: 'balanced' }, { id: 'a', preset: 'alpha' }] }).reason, /unique/);
  assert.match(rollingWalkForward(rows, { ...OPTS, grid: [{ preset: 'balanced' }] }).reason, /unique string id/);
  assert.match(rollingWalkForward(rows, { ...OPTS, trainBars: 50 }).reason, /trainBars/);
  assert.match(rollingWalkForward(rows, { ...OPTS, testBars: 10 }).reason, /testBars/);
});

test('too little history reports how many candles are required', () => {
  const need = minimumBars(OPTS);
  const result = rollingWalkForward(longSeries(need - 1), OPTS);
  assert.equal(result.status, 'insufficient');
  assert.equal(result.needed, need);
  assert.equal(rollingWalkForward(longSeries(need), OPTS).status, 'ok');
  assert.equal(rollingWalkForward(undefined, OPTS).status, 'insufficient');
  assert.ok(DEFAULT_GRID.length >= 3);
});

test('the walk-forward is deterministic and its metrics are internally consistent', () => {
  const a = rollingWalkForward(rows, OPTS), b = rollingWalkForward(rows, OPTS);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'ok');
  assert.equal(a.windows.length, 5);
  assert.equal(a.metrics.windows, 5);
  const chosen = a.windows.filter((w) => w.chosen);
  assert.equal(Object.values(a.metrics.selections).reduce((s, v) => s + v, 0), chosen.length);
  assert.equal(a.oos.summary.n, a.oos.trades.length);
  assert.equal(a.oos.trades.length, a.windows.reduce((s, w) => s + w.test.trades, 0));
  assert.ok(a.metrics.positiveWindowShare === null || (a.metrics.positiveWindowShare >= 0 && a.metrics.positiveWindowShare <= 1));
  assert.ok(a.oos.trades.every((t) => ['win', 'loss', 'timeout'].includes(t.outcome) && Number.isFinite(t.returnR) && t.candidate && t.window));
  assert.equal(a.assumptions.embargoBars, 24);
  assert.equal(a.monteCarlo.status, a.oos.summary.n >= 20 ? 'ok' : 'insufficient');
  assert.equal(a.verdict, walkForwardVerdict({ trades: a.oos.summary.n, expectancy: a.oos.summary.expectancy, positiveShare: a.metrics.positiveWindowShare, efficiency: a.metrics.walkForwardEfficiency }));
});

test('train and test spans never touch: an embargo of maxHold bars separates them and tests do not overlap', () => {
  const result = rollingWalkForward(rows, OPTS);
  for (const w of result.windows) assert.equal(w.test.fromTs - w.train.toTs, 24 * HOUR, 'window ' + w.index);
  for (let i = 1; i < result.windows.length; i++) assert.ok(result.windows[i].test.fromTs >= result.windows[i - 1].test.toTs);
  const smaller = rollingWalkForward(rows, { ...OPTS, stepBars: 10 });
  assert.equal(smaller.assumptions.stepBars, 100, 'a step smaller than the test span is raised to it');
  assert.deepEqual(smaller.windows.map((w) => w.test.fromTs), result.windows.map((w) => w.test.fromTs));
  const ids = result.oos.trades.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'no trade is counted twice');
});

test('no lookahead: data after a window cannot change its selection or its out-of-sample trades', () => {
  const full = rollingWalkForward(rows, OPTS);
  const truncated = rollingWalkForward(rows.slice(0, 600), OPTS);
  assert.equal(truncated.windows.length, 3);
  for (let i = 0; i < truncated.windows.length; i++) assert.deepEqual(truncated.windows[i], full.windows[i], 'window ' + (i + 1));
  const keep = (r) => r.oos.trades.filter((t) => t.window <= 3).map((t) => [t.id, t.returnR, t.candidate]);
  assert.deepEqual(keep(truncated), keep(full));
});

test('no leakage from test to train: rewriting the test span leaves that window\'s training result untouched', () => {
  const clean = rollingWalkForward(rows, OPTS);
  const first = clean.windows[0];
  const testStart = 60 + 200 + 24, testEnd = testStart + 100;
  const altered = rows.map((r, i) => (i >= testStart && i <= testEnd ? [r[0], r[1] * 0.8, r[2] * 0.8, r[3] * 0.8, r[4] * 0.8, r[5]] : r));
  const result = rollingWalkForward(altered, OPTS);
  assert.deepEqual(result.windows[0].train, first.train);
  assert.equal(result.windows[0].chosen, first.chosen);
});

test('exchange fees change returns but not which setups are taken', () => {
  const single = { ...OPTS, grid: [{ id: 'balanced', preset: 'balanced' }] };
  const free = rollingWalkForward(rows, { ...single, feePct: 0 });
  const expensive = rollingWalkForward(rows, { ...single, feePct: 0.004 });
  assert.ok(free.oos.summary.n > 0);
  assert.deepEqual(expensive.oos.trades.map((t) => t.id), free.oos.trades.map((t) => t.id));
  assert.ok(expensive.oos.summary.expectancy < free.oos.summary.expectancy, expensive.oos.summary.expectancy + ' vs ' + free.oos.summary.expectancy);
  assert.ok(expensive.oos.summary.netR < free.oos.summary.netR);
});

test('spread and slippage are cost-aware: the engine drops setups whose reward-to-risk no longer clears after costs', () => {
  const single = { ...OPTS, grid: [{ id: 'balanced', preset: 'balanced' }], feePct: 0 };
  const cheap = rollingWalkForward(rows, { ...single, spreadPct: 0, slippagePct: 0 });
  const costly = rollingWalkForward(rows, { ...single, spreadPct: 0.003, slippagePct: 0.003 });
  assert.ok(cheap.oos.summary.n > 0);
  assert.ok(costly.oos.summary.n <= cheap.oos.summary.n, 'costs can only remove setups: ' + costly.oos.summary.n + ' vs ' + cheap.oos.summary.n);
  assert.equal(costly.assumptions.spreadPct, 0.003);
  assert.equal(costly.assumptions.slippagePct, 0.003);
  assert.equal(rollingWalkForward(rows, single).assumptions.spreadPct, 'preset default');
});

test('windows where no candidate reaches the training trade minimum are skipped, not guessed', () => {
  const result = rollingWalkForward(rows, { ...OPTS, minTrainTrades: 100000 });
  assert.equal(result.status, 'ok');
  assert.ok(result.windows.every((w) => w.chosen === null && /^no-candidate-reached-/.test(w.skipped) && w.test.trades === 0));
  assert.equal(result.oos.summary.n, 0);
  assert.equal(result.verdict, 'insufficient');
  assert.equal(result.monteCarlo.status, 'insufficient');
  assert.equal(result.metrics.parameterStability, null);
});

test('the Monte Carlo options pass through to the report', () => {
  const result = rollingWalkForward(rows, { ...OPTS, monteCarlo: { runs: 500, seed: 9, riskPerTradePct: 0.5, minTrades: 2 } });
  if (result.oos.summary.n >= 2) {
    assert.equal(result.monteCarlo.runs, 500);
    assert.equal(result.monteCarlo.seed, 9);
    assert.equal(result.monteCarlo.assumptions.riskPerTradePct, 0.5);
  }
});
