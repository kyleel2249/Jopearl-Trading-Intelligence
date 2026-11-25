import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeDecay } from '../src/gainz-alpha/calibration.js';

// Replays the scheduler: the edge is re-evaluated after every new closed trade and an alert is raised
// each time the status moves into `decaying`, with a 24-trade refractory period (one trading day of
// hourly signals). Fixed seeds keep this deterministic; the bounds leave headroom over the measured rates
// (healthy 2.4%, collapse 93%) while still failing if the detector goes back to over- or under-alerting.
function rng(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }
const history = (n, winP, seed) => { const r = rng(seed); return Array.from({ length: n }, (_, i) => { const w = r() < winP(i); return { candleTs: i + 1, returnR: w ? 2 : -1, outcome: w ? 'win' : 'loss' }; }); };

function alertsFor(rows, from) {
  let previous = 'healthy', cooldown = 0; const at = [];
  for (let n = from; n <= rows.length; n++) {
    const status = edgeDecay(rows.slice(0, n)).status;
    if (cooldown > 0) cooldown--;
    if (status === 'decaying' && previous !== 'decaying' && cooldown === 0) { at.push(n); cooldown = 24; }
    previous = status;
  }
  return at;
}

test('a healthy, stationary strategy almost never triggers a decay alert over 540 trades', () => {
  let seriesWithAlert = 0;
  for (let seed = 1; seed <= 30; seed++) if (alertsFor(history(540, () => 0.55, seed * 7919), 100).length) seriesWithAlert++;
  assert.ok(seriesWithAlert <= 3, seriesWithAlert + ' of 30 healthy histories raised a decay alert');
});

test('a marginal strategy that still has a small edge is not paged either', () => {
  let seriesWithAlert = 0;
  for (let seed = 1; seed <= 30; seed++) if (alertsFor(history(540, () => 0.4, seed * 104729), 100).length) seriesWithAlert++;
  assert.ok(seriesWithAlert <= 3, seriesWithAlert + ' of 30 marginal histories raised a decay alert');
});

test('a collapse from a 55% to a 25% win rate is caught quickly in nearly every history', () => {
  let detected = 0; const delays = [];
  for (let seed = 1; seed <= 30; seed++) {
    const rows = history(560, (i) => (i < 400 ? 0.55 : 0.25), seed * 15485863);
    const first = alertsFor(rows, 380).find((n) => n > 400);
    if (first) { detected++; delays.push(first - 400); }
  }
  delays.sort((a, b) => a - b);
  assert.ok(detected >= 22, 'only ' + detected + ' of 30 collapses were detected');
  assert.ok(delays[delays.length >> 1] <= 70, 'median detection delay ' + delays[delays.length >> 1] + ' trades');
});

test('a total collapse is detected in every history', () => {
  for (let seed = 1; seed <= 15; seed++) {
    const rows = history(500, (i) => (i < 400 ? 0.55 : 0.08), seed * 32452843);
    assert.ok(alertsFor(rows, 380).some((n) => n > 400), 'seed ' + seed + ' missed a collapse to 8%');
  }
});
