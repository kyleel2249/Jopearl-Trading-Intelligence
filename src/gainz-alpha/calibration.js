// Signal calibration and edge-decay detection over stored GainzAlpha outcomes.
// Pure functions only (no I/O, no clock): safe to run in the browser, Pages Functions and Workers.
import { wilsonInterval } from './learning.js';

// The CUSUM settings were chosen by replaying the scheduler (re-evaluating after every new trade) over
// simulated histories, not by a single-shot test: re-testing a rolling window hundreds of times inflates
// false alarms (a healthy 55% / +0.65R strategy raised a decay alert in 62% of 540-trade histories with a
// rolling z-test). Measured with this implementation (250 seeded histories, one evaluation per new trade,
// 24-trade refractory period): a healthy 55% strategy alarms in 2.4% of 540-trade histories, a marginal 40%
// one in 1.2%; a collapse from 55% to 25% win rate is caught in 93% of histories, a median 39 trades after it
// starts (to 10%: 100%, median 18). A drop that stays profitable (55% to 40%) is intentionally not paged.
// tests/calibration-replay.test.js keeps these properties from regressing.
export const CALIBRATION_DEFAULTS = Object.freeze({
  bins: 10, minBin: 10,
  recent: 30, baseline: 90, minRecent: 20, minBaseline: 40, watchZ: -1.0,
  monitor: 100, reference: 200, minReference: 60, cusumK: 0.5, cusumH: 8,
  minGroup: 60, eceWarn: 0.12
});

const STATUS_RANK = { insufficient: 0, healthy: 1, watch: 2, decaying: 3 };
export const statusRank = (status) => STATUS_RANK[status] ?? 0;

const finite = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
const round = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(d)));
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const sd = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/** Records with a usable timestamp, ordered oldest to newest. Never mutates the input. */
export function orderRecords(records) {
  return (Array.isArray(records) ? records : [])
    .filter((r) => r && typeof r === 'object' && finite(r.candleTs))
    .sort((a, b) => Number(a.candleTs) - Number(b.candleTs));
}

const hasOutcome = (r) => r.outcome === 'win' || r.outcome === 'loss' || r.outcome === 'timeout';

/**
 * Reliability curve: stated confidence (0-100) against the realised win rate per bin.
 * A bin is `overconfident` when the stated confidence sits above the upper 95% bound of what
 * actually happened, and `underconfident` when it sits below the lower bound.
 */
export function reliabilityCurve(records, { bins = CALIBRATION_DEFAULTS.bins, minBin = CALIBRATION_DEFAULTS.minBin } = {}) {
  const rows = orderRecords(records).filter((r) => finite(r.confidence) && hasOutcome(r));
  const width = 100 / bins;
  const out = [];
  for (let b = 0; b < bins; b++) {
    const lo = b * width, hi = (b + 1) * width, last = b === bins - 1;
    const inBin = rows.filter((r) => {
      const c = Math.min(100, Math.max(0, Number(r.confidence)));
      return c >= lo && (c < hi || (last && c <= hi));
    });
    const n = inBin.length;
    if (!n) continue;
    const wins = inBin.filter((r) => r.outcome === 'win').length;
    const predicted = mean(inBin.map((r) => Math.min(100, Math.max(0, Number(r.confidence))))) / 100;
    const observed = wins / n;
    const ci = wilsonInterval(wins, n);
    let status = 'insufficient';
    if (n >= minBin) status = predicted > ci.high ? 'overconfident' : predicted < ci.low ? 'underconfident' : 'calibrated';
    out.push({ min: round(lo, 2), max: round(hi, 2), n, predicted: round(predicted), observed: round(observed), gap: round(observed - predicted), low: ci.low, high: ci.high, status });
  }
  return out;
}

/** Brier score, skill against always predicting the base rate, and expected calibration error. */
export function calibrationScores(records, options = {}) {
  const rows = orderRecords(records).filter((r) => finite(r.confidence) && hasOutcome(r));
  const n = rows.length;
  if (!n) return { n: 0, brier: null, baselineBrier: null, skill: null, ece: null, baseRate: null };
  const y = rows.map((r) => (r.outcome === 'win' ? 1 : 0));
  const p = rows.map((r) => Math.min(100, Math.max(0, Number(r.confidence))) / 100);
  const baseRate = mean(y);
  const brier = mean(p.map((v, i) => (v - y[i]) ** 2));
  const baselineBrier = baseRate * (1 - baseRate);
  const curve = reliabilityCurve(rows, options).filter((b) => b.status !== 'insufficient');
  const covered = curve.reduce((s, b) => s + b.n, 0);
  const ece = covered ? curve.reduce((s, b) => s + (b.n / covered) * Math.abs(b.gap), 0) : null;
  return {
    n, brier: round(brier), baselineBrier: round(baselineBrier),
    skill: baselineBrier > 0 ? round(1 - brier / baselineBrier) : null,
    ece: round(ece), baseRate: round(baseRate)
  };
}

/**
 * Edge decay. Two complementary checks over per-trade R:
 *  - Welch z of the latest `recent` trades against the `baseline` trades just before them. Sensitive, so it
 *    only ever produces the informational `watch` status.
 *  - A lower-sided CUSUM over the last `monitor` trades against a reference mean/sd taken from up to
 *    `reference` older trades. It is the only thing that can declare `decaying`, and only when the latest
 *    `recent` trades are also no longer profitable (a profitable strategy drifting is not actionable).
 * Statuses: decaying | watch | healthy | insufficient. CUSUM needs monitor + minReference closed trades.
 */
export function edgeDecay(records, options = {}) {
  const o = { ...CALIBRATION_DEFAULTS, ...options };
  const R = orderRecords(records).filter((r) => finite(r.returnR)).map((r) => Number(r.returnR));
  if (R.length < o.minRecent + o.minBaseline) {
    return { status: 'insufficient', n: R.length, needed: o.minRecent + o.minBaseline, reason: 'not-enough-closed-trades' };
  }
  const recentR = R.slice(-o.recent);
  const baseR = R.slice(Math.max(0, R.length - o.recent - o.baseline), R.length - recentR.length);
  const mR = mean(recentR), mB = mean(baseR), sR = sd(recentR), sB = sd(baseR);
  const se = Math.sqrt((sR ** 2) / recentR.length + (sB ** 2) / baseR.length);
  const z = se > 0 ? (mR - mB) / se : null;

  // Lower-sided CUSUM of standardised R against a reference taken from trades older than the monitored ones.
  const cusumNeeded = o.monitor + o.minReference;
  let cusum = { available: false, triggered: false, needed: cusumNeeded, reason: 'not-enough-closed-trades' };
  if (R.length >= cusumNeeded) {
    const monitored = R.slice(-o.monitor);
    const reference = R.slice(Math.max(0, R.length - o.monitor - o.reference), R.length - o.monitor);
    const mu = mean(reference), sigma = sd(reference);
    if (sigma > 0) {
      let s = 0;
      for (const x of monitored) s = Math.min(0, s + (x - mu) / sigma + o.cusumK);
      cusum = {
        available: true, value: round(s, 3), threshold: -o.cusumH, triggered: s <= -o.cusumH,
        monitor: monitored.length, reference: { n: reference.length, mean: round(mu, 3), sd: round(sigma, 3) }
      };
    } else cusum = { available: false, triggered: false, needed: cusumNeeded, reason: 'zero-variance-reference' };
  }

  let status = 'healthy', reason = 'recent-performance-in-line-with-baseline';
  if (cusum.triggered && mR <= 0) { status = 'decaying'; reason = 'sustained-shortfall-against-reference-and-recent-trades-not-profitable'; }
  else if (cusum.triggered) { status = 'watch'; reason = 'sustained-shortfall-against-reference-but-still-profitable'; }
  else if (z !== null && z <= o.watchZ) { status = 'watch'; reason = 'recent-expectancy-below-baseline'; }
  else if (mR < 0 && mB > 0) { status = 'watch'; reason = 'expectancy-turned-negative'; }

  const wr = (arr) => (arr.length ? arr.filter((v) => v > 0).length / arr.length : null);
  return {
    status, reason, n: R.length,
    recent: { n: recentR.length, expectancy: round(mR, 3), winRate: round(wr(recentR), 3) },
    baseline: { n: baseR.length, expectancy: round(mB, 3), winRate: round(wr(baseR), 3) },
    deltaExpectancy: round(mR - mB, 3), z: round(z, 3), cusum
  };
}

const GROUPERS = {
  strategy: (r) => String(r.preset || 'unknown').toLowerCase() + ' / ' + String(r.setupType || 'unknown').toLowerCase(),
  session: (r) => String(r.session || 'unknown').toLowerCase(),
  market: (r) => String(r.symbol || 'unknown').toUpperCase() + ' ' + String(r.timeframe || 'unknown')
};
export const CALIBRATION_DIMENSIONS = Object.freeze(Object.keys(GROUPERS));

/** Full report: overall calibration plus edge status per strategy, session and market. */
export function calibrationReport(records, options = {}) {
  const o = { ...CALIBRATION_DEFAULTS, ...options };
  const rows = orderRecords(records);
  const overallScores = calibrationScores(rows, o);
  const groups = {}, flagged = [];
  for (const dimension of CALIBRATION_DIMENSIONS) {
    const buckets = new Map();
    for (const r of rows) {
      const key = GROUPERS[dimension](r);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    groups[dimension] = [...buckets.entries()].map(([key, list]) => {
      const edge = list.length >= o.minGroup ? edgeDecay(list, o) : { status: 'insufficient', n: list.length, needed: o.minGroup, reason: 'not-enough-closed-trades' };
      const scores = calibrationScores(list, o);
      const item = { key, n: list.length, status: edge.status, edge, brier: scores.brier, ece: scores.ece, skill: scores.skill };
      if (edge.status === 'watch' || edge.status === 'decaying') flagged.push({ dimension, key, status: edge.status, reason: edge.reason, z: edge.z, recentExpectancy: edge.recent?.expectancy ?? null });
      return item;
    }).sort((a, b) => statusRank(b.status) - statusRank(a.status) || b.n - a.n);
  }
  flagged.sort((a, b) => statusRank(b.status) - statusRank(a.status));
  const overallEdge = edgeDecay(rows, o);
  return {
    status: rows.length ? 'ok' : 'empty',
    asOf: options.now ?? null,
    n: rows.length,
    overall: {
      ...overallScores,
      reliability: reliabilityCurve(rows, o),
      edge: overallEdge,
      miscalibrated: overallScores.ece !== null && overallScores.n >= 100 && overallScores.ece >= o.eceWarn
    },
    groups, flagged,
    note: 'Confidence is treated as a win probability; timeouts count as non-wins. Edge status needs enough closed trades and is advisory: it never changes signals by itself.'
  };
}
