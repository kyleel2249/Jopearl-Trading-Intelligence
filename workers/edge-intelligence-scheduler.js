// Scheduled edge intelligence: refreshes calibration and edge-decay status from D1 outcomes, raises
// alerts, stores them (deduplicated) and delivers new ones to the operator's configured channels.
// Cloudflare Pages Functions cannot run cron triggers, so this runs as its own Worker on the same D1.
import { calibrationReport } from '../src/gainz-alpha/calibration.js';
import { evaluateAlerts, normalizeAlertConfig } from '../src/alerts/alert-engine.js';
import { deliverAlerts, configuredChannels } from '../src/alerts/delivery.js';

export const OUTCOME_KIND = 'gainz-alpha-outcome';
export const ALERT_KIND = 'alert';
export const STATE_KIND = 'edge-intelligence-state';
export const STATE_ID = 'edge-intelligence:state';
const SOURCE = 'jpti-edge-intelligence';
const MAX_OUTCOMES = 5000, MAX_PENDING = 20, ALERT_RETENTION_MS = 90 * 24 * 3600e3;

const parse = (raw) => { try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; } };

async function loadOutcomes(db) {
  const result = await db.prepare('SELECT id, payload, occurred_at FROM jpti_events WHERE kind = ? ORDER BY occurred_at DESC, created_at DESC LIMIT ?').bind(OUTCOME_KIND, MAX_OUTCOMES).all();
  const seen = new Set(), out = [];
  for (const row of result.results || []) {
    const event = parse(row.payload), record = event?.record || event;
    if (!record?.id || seen.has(record.id)) continue;
    seen.add(record.id); out.push(record);
  }
  return out.reverse();
}

async function loadState(db) {
  const result = await db.prepare('SELECT payload FROM jpti_events WHERE id = ?').bind(STATE_ID).all();
  const state = parse(result.results?.[0]?.payload);
  return state && typeof state === 'object' ? state : { statuses: {}, pending: [] };
}

async function saveState(db, state, nowIso) {
  await db.prepare('INSERT INTO jpti_events (id, kind, source, external_id, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, occurred_at = excluded.occurred_at')
    .bind(STATE_ID, STATE_KIND, SOURCE, STATE_ID, nowIso, JSON.stringify(state)).run();
}

/** Inserts alerts that have not been seen before and returns just those (the ones worth delivering). */
async function storeNewAlerts(db, alerts) {
  const fresh = [];
  for (const alert of alerts) {
    const result = await db.prepare('INSERT OR IGNORE INTO jpti_events (id, kind, source, external_id, symbol, occurred_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(alert.id, ALERT_KIND, SOURCE, alert.id, null, alert.createdAt, JSON.stringify({ record: alert })).run();
    if (Number(result?.meta?.changes || 0) > 0) fresh.push(alert);
  }
  return fresh;
}

export async function runEdgePulse({ env, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!env?.JPTI_DB) throw new Error('The JPTI_DB D1 binding is required for the edge intelligence scheduler.');
  const db = env.JPTI_DB, config = normalizeAlertConfig(env), nowIso = new Date(now).toISOString();

  let records, state;
  try {
    records = await loadOutcomes(db);
    state = await loadState(db);
  } catch (error) {
    // Storage is down, so the alert cannot be persisted; still tell the operator once per run.
    const outage = { id: 'alert:storage-unavailable:' + Math.floor(now / 3600e3), rule: 'storage-unavailable', severity: 'critical', key: 'd1', title: 'D1 storage unavailable', message: 'The scheduled intelligence run could not read Cloudflare D1.', createdAt: nowIso, data: {} };
    await deliverAlerts([outage], { env, fetchImpl, minSeverity: config.minSeverity }).catch(() => {});
    throw error;
  }

  const report = calibrationReport(records, { now });
  const { alerts, statuses } = evaluateAlerts({ records, report, previousStatuses: state.statuses || {}, config, now });
  const fresh = await storeNewAlerts(db, alerts);

  const pending = Array.isArray(state.pending) ? state.pending : [];
  const toSend = [...pending, ...fresh];
  const delivery = await deliverAlerts(toSend, { env, fetchImpl, minSeverity: config.minSeverity });
  const undelivered = delivery.eligible > 0 && delivery.delivered.length === 0 && delivery.channels.length > 0;

  await saveState(db, {
    lastRunAt: nowIso, outcomes: records.length, statuses,
    overall: { n: report.n, edge: report.overall.edge.status, ece: report.overall.ece, brier: report.overall.brier, miscalibrated: report.overall.miscalibrated },
    flagged: report.flagged.length, newAlerts: fresh.length,
    delivery: { channels: delivery.channels, delivered: delivery.delivered, failed: delivery.failed },
    pending: undelivered ? toSend.filter((a) => a.severity !== 'info').slice(-MAX_PENDING) : []
  }, nowIso);

  await db.prepare('DELETE FROM jpti_events WHERE kind = ? AND occurred_at < ?').bind(ALERT_KIND, new Date(now - ALERT_RETENTION_MS).toISOString()).run();
  return { outcomes: records.length, newAlerts: fresh.length, flagged: report.flagged.length, delivery };
}

export default {
  async scheduled(controller, env, context) {
    context.waitUntil(runEdgePulse({ env }).catch((error) => {
      console.error('[JPTI edge intelligence] Scheduled run failed:', error?.message || error);
      throw error;
    }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/health') return new Response('Not found', { status: 404 });
    return Response.json({
      service: 'JPTI edge intelligence scheduler',
      status: env.JPTI_DB ? 'ready' : 'degraded',
      d1: Boolean(env.JPTI_DB),
      alertChannels: configuredChannels(env).length,
      schedule: 'Every 15 minutes: calibration and edge-decay refresh, alert evaluation, deduplicated storage and delivery.'
    }, { headers: { 'cache-control': 'no-store' } });
  }
};
