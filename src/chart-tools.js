/**
 * Pure drawing, measuring, risk/reward, alert, persistence and replay logic shared by every live chart.
 * No React and no DOM (storage is passed in), so each rule is unit-tested in chart-tools.test.js.
 *
 * Drawings are anchored to (timestamp, price), never to pixels or candle indexes, so they survive zooming,
 * resizing, timeframe changes and reloads.
 */
import { timeframeMs, pipDistance } from './chart-live.js';

const finite = (n) => Number.isFinite(Number(n)) && n !== null && n !== '';

/* ---------- time <-> candle index ---------- */

/** Fractional candle index of a timestamp (0 = first row). Extrapolates before the first and after the last row. */
export function timeToIndex(rows, ts, tfMs) {
  if (!Array.isArray(rows) || !rows.length || !finite(ts)) return null;
  const step = finite(tfMs) && tfMs > 0 ? Number(tfMs) : (rows.length > 1 ? rows[1][0] - rows[0][0] : 60000);
  const t = Number(ts);
  if (t <= rows[0][0]) return (t - rows[0][0]) / step;
  const lastIdx = rows.length - 1;
  if (t >= rows[lastIdx][0]) return lastIdx + (t - rows[lastIdx][0]) / step;
  let lo = 0, hi = lastIdx;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= t) lo = mid; else hi = mid; }
  const span = rows[hi][0] - rows[lo][0] || step;
  return lo + (t - rows[lo][0]) / span;
}

/** Inverse of timeToIndex. */
export function indexToTime(rows, index, tfMs) {
  if (!Array.isArray(rows) || !rows.length || !finite(index)) return null;
  const step = finite(tfMs) && tfMs > 0 ? Number(tfMs) : (rows.length > 1 ? rows[1][0] - rows[0][0] : 60000);
  const i = Number(index), lastIdx = rows.length - 1;
  if (i <= 0) return Math.round(rows[0][0] + i * step);
  if (i >= lastIdx) return Math.round(rows[lastIdx][0] + (i - lastIdx) * step);
  const lo = Math.floor(i), span = rows[lo + 1][0] - rows[lo][0];
  return Math.round(rows[lo][0] + (i - lo) * span);
}

export function formatDuration(ms) {
  const total = Math.round(Math.abs(Number(ms)) / 60000);
  if (!Number.isFinite(total)) return '—';
  if (total < 60) return total + 'm';
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  return h + 'h' + (m ? ' ' + m + 'm' : '');
}

/* ---------- measure tool ---------- */

/** Distance between two anchors: price, pips, percent, bars and elapsed time. */
export function measureBetween(a, b, { pip, timeframe, rows } = {}) {
  if (!a || !b || ![a.price, b.price, a.ts, b.ts].every(finite) || !(Number(a.price) > 0)) return null;
  const priceDelta = Number(b.price) - Number(a.price);
  const pips = pipDistance(a.price, b.price, pip);
  const tf = timeframeMs(timeframe);
  let bars = null;
  if (rows && rows.length) {
    const ia = timeToIndex(rows, a.ts, tf), ib = timeToIndex(rows, b.ts, tf);
    if (ia !== null && ib !== null) bars = Math.round(ib - ia);
  } else if (tf) bars = Math.round((b.ts - a.ts) / tf);
  const durationMs = Number(b.ts) - Number(a.ts);
  return {
    priceDelta, pips, pct: (priceDelta / Number(a.price)) * 100, bars, durationMs,
    up: priceDelta >= 0, durationLabel: formatDuration(durationMs)
  };
}

/* ---------- risk / reward position tool ---------- */

/**
 * Long/short position maths. Position size comes from a risk amount (or account size x risk %) and the stop distance:
 * units = riskAmount / |entry - stop|. Nothing here places an order.
 */
export function riskReward({ side, entry, stop, target, accountSize, riskPct, riskAmount, pip } = {}) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  const issues = [];
  if (![e, s, t].every((n) => Number.isFinite(n) && n > 0)) return { valid: false, issues: ['Entry, stop and target must be positive prices.'] };
  const dir = side === 'short' || side === 'long' ? side : (t >= e ? 'long' : 'short');
  if (dir === 'long' && !(s < e && t > e)) issues.push('For a long, the stop must sit below entry and the target above.');
  if (dir === 'short' && !(s > e && t < e)) issues.push('For a short, the stop must sit above entry and the target below.');
  const riskDist = Math.abs(e - s), rewardDist = Math.abs(t - e);
  const stepPip = Number(pip) > 0 ? Number(pip) : null;
  let amount = finite(riskAmount) && Number(riskAmount) > 0 ? Number(riskAmount) : null;
  if (amount === null && finite(accountSize) && finite(riskPct) && Number(accountSize) > 0 && Number(riskPct) > 0) amount = Number(accountSize) * Number(riskPct) / 100;
  const units = amount !== null && riskDist > 0 ? amount / riskDist : null;
  return {
    valid: issues.length === 0 && riskDist > 0, issues, side: dir,
    riskDist, rewardDist,
    riskPips: stepPip ? Number((riskDist / stepPip).toFixed(1)) : null,
    rewardPips: stepPip ? Number((rewardDist / stepPip).toFixed(1)) : null,
    rr: riskDist > 0 ? Number((rewardDist / riskDist).toFixed(2)) : null,
    riskPercentOfEntry: (riskDist / e) * 100, rewardPercentOfEntry: (rewardDist / e) * 100,
    riskAmount: amount, units, notional: units === null ? null : units * e,
    potentialProfit: units === null ? null : units * rewardDist
  };
}

/** Average true range over the last `period` candles (Wilder smoothing), or null with too little history. */
export function atrOf(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < rows.length; i += 1) {
    const v = Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4]));
    if (!Number.isFinite(v)) return null;
    tr.push(v);
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i += 1) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

/**
 * Default stop/target for a new position click. With an ATR the stop sits 1.5 ATR away (volatility aware);
 * otherwise 1% away. Target is 2R, both snapped to the pip.
 */
export function defaultPosition(side, entry, { pip, riskFraction = 0.01, atr = null } = {}) {
  const e = Number(entry);
  if (!(e > 0)) return null;
  const snap = (v) => (Number(pip) > 0 ? Math.round(v / pip) * pip : v);
  const base = Number(atr) > 0 ? Number(atr) * 1.5 : e * riskFraction;
  const risk = Math.max(base, Number(pip) > 0 ? pip * 2 : 0);
  const dir = side === 'short' ? -1 : 1;
  return { side: dir === 1 ? 'long' : 'short', entry: e, stop: snap(e - dir * risk), target: snap(e + dir * risk * 2) };
}

/* ---------- Fibonacci retracement ---------- */

export const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];

/** Price at each ratio measured from p2 back toward p1 (0 = the second anchor, 1 = the first). */
export function fibLevels(p1, p2, ratios = FIB_RATIOS) {
  const a = Number(p1), b = Number(p2);
  if (!(a > 0) || !(b > 0) || a === b) return [];
  return ratios.map((ratio) => ({ ratio, price: b + (a - b) * ratio }));
}

/* ---------- price alerts ---------- */

let alertSeq = 0;
export function createAlert({ price, lastPrice, note = '', now = Date.now() } = {}) {
  const p = Number(price), last = Number(lastPrice);
  if (!(p > 0) || !(last > 0) || p === last) return null;
  alertSeq += 1;
  return { id: 'al' + now.toString(36) + alertSeq, price: p, direction: p > last ? 'above' : 'below', note: String(note).slice(0, 80), createdAt: now, triggeredAt: null };
}

/**
 * Fire alerts whose level the price crossed between two consecutive observations. An alert fires once.
 * Returns the same array when nothing fired so memoised consumers stay stable.
 */
export function evaluateAlerts(alerts, prevPrice, price, now = Date.now()) {
  const prev = Number(prevPrice), cur = Number(price);
  if (!Array.isArray(alerts) || !alerts.length || !(prev > 0) || !(cur > 0)) return { alerts, fired: [] };
  const fired = [];
  const next = alerts.map((a) => {
    if (a.triggeredAt) return a;
    const hit = a.direction === 'above' ? prev < a.price && cur >= a.price : prev > a.price && cur <= a.price;
    if (!hit) return a;
    const done = { ...a, triggeredAt: now, triggeredPrice: cur };
    fired.push(done);
    return done;
  });
  return fired.length ? { alerts: next, fired } : { alerts, fired };
}

/* ---------- drawings + persistence ---------- */

export const MAX_DRAWINGS = 200;
export const MAX_ALERTS = 50;

export const drawingsKey = (exchange, marketType, symbol) => 'jpti.chart.drawings.v2:' + [exchange, marketType || 'spot', symbol].join('|');

/** Keep only well-formed drawings; unknown kinds and non-finite anchors are dropped, never repaired by guessing. */
export function sanitizeDrawings(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string') continue;
    if (d.kind === 'hline' && finite(d.price) && d.price > 0) out.push({ id: d.id, kind: 'hline', price: Number(d.price) });
    else if (d.kind === 'trend' && [d.t1, d.p1, d.t2, d.p2].every(finite) && d.p1 > 0 && d.p2 > 0) out.push({ id: d.id, kind: 'trend', t1: Number(d.t1), p1: Number(d.p1), t2: Number(d.t2), p2: Number(d.p2) });
    else if (d.kind === 'fib' && [d.t1, d.p1, d.t2, d.p2].every(finite) && d.p1 > 0 && d.p2 > 0 && d.p1 !== d.p2) out.push({ id: d.id, kind: 'fib', t1: Number(d.t1), p1: Number(d.p1), t2: Number(d.t2), p2: Number(d.p2) });
    else if (d.kind === 'rr' && [d.t, d.entry, d.stop, d.target].every(finite) && (d.side === 'long' || d.side === 'short')) out.push({ id: d.id, kind: 'rr', side: d.side, t: Number(d.t), entry: Number(d.entry), stop: Number(d.stop), target: Number(d.target) });
    if (out.length >= MAX_DRAWINGS) break;
  }
  return out;
}

export function sanitizeAlerts(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((a) => a && typeof a.id === 'string' && finite(a.price) && a.price > 0 && (a.direction === 'above' || a.direction === 'below') && finite(a.createdAt))
    .map((a) => ({ id: a.id, price: Number(a.price), direction: a.direction, note: String(a.note || '').slice(0, 80), createdAt: Number(a.createdAt), triggeredAt: finite(a.triggeredAt) && a.triggeredAt ? Number(a.triggeredAt) : null, ...(finite(a.triggeredPrice) ? { triggeredPrice: Number(a.triggeredPrice) } : {}) }))
    .slice(-MAX_ALERTS);
}

/** Storage is injected (localStorage in the browser) and every access is guarded, since it may be blocked or full. */
export function loadJson(storage, key, fallback) {
  try { const raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
export function saveJson(storage, key, value) {
  try { if (storage) storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

let drawSeq = 0;
export const newDrawingId = (now = Date.now()) => { drawSeq += 1; return 'd' + now.toString(36) + drawSeq; };

/* ---------- replay ---------- */

export const REPLAY_SPEEDS = [1, 2, 5, 10];
export const REPLAY_MIN_BARS = 30;

export function replayStart(total, back = 60) {
  const n = Number(total);
  if (!(n > REPLAY_MIN_BARS)) return null;
  return { active: true, index: Math.max(REPLAY_MIN_BARS - 1, n - 1 - back), playing: false, speed: 1 };
}

/** Move the replay cursor; reaching the last candle stops playback. */
export function replayStep(state, total, delta) {
  if (!state || !state.active) return state;
  const max = Math.max(0, Number(total) - 1);
  const index = Math.max(REPLAY_MIN_BARS - 1, Math.min(max, state.index + delta));
  return { ...state, index, playing: state.playing && index < max };
}

export const replaySlice = (candles, state) => (state && state.active && Array.isArray(candles) ? candles.slice(0, state.index + 1) : candles);
export const replayIntervalMs = (speed) => Math.round(1000 / (REPLAY_SPEEDS.includes(speed) ? speed : 1));
