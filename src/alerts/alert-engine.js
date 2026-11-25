// Alert rules over stored outcomes and the calibration report. Pure: the caller supplies `now`.
import { orderRecords, statusRank } from '../gainz-alpha/calibration.js';

export const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, critical: 3 });
export const ALERT_DEFAULTS = Object.freeze({ minSeverity: 'warning', alertOnWatch: false, maxConsecutiveLosses: 5, dailyLossR: 6, drawdownR: 10, drawdownWindow: 100 });
// One edge-decay alert per strategy/status per UTC day: the id is bucketed by day, so a flapping status
// is deduplicated by storage instead of paging the operator repeatedly.
const DAY = 24 * 3600e3, DECAY_BUCKET = DAY;

const clampNumber = (value, fallback, lo, hi) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

/** Reads alert thresholds from an env-like object; bad or missing values fall back to defaults. */
export function normalizeAlertConfig(env = {}) {
  const requested = String(env.JPTI_ALERT_MIN_SEVERITY || '').toLowerCase();
  return {
    minSeverity: SEVERITY_RANK[requested] ? requested : ALERT_DEFAULTS.minSeverity,
    alertOnWatch: ['1', 'true', 'yes', 'on'].includes(String(env.JPTI_ALERT_ON_WATCH || '').trim().toLowerCase()),
    maxConsecutiveLosses: Math.floor(clampNumber(env.JPTI_ALERT_MAX_CONSECUTIVE_LOSSES, ALERT_DEFAULTS.maxConsecutiveLosses, 2, 50)),
    dailyLossR: clampNumber(env.JPTI_ALERT_DAILY_LOSS_R, ALERT_DEFAULTS.dailyLossR, 0.5, 100),
    drawdownR: clampNumber(env.JPTI_ALERT_DRAWDOWN_R, ALERT_DEFAULTS.drawdownR, 1, 500),
    drawdownWindow: ALERT_DEFAULTS.drawdownWindow
  };
}

const iso = (ms) => new Date(ms).toISOString();
const make = (now, rule, key, bucket, severity, title, message, data = {}) => ({
  id: ['alert', rule, key, bucket].join(':').replace(/\s+/g, '-').slice(0, 200),
  rule, severity, key, title, message, createdAt: iso(now), data
});

const fmtR = (v) => (v > 0 ? '+' : '') + Number(v).toFixed(2) + 'R';

/**
 * Evaluates every rule. `previousStatuses` maps "dimension|key" to the last seen edge status so that
 * alerts fire on a worsening transition (and once on recovery), not on every run. Only `decaying` pages
 * by default; `watch` is informational unless config.alertOnWatch is set (it fires often on healthy
 * strategies, so it is opt-in).
 * Returns the alerts plus the new status map to persist for the next run.
 */
export function evaluateAlerts({ records = [], report = null, previousStatuses = {}, config = ALERT_DEFAULTS, now }) {
  if (!Number.isFinite(now)) throw new TypeError('evaluateAlerts requires a finite `now` timestamp.');
  const cfg = { ...ALERT_DEFAULTS, ...config };
  const rows = orderRecords(records);
  const alerts = [], statuses = {};

  // 1. Edge decay per strategy / session / market, on transition only.
  for (const [dimension, groups] of Object.entries(report?.groups || {})) {
    for (const group of groups) {
      const slot = dimension + '|' + group.key;
      statuses[slot] = group.status;
      const before = previousStatuses[slot] || 'healthy';
      const decayBucket = Math.floor(now / DECAY_BUCKET);
      const alertable = group.status === 'decaying' || (cfg.alertOnWatch && group.status === 'watch');
      if (alertable && statusRank(group.status) > statusRank(before)) {
        const decaying = group.status === 'decaying';
        alerts.push(make(now, 'edge-decay', slot + '|' + group.status, decayBucket, decaying ? 'critical' : 'warning',
          (decaying ? 'Edge decaying: ' : 'Edge slipping: ') + group.key,
          group.key + ' (' + dimension + ') recent expectancy ' + fmtR(group.edge.recent?.expectancy ?? 0) + ' vs baseline ' + fmtR(group.edge.baseline?.expectancy ?? 0) + ' over ' + group.n + ' closed trades (z=' + group.edge.z + ').',
          { dimension, status: group.status, previous: before, edge: group.edge }));
      } else if (before === 'decaying' && group.status === 'healthy') {
        alerts.push(make(now, 'edge-recovered', slot, decayBucket, 'info', 'Edge recovered: ' + group.key,
          group.key + ' (' + dimension + ') is back in line with its baseline.', { dimension, previous: before }));
      }
    }
  }

  // 2. Loss streak across all closed trades.
  let streak = 0, lastLossTs = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].outcome !== 'loss') break;
    streak++; lastLossTs ??= Number(rows[i].candleTs);
  }
  if (streak >= cfg.maxConsecutiveLosses) {
    const severe = streak >= cfg.maxConsecutiveLosses + 3;
    alerts.push(make(now, 'loss-streak', 'all', lastLossTs, severe ? 'critical' : 'warning', streak + ' consecutive losses',
      'The latest ' + streak + ' closed trades were all losses (limit ' + cfg.maxConsecutiveLosses + ').', { streak, limit: cfg.maxConsecutiveLosses }));
  }

  // 3. Rolling 24h loss and trailing drawdown, both in R.
  const dayLoss = rows.filter((r) => Number(r.candleTs) >= now - DAY && Number.isFinite(Number(r.returnR))).reduce((s, r) => s + Number(r.returnR), 0);
  const dayBucket = Math.floor(now / DAY);
  if (dayLoss <= -cfg.dailyLossR) {
    alerts.push(make(now, 'daily-loss-limit', 'all', dayBucket, 'critical', 'Daily loss limit breached',
      'Closed trades in the last 24h total ' + fmtR(dayLoss) + ' (limit -' + cfg.dailyLossR + 'R).', { netR: Number(dayLoss.toFixed(3)), limitR: cfg.dailyLossR }));
  }
  let equity = 0, peak = 0, drawdown = 0;
  for (const r of rows.slice(-cfg.drawdownWindow)) {
    if (!Number.isFinite(Number(r.returnR))) continue;
    equity += Number(r.returnR); peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity);
  }
  const currentDrawdown = peak - equity;
  if (currentDrawdown >= cfg.drawdownR) {
    alerts.push(make(now, 'drawdown-limit', 'all', dayBucket, 'critical', 'Drawdown limit breached',
      'Current drawdown is ' + currentDrawdown.toFixed(2) + 'R across the last ' + Math.min(rows.length, cfg.drawdownWindow) + ' trades (limit ' + cfg.drawdownR + 'R).', { drawdownR: Number(currentDrawdown.toFixed(3)), limitR: cfg.drawdownR }));
  }

  // 4. Confidence no longer matches reality.
  if (report?.overall?.miscalibrated) {
    alerts.push(make(now, 'miscalibration', 'all', dayBucket, 'warning', 'Signal confidence is miscalibrated',
      'Expected calibration error is ' + report.overall.ece + ' over ' + report.overall.n + ' outcomes; stated confidence no longer tracks win rate.', { ece: report.overall.ece, n: report.overall.n }));
  }

  return { alerts, statuses };
}

export const meetsSeverity = (alert, minSeverity) => (SEVERITY_RANK[alert.severity] || 0) >= (SEVERITY_RANK[minSeverity] || 0);
