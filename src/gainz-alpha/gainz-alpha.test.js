import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, splitClosed, emaSeries, rsiValue, atrSeries, macdValue, relativeVolume, findSwings, equalLevels, fairValueGaps, structureEvents, timeframeMs } from './indicators.js';
import { analyzeGainzAlpha, advance, canTransition, toAlphaEvidence } from './engine.js';
import { PRESETS } from './presets.js';
import { evaluateOutcome, summarize, adaptModel, rollbackModel, createModel, falseSignalReport, wilsonInterval, MIN_SAMPLE } from './learning.js';
import { detectCollisions } from './collision.js';
import { createHub, validateEvent, migrate, diagnose } from './hub.js';
import { runBacktest, walkForward } from './backtest.js';

const base = Date.UTC(2026, 10, 10, 8, 0, 0), TF = 60000;
function build(dir = 1, noise = 0) {
  const rows = []; let p = 100;
  for (let i = 0; i < 90; i++) { const o = p, cl = 100 + Math.sin(i / 3) * 0.6 + noise * Math.sin(i * 1.7); rows.push([base + i * TF, o, Math.max(o, cl) + 0.25, Math.min(o, cl) - 0.25, cl, 1000 + (i % 4) * 50]); p = cl; }
  const lo = Math.min(...rows.slice(-25).map((r) => r[3])), hi = Math.max(...rows.slice(-25).map((r) => r[2])), prev = rows[rows.length - 1][4];
  let i = rows.length;
  if (dir > 0) { rows.push([base + i * TF, prev, prev + 0.1, lo - 0.5, lo + 0.3, 2500]); i++; rows.push([base + i * TF, lo + 0.3, lo + 2.4, lo + 0.25, lo + 2.3, 3500]); }
  else { rows.push([base + i * TF, prev, hi + 0.5, prev - 0.1, hi - 0.3, 2500]); i++; rows.push([base + i * TF, hi - 0.3, hi - 0.25, hi - 2.4, hi - 2.3, 3500]); }
  return rows;
}
const nowOf = (rows) => rows[rows.length - 1][0] + TF;
const run = (rows, o = {}) => analyzeGainzAlpha(rows, { symbol: 'BTC/USDT', timeframe: '1m', now: nowOf(rows), ...o });

test('normalizeCandles drops invalid rows, sorts and de-duplicates', () => {
  const out = normalizeCandles([[2000, 1, 2, 0.5, 1.5, 10], [1000, 1, 2, 0.5, 1.5, 10], [1000, 1, 2, 0.5, 1.6, 11], [3000, 5, 4, 1, 2, 1], ['x'], null, [4000, 1, 2, 0.5, NaN, 1]]);
  assert.deepEqual(out.map((r) => r[0]), [1000, 2000]);
  assert.equal(out[0][4], 1.6);
});
test('timeframeMs parses known frames and rejects unknown', () => { assert.equal(timeframeMs('15m'), 900000); assert.equal(timeframeMs('4h'), 14400000); assert.equal(timeframeMs('weird'), null); });
test('splitClosed excludes the forming candle', () => {
  const rows = [[0, 1, 2, 0.5, 1, 1], [60000, 1, 2, 0.5, 1, 1], [120000, 1, 2, 0.5, 1, 1]];
  const s = splitClosed(rows, '1m', 150000);
  assert.equal(s.closed.length, 2); assert.equal(s.forming[0], 120000);
});
test('EMA, RSI, ATR, MACD, relative volume are correct and finite', () => {
  assert.deepEqual(emaSeries([1, 1, 1], 3), [1, 1, 1]);
  assert.equal(rsiValue(Array.from({ length: 30 }, (_, i) => i)), 100);
  assert.equal(rsiValue([1, 2, 3]), null);
  const rows = Array.from({ length: 40 }, (_, i) => [i, 10, 11, 9, 10, 100]);
  assert.equal(atrSeries(rows, 14)[39], 2);
  assert.ok(Number.isFinite(macdValue(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3))).histogram));
  assert.equal(relativeVolume([...Array.from({ length: 20 }, () => [0, 1, 1, 1, 1, 100]), [0, 1, 1, 1, 1, 300]]), 3);
});
test('swing detection only reports confirmed pivots and equal highs cluster', () => {
  const r = (h, l) => [0, (h + l) / 2, h, l, (h + l) / 2, 1];
  const rows = [r(5, 4), r(6, 5), r(7, 6), r(10, 8), r(7, 6), r(6, 5), r(5, 4), r(6, 5), r(7, 6), r(10.01, 8), r(7, 6), r(6, 5), r(5, 4)];
  const s = findSwings(rows, 3);
  assert.equal(s.highs.length, 2); assert.ok(s.highs.every((x) => x.confirmedAt === x.index + 3));
  assert.equal(equalLevels(s.highs, 0.05).length, 1);
});
test('FVG detection, mitigation and fill percentage', () => {
  const rows = [[0, 10, 11, 9, 10, 1], [1, 10, 14, 10, 14, 1], [2, 14, 16, 13, 15, 1], [3, 15, 15, 12, 12, 1]];
  const g = fairValueGaps(rows)[0];
  assert.equal(g.direction, 'bullish'); assert.equal(g.bottom, 11); assert.equal(g.top, 13);
  assert.equal(g.status, 'mitigated'); assert.equal(g.fillPct, 50);
});
test('BOS then CHoCH are classified from confirmed swings', () => {
  const rows = []; const px = [10, 11, 12, 13, 12, 11, 10, 11, 12, 13, 14, 15, 14, 13, 12, 11, 10, 9, 8, 7, 8];
  px.forEach((p, i) => rows.push([i, p, p + 0.4, p - 0.4, p, 1]));
  const ev = structureEvents(rows, findSwings(rows, 2)).events;
  assert.ok(ev.some((e) => e.kind === 'BOS' && e.direction === 'bullish'));
  assert.ok(ev.some((e) => e.kind === 'CHoCH' && e.direction === 'bearish'));
});

test('setup state machine allows legal and rejects illegal transitions', () => {
  assert.equal(advance('IDLE', 'LIQUIDITY_IDENTIFIED'), 'LIQUIDITY_IDENTIFIED');
  assert.throws(() => advance('IDLE', 'ENTRY_READY'), /Illegal/);
  assert.throws(() => advance('INVALIDATED', 'ACTIVE'), /Illegal/);
  assert.ok(canTransition('ENTRY_READY', 'ACTIVE')); assert.ok(!canTransition('EXPIRED', 'ENTRY_READY'));
});

test('bearish sweep -> reclaim -> displacement produces an ENTRY_READY SELL with coherent risk plan', () => {
  const rows = build(-1), r = run(rows, { preset: 'balanced' });
  assert.equal(r.status, 'ready'); assert.equal(r.signal, 'SELL'); assert.equal(r.stage, 'ENTRY_READY');
  assert.equal(r.setup.sweep.side, 'buy-side'); assert.ok(r.setup.trace.map((t) => t.state).includes('DISPLACEMENT_CONFIRMED'));
  const p = r.riskPlan; assert.ok(p.stopLoss > p.entry && p.takeProfit1 < p.entry && p.takeProfit2 < p.takeProfit1); assert.ok(p.rr1 >= PRESETS.balanced.minRR);
  assert.equal(p.authorizesOrder, false); assert.ok(r.explanation.positives.some((x) => /swept/.test(x)));
});
test('bullish setup is detected with the mirrored stages and BUY gating', () => {
  const rows = build(1), r = run(rows, { preset: 'balanced', overrides: { maxStopAtr: 9 } });
  assert.equal(r.setup.sweep.side, 'sell-side'); assert.equal(r.setup.direction, 1);
  assert.equal(r.signal, 'BUY'); assert.ok(r.riskPlan.stopLoss < r.riskPlan.entry && r.riskPlan.takeProfit1 > r.riskPlan.entry);
});
test('presets change behaviour: alpha demands HTF data, precision demands full confirmations', () => {
  const rows = build(-1);
  assert.equal(run(rows, { preset: 'balanced' }).signal, 'SELL');
  const a = run(rows, { preset: 'alpha' }); assert.equal(a.signal, 'WAIT'); assert.ok(a.blockers.some((b) => /higher-timeframe/.test(b)));
  assert.notDeepEqual(PRESETS.scalp.expireBars, PRESETS.swing.expireBars);
  assert.ok(PRESETS.precision.minConfluence > PRESETS.balanced.minConfluence);
});
test('higher timeframe opposition blocks the Alpha preset; fresh agreeing HTF allows it; stale HTF is ignored', () => {
  const rows = build(-1), tfH = 3600e3;
  const mk = (dir, startHrsAgo = 120) => Array.from({ length: 120 }, (_, i) => { const ts = nowOf(rows) - (120 - i) * tfH - tfH; const c = 100 + dir * i * 0.4; return [ts, c - dir * 0.1, c + 0.3, c - 0.3, c, 1000]; });
  const down = run(rows, { preset: 'alpha', higherTimeframes: [{ timeframe: '1h', candles: mk(-1) }, { timeframe: '4h', candles: mk(-1).map((c) => [c[0] - 0, ...c.slice(1)]) }] });
  const up = run(rows, { preset: 'alpha', higherTimeframes: [{ timeframe: '1h', candles: mk(1) }] });
  assert.ok(up.blockers.some((b) => /opposes/.test(b)) || up.blockers.some((b) => /missing|stale/.test(b)));
  assert.ok(down.htf.some((h) => h.status === 'fresh' && h.bias < 0));
  const stale = run(rows, { preset: 'alpha', higherTimeframes: [{ timeframe: '1h', candles: mk(-1).map((c) => [c[0] - 90 * tfH, ...c.slice(1)]) }] });
  assert.ok(stale.htf.every((h) => h.status === 'stale'));
});
test('breakout without reclaim is not classified as a sweep and does not fire a counter signal', () => {
  const rows = build(-1).slice(0, 90); const hi = Math.max(...rows.slice(-25).map((r) => r[2]));
  for (let k = 0; k < 6; k++) { const i = rows.length, c = hi + 0.5 + k * 0.4; rows.push([base + i * TF, c - 0.3, c + 0.3, c - 0.4, c, 3000]); }
  const r = run(rows, { preset: 'precision' });
  assert.ok(!(r.setup && r.setup.direction === -1 && r.setup.state === 'ENTRY_READY'));
  assert.notEqual(r.signal, 'SELL');
});
test('micro-pokes through a range extreme (<0.2 ATR) are noise, not sweeps; trend is not fought by unconfirmed setups', () => {
  const c = Array.from({ length: 240 }, (_, i) => { const cl = 100 + i * 0.16 + Math.sin(i / 3) * 0.35; return [base + i * 3600e3, cl - 0.08, cl + 0.45, cl - 0.45, cl, 1000 + (i % 15) * 80]; });
  const r = analyzeGainzAlpha(c, { symbol: 'B', timeframe: '1h', now: base + 240 * 3600e3 + 5000 });
  assert.ok(!r.setup || r.setup.sweep.depthAtr >= 0.2);
  const liq = r.factors.find((f) => f.key === 'liquidity').value;
  assert.ok(liq >= -0.15, 'liquidity factor must not be strongly bearish in a clean uptrend, got ' + liq);
  assert.ok(r.score > 0.2, 'clean uptrend should score bullish, got ' + r.score);
});
test('stale setups expire and no longer produce signals', () => {
  const rows = build(-1), oldSweepTs = rows[rows.length - 2][0];
  for (let k = 0; k < 20; k++) { const i = rows.length, c = rows[i - 1][4] - 0.02; rows.push([base + i * TF, rows[i - 1][4], c + 0.15, c - 0.15, c, 900]); }
  const r = run(rows, { preset: 'precision' });
  assert.ok(!r.setup || r.setup.sweep.ts !== oldSweepTs, 'the 20-bar-old setup must not be the active one');
  assert.notEqual(r.signal, 'SELL');
  const direct = run(rows.slice(0, 95), { preset: 'balanced' }); // 3 bars after displacement: still live
  assert.ok(direct.setup && direct.setup.sweep.ts === oldSweepTs && direct.setup.expiresInBars > 0);
});
test('setup invalidates when price closes beyond the sweep extreme', () => {
  const rows = build(-1), hiExt = rows[rows.length - 2][2];
  const i = rows.length; rows.push([base + i * TF, rows[i - 1][4], hiExt + 1.5, rows[i - 1][4], hiExt + 1, 2000]);
  const r = run(rows);
  assert.ok(!r.setup || r.setup.state === 'INVALIDATED' || r.setup.direction !== -1 || r.signal !== 'SELL');
});
test('forming candle never alters the confirmed result; preview is provisional', () => {
  const rows = build(-1), closedNow = nowOf(rows);
  const forming = [closedNow, 95, 105, 90, 104, 9999];
  const withForming = [...rows, forming];
  const a = analyzeGainzAlpha(rows, { symbol: 'X', timeframe: '1m', now: closedNow + 1000 });
  const b = analyzeGainzAlpha(withForming, { symbol: 'X', timeframe: '1m', now: closedNow + 1000 });
  assert.equal(b.forming, closedNow); delete b.forming; delete a.forming;
  assert.deepEqual(a, b);
  const p = analyzeGainzAlpha(withForming, { symbol: 'X', timeframe: '1m', now: closedNow + 1000, mode: 'preview' });
  assert.equal(p.provisional, true); assert.equal(p.confirmed, false); assert.equal(p.asOf, closedNow);
});
test('no repainting: appending future candles leaves an earlier analysis identical', () => {
  const rows = build(-1), early = run(rows);
  const longer = [...rows]; for (let k = 0; k < 5; k++) { const i = longer.length; longer.push([base + i * TF, 90, 91, 89, 90, 1000]); }
  const again = analyzeGainzAlpha(longer.slice(0, rows.length), { symbol: 'BTC/USDT', timeframe: '1m', now: nowOf(rows) });
  assert.deepEqual(early, again);
});
test('deterministic: identical input yields identical output', () => { const rows = build(-1); assert.deepEqual(run(rows), run(rows)); });
test('insufficient or invalid data yields WAIT, never a forced signal', () => {
  assert.equal(run([[1, 1, 1, 1, 1, 1]]).status, 'insufficient');
  assert.equal(analyzeGainzAlpha(null, { now: 1 }).signal, 'WAIT'); assert.equal(analyzeGainzAlpha(undefined, { now: 1 }).status, 'insufficient');
});
test('flat market returns NEUTRAL/WAIT', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [base + i * TF, 100, 100.2, 99.8, 100 + (i % 2 ? 0.01 : -0.01), 1000]);
  const r = run(rows); assert.ok(['NEUTRAL', 'WAIT'].includes(r.signal));
});
test('symbol and timeframe are isolated in expectancy', () => {
  const rows = build(-1), mkRecs = (sym, tf) => Array.from({ length: 40 }, (_, i) => ({ symbol: sym, timeframe: tf, preset: 'balanced', setupType: 'sweep-reclaim-displacement', direction: 'bearish', outcome: 'win', returnR: 1, confidence: 60 }));
  assert.equal(run(rows, { outcomes: mkRecs('ETH/USDT', '1m') }).expectancy.n, 0);
  assert.equal(run(rows, { outcomes: mkRecs('BTC/USDT', '5m') }).expectancy.n, 0);
  assert.equal(run(rows, { outcomes: mkRecs('BTC/USDT', '1m') }).expectancy.n, 40);
});
test('confidence is labelled heuristic until calibrated by enough outcomes', () => {
  const rows = build(-1); const r = run(rows);
  assert.match(r.confidenceNote, /not a win probability/); assert.equal(r.calibration.calibrated, false);
  const recs = Array.from({ length: 60 }, (_, i) => ({ symbol: 'BTC/USDT', timeframe: '1m', preset: 'balanced', setupType: 'x', direction: 'bearish', outcome: i % 2 ? 'win' : 'loss', returnR: i % 2 ? 1 : -1, confidence: r.confidence }));
  const c = run(rows, { outcomes: recs }); assert.ok(c.calibration.calibrated || c.confidence !== r.confidence);
});
test('duplicate setup and cooldown suppress repeated signals', () => {
  const rows = build(-1), first = run(rows);
  const again = run(rows, { recentSignals: [{ setupId: first.setupId, direction: 'SELL', symbol: 'BTC/USDT', timeframe: '1m', candleTs: first.asOf }] });
  assert.notEqual(again.signal, 'SELL'); assert.ok(again.blockers.some((b) => /duplicate/.test(b)));
});
test('Alpha evidence maps direction, expectancy and suppresses invalidated setups', () => {
  const ev = toAlphaEvidence(run(build(-1)));
  assert.equal(ev.available, true); assert.equal(ev.direction, -1); assert.ok(ev.suggestedWeight > 0);
  assert.equal(toAlphaEvidence({ status: 'insufficient' }).available, false); assert.strictEqual(typeof ev.suppress, 'boolean');
  assert.equal(toAlphaEvidence({ ...run(build(-1)), signal: 'INVALIDATED' }).suggestedWeight, 0);
});

// ---- learning ----
const sig = (dir = 'BUY', stop = 99, tp = 102) => ({ signal: dir, riskPlan: { stopLoss: stop, takeProfit1: tp } });
const fc = (h, l, c = 100, o = 100) => [0, o, h, l, c, 1];
test('outcome: target hit is a win with positive R; stop hit is a loss; same-bar both is a loss', () => {
  const win = evaluateOutcome(sig(), [fc(100.5, 99.8), fc(102.5, 100.4)], { window: 2 });
  assert.equal(win.outcome, 'win'); assert.equal(win.returnR, 2);
  const loss = evaluateOutcome(sig(), [fc(100.5, 98.5)], { window: 1 }); assert.equal(loss.outcome, 'loss'); assert.equal(loss.returnR, -1); assert.equal(loss.falseSignal, true);
  assert.equal(evaluateOutcome(sig(), [fc(103, 98.5)], { window: 1 }).outcome, 'loss');
  assert.equal(evaluateOutcome(sig(), [fc(100.4, 99.8)], { window: 5 }).status, 'pending');
  assert.equal(evaluateOutcome(sig(), [fc(100.4, 99.8), fc(100.3, 99.9)], { window: 2 }).outcome, 'timeout');
  assert.equal(evaluateOutcome(sig('SELL', 101, 98), [fc(100.2, 97.5)], { window: 1 }).outcome, 'win');
});
test('summarize computes expectancy, profit factor, drawdown, streaks and honest reliability', () => {
  const rows = [1, 1, -1, -1, -1, 2].map((r) => ({ returnR: r, outcome: r > 0 ? 'win' : 'loss', falseSignal: r < 0 }));
  const s = summarize(rows, {});
  assert.equal(s.n, 6); assert.equal(s.wins, 3); assert.equal(s.expectancy, 0.167); assert.equal(s.profitFactor, 1.333); assert.equal(s.maxConsecutiveLosses, 3); assert.equal(s.maxDrawdownR, 3); assert.equal(s.reliable, false); assert.equal(s.status, 'insufficient');
  const w = wilsonInterval(5, 10); assert.ok(w.low < 0.5 && w.high > 0.5);
});
test('adaptive learning: guarded steps, minimum sample, versioning, rollback, no single-trade shock', () => {
  const m = createModel();
  assert.equal(adaptModel(m, [{ returnR: 5, factors: { trend: 1 }, candleTs: 1 }]).changed, false);
  const rec = (i) => ({ returnR: i % 2 ? 3 : -1, factors: { trend: i % 2 ? 1 : 0, volume: 0.1 }, falseSignal: i % 2 === 0, candleTs: i });
  const rows = Array.from({ length: 120 }, (_, i) => rec(i));
  const r = adaptModel(m, rows);
  assert.equal(r.changed, true); assert.equal(r.model.version, 2);
  assert.ok(r.model.weights.trend > 1 && r.model.weights.trend <= 1.05); assert.equal(r.model.weights.volume, undefined);
  let cur = r.model; for (let k = 0; k < 40; k++) cur = adaptModel(cur, rows).model;
  assert.ok(cur.weights.trend <= 1.4 && cur.weights.trend >= 0.6);
  const outlier = adaptModel(m, [...rows, { returnR: 9999, factors: { trend: 1 }, candleTs: 999 }]);
  assert.ok(outlier.model.weights.trend <= 1.05);
  const back = rollbackModel(r.model); assert.equal(back.rolledBack, true); assert.deepEqual(back.model.weights, {});
});
test('adaptive learning ignores missing factor observations instead of treating them as negative evidence', () => {
  const rows=[...Array.from({length:10},(_,i)=>({returnR:1,factors:{trend:1},candleTs:i})),...Array.from({length:10},(_,i)=>({returnR:-1,factors:{trend:0},candleTs:i+10})),...Array.from({length:10},(_,i)=>({returnR:5,factors:{volume:1},candleTs:i+20})),...Array.from({length:10},(_,i)=>({returnR:5,factors:{trend:null},candleTs:i+30}))];
  const result=adaptModel(createModel(),rows,{minSample:10});assert.ok(result.model.weights.trend>1);assert.equal(result.n,40);
  assert.equal(adaptModel(createModel(),[{returnR:null,factors:{trend:1}}],{minSample:1}).n,0);
});
test('false-signal report flags overtrading clusters', () => {
  const recs = [0, 1, 2, 3].map((i) => ({ symbol: 'A', timeframe: '1m', candleTs: i * 60000, tfMs: 60000, falseSignal: true, session: 'asia', setupType: 'c', direction: 'bullish' }));
  const r = falseSignalReport(recs); assert.equal(r.overall, 1); assert.ok(r.overtradingClusters >= 2);
});

// ---- collisions ----
test('collision detection classifies severity and never resolves CRITICAL by score', () => {
  const a = { source: 'alpha', symbol: 'BTC', timeframe: '5m', direction: 'BUY', candleTs: 1, confirmed: true }, b = { source: 'gainz', symbol: 'BTC', timeframe: '5m', direction: 'SELL', candleTs: 1, confirmed: true };
  const r = detectCollisions([a, b]); assert.equal(r.worst, 'CRITICAL'); assert.equal(r.resolution, 'stand-aside'); assert.equal(r.blocksSignal, true);
  assert.equal(detectCollisions([{ ...a, timeframe: '1m' }, { ...b, timeframe: '1h', candleTs: 9 }]).worst, 'HIGH');
  assert.equal(detectCollisions([{ ...a, symbol: 'ETH' }, b]).conflicts.length, 0);
  assert.equal(detectCollisions([{ ...a, setupId: 's', chartId: 1 }, { ...a, setupId: 's', chartId: 2 }]).worst, 'LOW');
  assert.equal(detectCollisions([{ ...a, setupDirection: 'bearish' }]).worst, 'HIGH');
});

// ---- hub ----
const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), m }; };
test('hub shares one engine run across chart instances and cleans up subscriptions', () => {
  const rows = build(-1), t = nowOf(rows); const hub = createHub({ now: () => t });
  const got = []; hub.subscribe('chart-2', 'ex|BTC/USDT|1m', (o) => got.push(o)); assert.equal(hub.listenerCount(), 1);
  const a = hub.ingest({ chartId: 'chart-1', exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  const b = hub.ingest({ chartId: 'chart-2', exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  assert.equal(a.fresh, true); assert.equal(b.fresh, false); assert.equal(b.confirmed, a.confirmed); assert.equal(got.length, 1);
  hub.release('chart-2'); assert.equal(hub.listenerCount(), 0);
});
test('hub emits validated, de-duplicated events and records each signal once', () => {
  const rows = build(-1), t = nowOf(rows); const hub = createHub({ now: () => t }); const seen = [];
  hub.onEvent((e) => seen.push(e));
  for (let k = 0; k < 3; k++) hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  const signals = seen.filter((e) => e.type === 'GAINZ_ALPHA_SIGNAL'); assert.equal(signals.length, 1);
  assert.ok(seen.every((e) => validateEvent(e).ok)); assert.equal(new Set(seen.map((e) => e.id)).size, seen.length);
  assert.ok(seen.some((e) => e.type === 'GAINZ_ALPHA_SWEEP') && seen.some((e) => e.type === 'GAINZ_ALPHA_DISPLACEMENT'));
  assert.equal(hub.getState().pending.length, 1); assert.equal(validateEvent({ type: 'BAD' }).ok, false);
});
test('hub: symbol/timeframe contexts do not contaminate each other', () => {
  const rows = build(-1), t = nowOf(rows); const hub = createHub({ now: () => t });
  hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  const eth = hub.ingest({ exchange: 'ex', symbol: 'ETH/USDT', timeframe: '1m', candles: rows });
  assert.equal(eth.confirmed.symbol, 'ETH/USDT'); assert.equal(eth.confirmed.signal, 'SELL');
  assert.equal(hub.getState().pending.length, 2);
});
test('hub: preview is provisional, never recorded; confirmed signal flows to outcome tracking and learning', () => {
  const rows = build(-1); let t = nowOf(rows); const hub = createHub({ now: () => t, learnEvery: 1 });
  const first = hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: [...rows, [t, 95, 96, 94, 95, 10]] });
  assert.equal(first.preview.provisional, true); assert.equal(hub.getState().outcomes.length, 0);
  const plan = hub.getState().pending[0].riskPlan;
  const future = [];
  for (let k = 0; k < 25; k++) { const i = rows.length + k, c = plan.takeProfit1 - k * 0.01; future.push([base + i * TF, c + 0.05, k === 3 ? plan.takeProfit1 - 0.5 : c + 0.1, c - 0.1, c, 1000]); }
  t = base + (rows.length + 26) * TF;
  hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: [...rows, ...future] });
  const out = hub.getState().outcomes; assert.equal(out.length, 1); assert.ok(['win', 'loss', 'timeout'].includes(out[0].outcome));
  assert.ok(hub.events().some((e) => e.type === 'GAINZ_ALPHA_OUTCOME')); assert.ok(hub.events().some((e) => e.type === 'GAINZ_ALPHA_LEARNING_UPDATE'));
});
test('hub adaptive model learns from the shared outcome pool across symbol/timeframe contexts', () => {
  const rows=build(-1);let t=nowOf(rows);const hub=createHub({now:()=>t,learnEvery:1});
  hub.ingest({exchange:'ex',symbol:'BTC/USDT',timeframe:'1m',candles:[...rows,[t,95,96,94,95,10]]});
  const state=hub.getState();state.outcomes.push(...Array.from({length:30},(_,i)=>({id:'other-market-'+i,symbol:i%2?'ETH/USDT':'SOL/USDT',timeframe:i%2?'5m':'1h',candleTs:i+1,outcome:i%2?'win':'loss',returnR:i%2?2:-1,factors:{trend:i%2?1:0},falseSignal:i%2===0})));
  const plan=state.pending[0].riskPlan,future=[];
  for(let k=0;k<25;k++){const i=rows.length+k,close=plan.takeProfit1-k*.01;future.push([base+i*TF,close+.05,k===3?plan.takeProfit1-.5:close+.1,close-.1,close,1000]);}
  t=base+(rows.length+26)*TF;hub.ingest({exchange:'ex',symbol:'BTC/USDT',timeframe:'1m',candles:[...rows,...future]});
  assert.ok(hub.getState().model.version>1);assert.equal(updates,1);
});
test('remote D1 outcome history reconstructs a first adaptive model on a fresh device', async () => {
  const hub=createHub();let updates=0;hub.onSettingsChange(()=>updates++);
  const records=Array.from({length:60},(_,i)=>({id:'remote-'+i,symbol:i%2?'ETH/USDT':'BTC/USDT',timeframe:'15m',preset:'balanced',setupType:'confluence',direction:'bullish',session:'london',regime:'trend',volRegime:'normal',candleTs:i+1,outcome:i<35?'win':'loss',returnR:i<35?1.5:-1,falseSignal:i>=35,factors:{trend:i<35?1:0,volume:i%3?1:0}}));
  const result=await hub.attachRemote({async load(){return records;},async save(){return {saved:0};}});
  assert.equal(result.ok,true);assert.equal(hub.getState().outcomes.length,60);assert.ok(hub.getState().model.version>1);assert.ok(updates>0);
});
test('manual journal outcomes enter the shared hub once and are eligible for adaptive learning', () => {
  const hub=createHub({learnEvery:1}), state=hub.getState();let updates=0;hub.onSettingsChange(()=>updates++);
  state.outcomes.push(...Array.from({length:30},(_,i)=>({id:'prior-'+i,symbol:i%2?'ETH/USDT':'SOL/USDT',timeframe:'15m',candleTs:i+1,outcome:i%2?'win':'loss',returnR:i%2?1.5:-1,factors:{trend:i%2?1:0}})));
  const record={id:'manual-journal-1',symbol:'BTC/USDT',exchange:'bitget',timeframe:'15m',direction:'bullish',outcome:'win',returnR:1.25,candleTs:100000,factors:{sweep:1,displacement:1}};
  const saved=hub.recordOutcome(record,{sync:false});
  assert.equal(saved.ok,true);assert.equal(saved.duplicate,false);assert.equal(hub.getState().outcomes.length,31);
  const duplicate=hub.recordOutcome(record,{sync:false});assert.equal(duplicate.duplicate,true);assert.equal(hub.getState().outcomes.length,31);
  assert.ok(hub.getState().model.version>1);
});
test('hub persistence, migration, graceful storage failure, settings import/export', () => {
  const st = memStorage(), rows = build(-1), t = nowOf(rows); const hub = createHub({ storage: st, now: () => t });
  hub.updateSettings({ preset: 'precision', overlays: { fvg: false } }); hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  const again = createHub({ storage: st, now: () => t });
  assert.equal(again.getSettings().preset, 'precision'); assert.equal(again.getSettings().overlays.fvg, false); assert.equal(again.status().loadedFromStorage, true);
  const bad = createHub({ storage: { getItem() { return '{not json'; }, setItem() { throw new Error('quota'); } } });
  assert.equal(bad.status().persistence.ok, false); bad.updateSettings({ preset: 'swing' }); assert.match(bad.status().persistence.error, /save failed/);
  const exp = hub.exportSettings(); const other = createHub(); assert.equal(other.importSettings(exp).ok, true); assert.equal(other.getSettings().preset, 'precision');
  assert.equal(other.importSettings('{"kind":"nope"}').ok, false);
  assert.equal(migrate({ outcomes: [{ a: 1 }] }).schema, 1); assert.equal(hub.updateSettings({ preset: 'bogus' }).preset, 'balanced');
});
test('diagnostics report each failing subsystem instead of a blanket ok', () => {
  const rows = build(-1), hub = createHub({ now: () => nowOf(rows) });
  const res = hub.ingest({ exchange: 'ex', symbol: 'BTC/USDT', timeframe: '1m', candles: rows });
  const d = hub.diagnose(res, { candleCount: rows.length, timeframe: '1m', symbol: 'BTC/USDT', lastCandleTs: rows.at(-1)[0], now: nowOf(rows), alphaConsumer: true, overlaysLoaded: true });
  assert.ok(d.failed.includes('persistence')); assert.notEqual(d.overall, 'operational'); assert.ok(d.checks.find((c) => c.id === 'engine-loaded').ok);
  assert.equal(diagnose({ status: 'insufficient', reason: 'x' }, {}).checks.find((c) => c.id === 'enough-history').ok, false);
});

// ---- backtest ----
function longSeries(n, seed = 7) {
  let s = seed, p = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, rows = [];
  for (let i = 0; i < n; i++) { const o = p, cl = Math.max(1, o + (rnd() - 0.5) * 1.4 + Math.sin(i / 17) * 0.15); rows.push([base + i * 3600e3, o, Math.max(o, cl) + rnd() * 0.5, Math.min(o, cl) - rnd() * 0.5, cl, 800 + rnd() * 600]); p = cl; }
  return rows;
}
test('backtest uses the live engine without lookahead and reports honest metrics', () => {
  const rows = longSeries(700), a = runBacktest(rows, { symbol: 'SYN', timeframe: '1h', preset: 'balanced', window: 250 });
  assert.equal(a.status, 'ok'); assert.equal(a.assumptions.lookahead, 'none');
  assert.deepEqual(a, runBacktest(rows, { symbol: 'SYN', timeframe: '1h', preset: 'balanced', window: 250 }));
  for (const t of a.trades) { assert.ok(['win', 'loss', 'timeout'].includes(t.outcome)); assert.ok(Number.isFinite(t.returnR)); }
  assert.equal(a.summary.n, a.trades.length);
  // Truncating future data must not change trades that completed before the cut.
  const cut = runBacktest(rows.slice(0, 500), { symbol: 'SYN', timeframe: '1h', preset: 'balanced', window: 250 });
  const early = a.trades.filter((t) => t.candleTs < rows[470][0]);
  assert.deepEqual(cut.trades.filter((t) => t.candleTs < rows[470][0]).map((t) => t.id), early.map((t) => t.id));
  assert.equal(runBacktest(rows, { timeframe: 'bogus' }).status, 'error');
});
test('walk-forward keeps parameters fixed and flags the final fold out-of-sample', () => {
  const w = walkForward(longSeries(700), { symbol: 'SYN', timeframe: '1h', preset: 'balanced', window: 250, folds: 3 });
  assert.equal(w.status, 'ok'); assert.equal(w.folds.length, 3); assert.equal(w.folds[2].role, 'out-of-sample');
  assert.equal(walkForward(longSeries(100), { folds: 3 }).status, 'insufficient');
});
test('MIN_SAMPLE guards learning', () => { assert.equal(MIN_SAMPLE, 30); });

test('hub remote sync: loads durable outcomes, merges without duplicates, flushes new ones, survives failures', async () => {
  const saved = [], remoteRecs = [{ id: 'old1', symbol: 'BTC/USDT', timeframe: '1m', candleTs: 5, outcome: 'win', returnR: 1 }];
  const adapter = { load: async () => remoteRecs, save: async (r) => { saved.push(...r); return { ok: true }; } };
  const hub = createHub({ now: () => 1e12 });
  const st = await hub.attachRemote(adapter, { symbol: 'BTC/USDT' });
  assert.equal(st.ok, true); assert.equal(st.added, 1); assert.equal(hub.getState().outcomes.length, 1);
  assert.equal((await hub.attachRemote(adapter)).added, 0); assert.equal(hub.getState().outcomes.length, 1);
  const bad = createHub(); const r = await bad.attachRemote({ load: async () => { throw new Error('offline'); }, save: async () => {} });
  assert.equal(r.ok, false); assert.match(r.error, /offline/);
  const d = bad.diagnose(null, { status: bad.status() }); assert.ok(d.failed.includes('backend-sync'));
});
test('Alpha context only carries outcomes for the exact symbol and timeframe', async () => {
  const { gainzAlphaContext } = await import('./context.js'); const { getHub } = await import('./hub.js');
  const hub = getHub(); hub.getState().outcomes.push({ id: 'c1', symbol: 'BTC/USDT', timeframe: '1h', candleTs: 1 }, { id: 'c2', symbol: 'ETH/USDT', timeframe: '1h', candleTs: 2 }, { id: 'c3', symbol: 'BTC/USDT', timeframe: '5m', candleTs: 3 });
  const c = gainzAlphaContext('btc/usdt', '1h'); assert.deepEqual(c.gainzOutcomes.map((r) => r.id), ['c1']); assert.ok(c.gainzPreset); assert.ok(c.gainzModel.version >= 1);
});
