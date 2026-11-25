import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScale, buildScaleAxis, resolveRange, buildRangeProfile, percentLabel } from './chart-scale.js';

test('linear and log scales round-trip and keep price order', () => {
  for (const mode of ['linear', 'log']) {
    const s = makeScale({ mode, lo: 50, hi: 200, top: 10, bottom: 410 });
    assert.ok(Math.abs(s.y(200) - 10) < 1e-9 && Math.abs(s.y(50) - 410) < 1e-9, mode);
    for (const p of [60, 100, 150]) assert.ok(Math.abs(s.price(s.y(p)) - p) < 1e-9, mode + ' ' + p);
    assert.ok(s.y(100) > s.y(150));
  }
  const log = makeScale({ mode: 'log', lo: 50, hi: 200, top: 0, bottom: 400 });
  assert.ok(Math.abs(log.y(100) - 200) < 1e-9, 'geometric midpoint sits mid-pane');
  assert.equal(makeScale({ mode: 'log', lo: -1, hi: 5, top: 0, bottom: 10 }).mode, 'linear', 'non-positive bound falls back');
});

test('percent axis labels the move from the reference and includes zero', () => {
  const axis = buildScaleAxis({ mode: 'percent', lo: 95, hi: 105, top: 0, bottom: 400, pip: 0.1, ref: 100 });
  assert.equal(axis.mode, 'percent');
  const zero = axis.ticks.find((t) => t.label === '0.00%');
  assert.ok(zero && Math.abs(zero.price - 100) < 1e-9);
  assert.ok(axis.ticks.every((t) => /%$/.test(t.label)));
  assert.equal(percentLabel(1.5), '+1.50%');
  assert.equal(percentLabel(-0.25), '-0.25%');
  for (let i = 1; i < axis.ticks.length; i += 1) assert.ok(axis.ticks[i].price > axis.ticks[i - 1].price);
  const fallback = buildScaleAxis({ mode: 'percent', lo: 95, hi: 105, top: 0, bottom: 400, pip: 0.1, ref: 0 });
  assert.equal(fallback.mode, 'linear');
});

test('log axis keeps a readable gap in pixels and linear mode still labels every pip', () => {
  const log = buildScaleAxis({ mode: 'log', lo: 100, hi: 400, top: 0, bottom: 500, pip: 1, minLabelPx: 14 });
  const scale = makeScale({ mode: 'log', lo: 100, hi: 400, top: 0, bottom: 500 });
  assert.equal(log.mode, 'log');
  assert.ok(log.ticks.length > 3);
  for (let i = 1; i < log.ticks.length; i += 1) assert.ok(scale.y(log.ticks[i - 1].price) - scale.y(log.ticks[i].price) >= 14 - 1e-9);
  const lin = buildScaleAxis({ mode: 'linear', lo: 1.08, hi: 1.082, top: 0, bottom: 400, pip: 0.0001 });
  assert.equal(lin.everyPip, true);
  assert.equal(lin.mode, 'linear');
});

test('locked range wins over auto fit and ignores nonsense', () => {
  assert.deepEqual(resolveRange({ lo: 1, hi: 2 }, { lo: 5, hi: 9 }), { lo: 5, hi: 9, locked: true });
  assert.deepEqual(resolveRange({ lo: 1, hi: 2 }, null), { lo: 1, hi: 2, locked: false });
  assert.deepEqual(resolveRange({ lo: 1, hi: 2 }, { lo: 9, hi: 5 }), { lo: 1, hi: 2, locked: false });
});

test('range profile spreads volume across touched bins, finds POC and the 70% value area', () => {
  const rows = [
    [0, 100, 110, 100, 105, 10], [1, 105, 110, 100, 106, 10],
    [2, 106, 107, 105, 106, 60], [3, 106, 130, 105, 120, 5]
  ];
  const p = buildRangeProfile(rows, { bins: 30, lo: 100, hi: 130 });
  assert.equal(p.bins.length, 30);
  assert.ok(Math.abs(p.total - 85) < 1e-9);
  assert.ok(Math.abs(p.bins.reduce((s, b) => s + b.volume, 0) - 85) < 1e-9, 'volume is conserved');
  assert.ok(p.poc.price >= 105 && p.poc.price <= 107, 'POC at ' + p.poc.price);
  assert.ok(p.val <= p.poc.price && p.vah >= p.poc.price);
  assert.ok(p.valueAreaShare >= 0.7);
  assert.equal(buildRangeProfile([[0, 1, 1, 1, 1, 0]], { bins: 10, lo: 0.5, hi: 1.5 }), null, 'no volume, no profile');
  assert.equal(buildRangeProfile([], {}), null);
  assert.equal(buildRangeProfile(rows, { lo: 5, hi: 5 }), null);
});
