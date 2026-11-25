import test from 'node:test';
import assert from 'node:assert/strict';
import {
  timeToIndex, indexToTime, formatDuration, measureBetween, riskReward, defaultPosition, atrOf, fibLevels,
  createAlert, evaluateAlerts, sanitizeDrawings, sanitizeAlerts, loadJson, saveJson, drawingsKey,
  replayStart, replayStep, replaySlice, replayIntervalMs
} from './chart-tools.js';

const H = 3_600_000, T0 = Date.UTC(2026, 10, 24, 0, 0, 0);
const rows = Array.from({ length: 10 }, (_, i) => [T0 + i * H, 100 + i, 102 + i, 99 + i, 101 + i, 10]);

test('time and index map both ways, inside and beyond the loaded candles', () => {
  assert.equal(timeToIndex(rows, T0 + 3 * H, H), 3);
  assert.equal(timeToIndex(rows, T0 + 3.5 * H, H), 3.5);
  assert.equal(timeToIndex(rows, T0 + 12 * H, H), 12);
  assert.equal(timeToIndex(rows, T0 - 2 * H, H), -2);
  assert.equal(indexToTime(rows, 4.5, H), T0 + 4.5 * H);
  assert.equal(indexToTime(rows, 11, H), T0 + 11 * H);
  assert.equal(indexToTime(rows, -1, H), T0 - H);
  assert.equal(timeToIndex([], 1, H), null);
  assert.equal(timeToIndex(rows, 'x', H), null);
  for (const f of [0, 2.25, 9, 10.5]) assert.equal(timeToIndex(rows, indexToTime(rows, f, H), H), f);
});

test('duration labels', () => {
  assert.equal(formatDuration(45 * 60_000), '45m');
  assert.equal(formatDuration(3 * H + 20 * 60_000), '3h 20m');
  assert.equal(formatDuration(2 * H), '2h');
  assert.equal(formatDuration(26 * H), '1d 2h');
  assert.equal(formatDuration(-2 * H), '2h');
});

test('measure reports price, pips, percent, bars and time', () => {
  const m = measureBetween({ ts: T0 + H, price: 100 }, { ts: T0 + 5 * H, price: 104 }, { pip: 0.5, timeframe: '1h', rows });
  assert.deepEqual([m.priceDelta, m.pips, m.pct, m.bars, m.up, m.durationLabel], [4, 8, 4, 4, true, '4h']);
  const down = measureBetween({ ts: T0 + 5 * H, price: 104 }, { ts: T0 + H, price: 100 }, { pip: 1, timeframe: '1h' });
  assert.equal(down.up, false);
  assert.equal(down.bars, -4);
  assert.equal(measureBetween(null, { ts: 1, price: 1 }), null);
  assert.equal(measureBetween({ ts: 1, price: 0 }, { ts: 2, price: 1 }), null);
});

test('risk reward: long, short, sizing and invalid placement', () => {
  const long = riskReward({ entry: 100, stop: 98, target: 106, accountSize: 10000, riskPct: 1, pip: 0.5 });
  assert.deepEqual([long.valid, long.side, long.rr, long.riskPips, long.rewardPips, long.riskAmount, long.units, long.potentialProfit], [true, 'long', 3, 4, 12, 100, 50, 300]);
  assert.equal(long.notional, 5000);
  const short = riskReward({ entry: 100, stop: 103, target: 94 });
  assert.deepEqual([short.valid, short.side, short.rr, short.units], [true, 'short', 2, null]);
  const bad = riskReward({ side: 'long', entry: 100, stop: 101, target: 105 });
  assert.equal(bad.valid, false);
  assert.match(bad.issues[0], /stop must sit below/);
  assert.equal(riskReward({ entry: 0, stop: 1, target: 2 }).valid, false);
  assert.equal(riskReward({ entry: 100, stop: 100, target: 105 }).valid, false);
});

test('default position uses ATR when known, otherwise 1 percent, and snaps to the pip', () => {
  assert.deepEqual(defaultPosition('long', 100, { pip: 0.5 }), { side: 'long', entry: 100, stop: 99, target: 102 });
  assert.deepEqual(defaultPosition('short', 100, { pip: 0.5 }), { side: 'short', entry: 100, stop: 101, target: 98 });
  assert.deepEqual(defaultPosition('long', 100, { pip: 0.5, atr: 2 }), { side: 'long', entry: 100, stop: 97, target: 106 });
  assert.equal(defaultPosition('long', 0), null);
  const flat = Array.from({ length: 20 }, (_, i) => [i, 10, 11, 9, 10, 1]);
  assert.ok(Math.abs(atrOf(flat, 14) - 2) < 1e-9);
  assert.equal(atrOf(flat.slice(0, 5), 14), null);
});

test('fibonacci levels run from the second anchor back to the first', () => {
  const lv = fibLevels(100, 200);
  assert.equal(lv[0].price, 200);
  assert.equal(lv.find((l) => l.ratio === 0.5).price, 150);
  assert.equal(lv.find((l) => l.ratio === 1).price, 100);
  assert.ok(Math.abs(lv.find((l) => l.ratio === 0.618).price - 138.2) < 1e-9);
  assert.deepEqual(fibLevels(100, 100), []);
});

test('alerts fire once, only on a real cross, in the right direction', () => {
  const up = createAlert({ price: 105, lastPrice: 100, now: 1 });
  const down = createAlert({ price: 95, lastPrice: 100, now: 1 });
  assert.deepEqual([up.direction, down.direction], ['above', 'below']);
  assert.equal(createAlert({ price: 100, lastPrice: 100 }), null);
  assert.equal(createAlert({ price: -1, lastPrice: 100 }), null);
  const list = [up, down];
  assert.equal(evaluateAlerts(list, 100, 101, 5).alerts, list, 'no cross keeps array identity');
  assert.equal(evaluateAlerts(list, null, 106, 5).fired.length, 0, 'needs a previous observation');
  const r = evaluateAlerts(list, 104, 106, 9);
  assert.deepEqual(r.fired.map((a) => a.id), [up.id]);
  assert.equal(r.alerts[0].triggeredAt, 9);
  assert.equal(r.alerts[0].triggeredPrice, 106);
  assert.equal(evaluateAlerts(r.alerts, 104, 106, 10).fired.length, 0, 'fires once');
  assert.deepEqual(evaluateAlerts(list, 96, 94, 9).fired.map((a) => a.id), [down.id]);
  assert.equal(evaluateAlerts(list, 96, 100, 9).fired.length, 0, 'touching only from the wrong side does not fire');
});

test('drawings and alerts are validated on load and never repaired by guessing', () => {
  const ok = sanitizeDrawings([
    { id: 'a', kind: 'hline', price: 10 }, { id: 'b', kind: 'trend', t1: 1, p1: 2, t2: 3, p2: 4 },
    { id: 'c', kind: 'rr', side: 'long', t: 1, entry: 10, stop: 9, target: 12 }, { id: 'f', kind: 'fib', t1: 1, p1: 2, t2: 3, p2: 4 },
    { id: 'x', kind: 'hline', price: -1 }, { id: 'y', kind: 'nope' }, { kind: 'hline', price: 5 }, null, { id: 'z', kind: 'trend', t1: 1, p1: 'q', t2: 3, p2: 4 },
    { id: 'g', kind: 'fib', t1: 1, p1: 5, t2: 3, p2: 5 }
  ]);
  assert.deepEqual(ok.map((d) => d.id), ['a', 'b', 'c', 'f']);
  assert.deepEqual(sanitizeDrawings('nope'), []);
  const al = sanitizeAlerts([{ id: 'q', price: 5, direction: 'above', createdAt: 1 }, { id: 'r', price: 5, direction: 'sideways', createdAt: 1 }, { id: 's', price: 'x', direction: 'below', createdAt: 1 }]);
  assert.deepEqual(al.map((a) => a.id), ['q']);
  assert.equal(al[0].triggeredAt, null);
  assert.equal(drawingsKey('bitget', 'futures', 'BTC/USDT'), 'jpti.chart.drawings.v2:bitget|futures|BTC/USDT');
});

test('storage helpers survive blocked or corrupt storage', () => {
  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(saveJson(store, 'k', { a: 1 }), true);
  assert.deepEqual(loadJson(store, 'k', null), { a: 1 });
  mem.set('bad', '{nope');
  assert.deepEqual(loadJson(store, 'bad', []), []);
  assert.equal(saveJson({ setItem() { throw new Error('quota'); } }, 'k', 1), false);
  assert.equal(loadJson({ getItem() { throw new Error('blocked'); } }, 'k', 'fb'), 'fb');
  assert.equal(loadJson(null, 'k', 'fb'), 'fb');
});

test('replay starts back from the end, steps, stops at the last candle and slices without mutating', () => {
  assert.equal(replayStart(20), null);
  const s = replayStart(200, 60);
  assert.deepEqual([s.active, s.index, s.playing, s.speed], [true, 139, false, 1]);
  assert.equal(replayStart(40, 60).index, 29);
  const playing = { ...s, playing: true, index: 198 };
  const a = replayStep(playing, 200, 1);
  assert.deepEqual([a.index, a.playing], [199, false]);
  assert.equal(replayStep(s, 200, -500).index, 29);
  const all = Array.from({ length: 200 }, (_, i) => [i]);
  assert.equal(replaySlice(all, s).length, 140);
  assert.equal(replaySlice(all, null), all);
  assert.equal(replaySlice(all, { active: false }), all);
  assert.deepEqual([replayIntervalMs(1), replayIntervalMs(10), replayIntervalMs(7)], [1000, 100, 1000]);
});
