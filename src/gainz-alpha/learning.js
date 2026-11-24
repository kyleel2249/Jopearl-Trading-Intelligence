// Outcome evaluation, expectancy statistics, false-signal tracking and guarded adaptive learning.
import { clamp, mean } from './indicators.js';

export const MIN_SAMPLE = 30;
export const MODEL_SCHEMA = 1;

export function createModel() {
  return { schema: MODEL_SCHEMA, version: 1, weights: {}, dispAdjust: 0, drift: { drifting: false }, history: [] };
}

export function wilsonInterval(wins, n, z = 1.96) {
  if (!n) return { low: null, high: null };
  const p = wins / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { low: Number(clamp(c - m, 0, 1).toFixed(4)), high: Number(clamp(c + m, 0, 1).toFixed(4)) };
}

const KEYS = ['symbol', 'timeframe', 'preset', 'setupType', 'direction', 'session', 'regime', 'volRegime'];
export const matches = (r, filter = {}) => KEYS.every((k) => filter[k] == null || String(r[k]).toLowerCase() === String(filter[k]).toLowerCase());

export function summarize(records, filter = {}, minSample = MIN_SAMPLE) {
  const rows = (Array.isArray(records) ? records : []).filter((r) => matches(r, filter) && r.returnR !== null && r.returnR !== undefined && r.returnR !== '' && Number.isFinite(Number(r.returnR)));
  const n = rows.length;
  const R = rows.map((r) => Number(r.returnR));
  const wins = rows.filter((r) => r.outcome === 'win'), losses = rows.filter((r) => r.outcome === 'loss');
  const grossWin = R.filter((v) => v > 0).reduce((s, v) => s + v, 0), grossLoss = -R.filter((v) => v < 0).reduce((s, v) => s + v, 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const r of rows) {
    eq += Number(r.returnR); peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = r.outcome === 'loss' ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
  }
  const ci = wilsonInterval(wins.length, n);
  const num = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(3)));
  return {
    n, wins: wins.length, losses: losses.length, minSample, reliable: n >= minSample, status: n >= minSample ? 'ready' : 'insufficient',
    winRate: n ? num(wins.length / n) : null, winRateLow: ci.low, winRateHigh: ci.high,
    avgWinR: num(mean(wins.map((r) => Number(r.returnR)))), avgLossR: num(mean(losses.map((r) => Number(r.returnR)))),
    expectancy: n ? num(mean(R)) : null, netR: num(R.reduce((s, v) => s + v, 0)),
    profitFactor: grossLoss > 0 ? num(grossWin / grossLoss) : grossWin > 0 ? null : null,
    avgMfeR: num(mean(rows.filter((r) => r.mfeR !== null && r.mfeR !== undefined && r.mfeR !== '').map((r) => Number(r.mfeR)).filter(Number.isFinite))), avgMaeR: num(mean(rows.filter((r) => r.maeR !== null && r.maeR !== undefined && r.maeR !== '').map((r) => Number(r.maeR)).filter(Number.isFinite))),
    avgBars: num(mean(rows.filter((r) => r.bars !== null && r.bars !== undefined && r.bars !== '').map((r) => Number(r.bars)).filter(Number.isFinite))), maxConsecutiveLosses: maxStreak, maxDrawdownR: num(dd),
    falseRate: n ? num(rows.filter((r) => r.falseSignal).length / n) : null
  };
}

/**
 * Forward evaluation on CLOSED candles after the signal candle. Entry is the next bar's open (no lookahead).
 * If stop and target are both touched inside one bar the stop wins (conservative).
 */
export function evaluateOutcome(signal, future, { window = 24, costPct = 0 } = {}) {
  const plan = signal?.riskPlan;
  if (!plan || !future?.length || !['BUY', 'SELL'].includes(signal.signal)) return { status: 'pending', reason: 'no-future-data' };
  const dir = signal.signal === 'BUY' ? 1 : -1, entry = future[0][1], stop = plan.stopLoss, tp = plan.takeProfit1;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return { status: 'resolved', outcome: 'loss', returnR: -1, mfeR: 0, maeR: -1, bars: 0, falseSignal: true, reason: 'entry-beyond-stop' };
  const cost = (entry * costPct) / risk;
  let mfe = 0, mae = 0, exit = null, outcome = null, bars = 0;
  const horizon = Math.min(window, future.length);
  for (let k = 0; k < horizon; k++) {
    const c = future[k]; bars = k + 1;
    const fav = ((dir === 1 ? c[2] : c[3]) - entry) * dir / risk, adv = ((dir === 1 ? c[3] : c[2]) - entry) * dir / risk;
    const stopHit = dir === 1 ? c[3] <= stop : c[2] >= stop, tpHit = dir === 1 ? c[2] >= tp : c[3] <= tp;
    mae = Math.min(mae, adv);
    if (stopHit) { exit = stop; outcome = 'loss'; break; }
    if (tpHit) { mfe = Math.max(mfe, fav); exit = tp; outcome = 'win'; break; }
    mfe = Math.max(mfe, fav);
  }
  if (!outcome) {
    if (future.length < window) return { status: 'pending', reason: 'window-open', bars: future.length };
    exit = future[horizon - 1][4]; outcome = 'timeout';
  }
  const returnR = Number((((exit - entry) * dir) / risk - cost).toFixed(3));
  const falseSignal = (outcome === 'loss' && bars <= 2) || (outcome === 'timeout' && mfe < 0.3) || (outcome === 'loss' && mfe < 0.3);
  return { status: 'resolved', outcome, returnR, mfeR: Number(mfe.toFixed(3)), maeR: Number(mae.toFixed(3)), bars, falseSignal };
}

export function falseSignalReport(records) {
  const rows = Array.isArray(records) ? records : [];
  const bucket = (key) => {
    const out = {};
    for (const r of rows) { const k = r[key] || 'unknown'; (out[k] ||= { n: 0, false: 0 }); out[k].n++; if (r.falseSignal) out[k].false++; }
    for (const v of Object.values(out)) v.rate = Number((v.false / v.n).toFixed(3));
    return out;
  };
  const sorted = [...rows].sort((a, b) => a.candleTs - b.candleTs);
  let clusters = 0;
  for (let i = 2; i < sorted.length; i++) {
    const a = sorted[i - 2], c = sorted[i];
    if (a.symbol === c.symbol && a.timeframe === c.timeframe && c.candleTs - a.candleTs <= 5 * (c.tfMs || 60000)) clusters++;
  }
  return { n: rows.length, overall: rows.length ? Number((rows.filter((r) => r.falseSignal).length / rows.length).toFixed(3)) : null, bySession: bucket('session'), bySetup: bucket('setupType'), byDirection: bucket('direction'), overtradingClusters: clusters };
}

export function calibrationTable(records, { minBucket = 20 } = {}) {
  const rows = (Array.isArray(records) ? records : []).filter((r) => r.confidence !== null && r.confidence !== undefined && r.confidence !== '' && Number.isFinite(Number(r.confidence)) && r.outcome);
  const table = [];
  for (let lo = 0; lo < 100; lo += 10) {
    const b = rows.filter((r) => r.confidence >= lo && r.confidence < lo + 10);
    if (b.length >= minBucket) { const w = b.filter((r) => r.outcome === 'win').length; table.push({ min: lo, max: lo + 10, n: b.length, winRate: Number((w / b.length).toFixed(3)), ...wilsonInterval(w, b.length) }); }
  }
  return table;
}

export function calibrate(confidence, table) {
  const row = (table || []).find((t) => confidence >= t.min && confidence < t.max);
  return row ? { calibrated: true, empiricalWinRate: row.winRate, low: row.low, high: row.high, n: row.n } : { calibrated: false };
}

/**
 * Guarded weight adaptation. One cycle changes each multiplier by at most `maxStep`, only from
 * factors with >= minSample observations, with outlier-clipped returns, versioning, and rollback.
 */
export function adaptModel(model, records, { minSample = MIN_SAMPLE, lr = 0.1, maxStep = 0.05, floor = 0.6, cap = 1.4, dispStep = 0.02 } = {}) {
  const base = model || createModel();
  const rows = (Array.isArray(records) ? records : []).filter((r) => r.returnR !== null && r.returnR !== undefined && r.returnR !== '' && Number.isFinite(Number(r.returnR)) && r.factors && typeof r.factors === 'object' && !Array.isArray(r.factors));
  if (rows.length < minSample) return { model: base, changed: false, reason: 'insufficient-sample', n: rows.length };
  const R = (r) => clamp(Number(r.returnR), -3, 5);
  const weights = { ...base.weights }, deltas = {};
  const keys = new Set(rows.flatMap((r) => Object.keys(r.factors)));
  for (const k of keys) {
    // Missing factors are unknown, not negative observations.
    const measured = rows.filter((r) => Object.prototype.hasOwnProperty.call(r.factors, k) && r.factors[k] !== null && r.factors[k] !== undefined && r.factors[k] !== '' && Number.isFinite(Number(r.factors[k])));
    const a = measured.filter((r) => Number(r.factors[k]) >= 0.25), b = measured.filter((r) => Number(r.factors[k]) < 0.25);
    if (a.length < minSample || b.length < Math.ceil(minSample / 3)) continue;
    const step = clamp(lr * (mean(a.map(R)) - mean(b.map(R))), -maxStep, maxStep);
    const next = clamp((weights[k] ?? 1) + step, floor, cap);
    if (Math.abs(next - (weights[k] ?? 1)) > 1e-9) { deltas[k] = Number((next - (weights[k] ?? 1)).toFixed(4)); weights[k] = Number(next.toFixed(4)); }
  }
  const falseRate = rows.filter((r) => r.falseSignal).length / rows.length;
  const dispAdjust = Number(clamp(base.dispAdjust + clamp(lr * (falseRate - 0.3), -dispStep, dispStep), -0.05, 0.1).toFixed(4));
  const sorted = [...rows].sort((x, y) => x.candleTs - y.candleTs), cut = Math.floor((sorted.length * 2) / 3);
  const early = mean(sorted.slice(0, cut).map(R)), late = mean(sorted.slice(cut).map(R));
  const drifting = sorted.length >= 60 && early != null && late != null && early - late > 0.5;
  const changed = Object.keys(deltas).length > 0 || dispAdjust !== base.dispAdjust;
  if (!changed && drifting === base.drift?.drifting) return { model: base, changed: false, reason: 'no-change', n: rows.length };
  const snapshot = { version: base.version, weights: base.weights, dispAdjust: base.dispAdjust };
  return { model: { ...base, version: base.version + 1, weights, dispAdjust, drift: { drifting, earlyR: Number((early ?? 0).toFixed(3)), lateR: Number((late ?? 0).toFixed(3)) }, history: [snapshot, ...base.history].slice(0, 10) }, changed: true, deltas, dispAdjust, drifting, n: rows.length };
}

export function rollbackModel(model) {
  if (!model?.history?.length) return { model, rolledBack: false };
  const [prev, ...rest] = model.history;
  return { model: { ...model, version: model.version + 1, weights: prev.weights, dispAdjust: prev.dispAdjust, drift: { drifting: false }, history: rest }, rolledBack: true, restoredFrom: prev.version };
}

/** Maps an engine result to the persisted record shape used by expectancy + learning. */
export function signalToRecord(r) {
  const f = {};
  for (const x of r.factors || []) f[x.key] = Number((x.value * r.direction).toFixed(3));
  return {
    id: [r.symbol, r.timeframe, r.preset, r.asOf, r.signal, r.setupId].join('|'), setupId: r.setupId,
    symbol: r.symbol, exchange: r.exchange, timeframe: r.timeframe, preset: r.preset, setupType: r.signalKind || 'confluence',
    direction: r.signal === 'BUY' ? 'bullish' : 'bearish', session: r.market.session, regime: r.market.regime, volRegime: r.market.volRegime,
    candleTs: r.asOf, confidence: r.confidence, score: r.score, factors: f, confirmations: r.confluence.confirmations,
    riskPlan: r.riskPlan, modelVersion: r.modelVersion, tfMs: null
  };
}
