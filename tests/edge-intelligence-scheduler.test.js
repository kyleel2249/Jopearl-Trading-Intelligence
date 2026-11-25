import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { runEdgePulse, STATE_ID } from '../workers/edge-intelligence-scheduler.js';

const HOUR = 3600e3, NOW = Date.UTC(2026, 5, 1, 12);

/** Minimal in-memory D1 covering exactly the statements the scheduler issues. */
function fakeD1({ failReads = false } = {}) {
  const events = new Map();
  const run = (sql, args) => {
    if (failReads) throw new Error('D1 is down');
    if (sql.startsWith('SELECT id, payload, occurred_at FROM jpti_events WHERE kind = ?')) {
      const rows = [...events.values()].filter((e) => e.kind === args[0]).sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1)).slice(0, args[1]);
      return { results: rows.map((e) => ({ id: e.id, payload: e.payload, occurred_at: e.occurred_at })) };
    }
    if (sql.startsWith('SELECT payload FROM jpti_events WHERE id = ?')) return { results: events.has(args[0]) ? [{ payload: events.get(args[0]).payload }] : [] };
    if (sql.startsWith('INSERT OR IGNORE INTO jpti_events')) {
      if (events.has(args[0])) return { meta: { changes: 0 } };
      events.set(args[0], { id: args[0], kind: args[1], occurred_at: args[5], payload: args[6] });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO jpti_events') && sql.includes('ON CONFLICT(id) DO UPDATE')) {
      events.set(args[0], { id: args[0], kind: args[1], occurred_at: args[4], payload: args[5] });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM jpti_events WHERE kind = ? AND occurred_at < ?')) {
      let changes = 0;
      for (const [id, e] of events) if (e.kind === args[0] && e.occurred_at < args[1]) { events.delete(id); changes++; }
      return { meta: { changes } };
    }
    throw new Error('Unexpected SQL in test double: ' + sql);
  };
  return {
    events,
    prepare: (sql) => ({ bind: (...args) => ({ all: async () => run(sql, args), run: async () => run(sql, args) }) })
  };
}

function seedOutcomes(db, rows) {
  for (const r of rows) db.events.set('gainz:' + r.id, { id: 'gainz:' + r.id, kind: 'gainz-alpha-outcome', occurred_at: new Date(r.candleTs).toISOString(), payload: JSON.stringify({ record: r }) });
}
const outcome = (i, win, extra = {}) => ({ id: 'o' + i, candleTs: NOW - (400 - i) * HOUR, outcome: win ? 'win' : 'loss', returnR: win ? 2 : -1, confidence: 60, preset: 'alpha', setupType: 'reversal', session: 'new-york', symbol: 'ETH/USDT', timeframe: '1h', ...extra });

/** 240 profitable trades followed by 60 that collapse: a decaying strategy plus a loss streak at the end. */
function decayingHistory() {
  let s = 99; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const rows = Array.from({ length: 300 }, (_, i) => outcome(i, i < 240 ? r() < 0.58 : r() < 0.06));
  return rows;
}

const hook = { JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/jpti' };

test('a pulse over decaying outcomes stores alerts, delivers them once and records state', async () => {
  const db = fakeD1(); seedOutcomes(db, decayingHistory());
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  const first = await runEdgePulse({ env: { JPTI_DB: db, ...hook }, now: NOW, fetchImpl });
  assert.equal(first.outcomes, 300);
  assert.ok(first.newAlerts >= 1);
  assert.deepEqual(first.delivery.delivered, ['webhook']);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].alerts.some((a) => a.rule === 'edge-decay'));

  const alertIds = [...db.events.values()].filter((e) => e.kind === 'alert').map((e) => e.id);
  assert.equal(alertIds.length, first.newAlerts);
  const state = JSON.parse(db.events.get(STATE_ID).payload);
  assert.equal(state.lastRunAt, new Date(NOW).toISOString());
  assert.equal(state.newAlerts, first.newAlerts);
  assert.deepEqual(state.pending, []);

  // Same data a few minutes later: nothing new is stored and nothing is re-sent.
  const second = await runEdgePulse({ env: { JPTI_DB: db, ...hook }, now: NOW + 15 * 60e3, fetchImpl });
  assert.equal(second.newAlerts, 0);
  assert.equal(sent.length, 1);
  assert.equal([...db.events.values()].filter((e) => e.kind === 'alert').length, alertIds.length);
});

test('alerts are stored even when no delivery channel is configured', async () => {
  const db = fakeD1(); seedOutcomes(db, decayingHistory());
  const result = await runEdgePulse({ env: { JPTI_DB: db }, now: NOW, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.ok(result.newAlerts >= 1);
  assert.deepEqual(result.delivery.channels, []);
  assert.ok([...db.events.values()].some((e) => e.kind === 'alert'));
});

test('a failed delivery is kept pending and retried on the next run without duplicating storage', async () => {
  const db = fakeD1(); seedOutcomes(db, decayingHistory());
  let healthy = false; const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(JSON.parse(init.body)); return healthy ? { ok: true, status: 200 } : { ok: false, status: 503 }; };
  const first = await runEdgePulse({ env: { JPTI_DB: db, ...hook }, now: NOW, fetchImpl });
  assert.deepEqual(first.delivery.failed, [{ channel: 'webhook', error: 'HTTP 503' }]);
  assert.ok(JSON.parse(db.events.get(STATE_ID).payload).pending.length >= 1);

  healthy = true;
  const second = await runEdgePulse({ env: { JPTI_DB: db, ...hook }, now: NOW + 15 * 60e3, fetchImpl });
  assert.equal(second.newAlerts, 0);
  assert.deepEqual(second.delivery.delivered, ['webhook']);
  assert.deepEqual(bodies[1].alerts.map((a) => a.id), bodies[0].alerts.map((a) => a.id));
  assert.deepEqual(JSON.parse(db.events.get(STATE_ID).payload).pending, []);
});

test('a healthy history raises no alerts', async () => {
  const db = fakeD1();
  let s = 5; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  seedOutcomes(db, Array.from({ length: 300 }, (_, i) => outcome(i, r() < 0.55, { confidence: 55 })));
  const result = await runEdgePulse({ env: { JPTI_DB: db, ...hook }, now: NOW, fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.equal(result.newAlerts, 0);
  assert.equal(result.delivery.eligible, 0);
});

test('alerts older than the 90 day retention are pruned', async () => {
  const db = fakeD1();
  db.events.set('alert:old', { id: 'alert:old', kind: 'alert', occurred_at: new Date(NOW - 100 * 24 * HOUR).toISOString(), payload: '{}' });
  db.events.set('alert:recent', { id: 'alert:recent', kind: 'alert', occurred_at: new Date(NOW - 5 * 24 * HOUR).toISOString(), payload: '{}' });
  await runEdgePulse({ env: { JPTI_DB: db }, now: NOW });
  assert.equal(db.events.has('alert:old'), false);
  assert.equal(db.events.has('alert:recent'), true);
});

test('a D1 outage is reported to the operator and the run still fails loudly', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; };
  await assert.rejects(runEdgePulse({ env: { JPTI_DB: fakeD1({ failReads: true }), ...hook }, now: NOW, fetchImpl }), /D1 is down/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].alerts[0].rule, 'storage-unavailable');
});

test('the scheduler refuses to run without its D1 binding', async () => {
  await assert.rejects(runEdgePulse({ env: {} }), /JPTI_DB/);
});

test('the health endpoint reports readiness without exposing secrets, and other paths 404', async () => {
  const env = { JPTI_DB: fakeD1(), JPTI_ALERT_WEBHOOK_URL: 'https://hooks.example.com/secret-path', JPTI_ALERT_WEBHOOK_SECRET: 'whsec' };
  const ok = await worker.fetch(new Request('https://x/health'), env);
  const body = await ok.json();
  assert.equal(body.status, 'ready');
  assert.equal(body.alertChannels, 1);
  assert.doesNotMatch(JSON.stringify(body), /secret-path|whsec/);
  assert.equal((await worker.fetch(new Request('https://x/health'), {})).status, 200);
  assert.equal((await (await worker.fetch(new Request('https://x/health'), {})).json()).status, 'degraded');
  assert.equal((await worker.fetch(new Request('https://x/other'), env)).status, 404);
});

test('the scheduled handler runs the pulse inside waitUntil', async () => {
  const db = fakeD1(); const pending = [];
  await worker.scheduled({}, { JPTI_DB: db }, { waitUntil: (p) => pending.push(p) });
  assert.equal(pending.length, 1);
  await pending[0];
  assert.ok(db.events.has(STATE_ID));
});

test('wrangler config schedules every 15 minutes on the shared D1 database and keeps secrets out of the file', async () => {
  const config = await readFile(new URL('../workers/edge-intelligence-scheduler.wrangler.toml', import.meta.url), 'utf8');
  const paper = await readFile(new URL('../workers/wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /main = "edge-intelligence-scheduler\.js"/);
  assert.match(config, /crons = \["\*\/15 \* \* \* \*"\]/);
  assert.match(config, /binding = "JPTI_DB"/);
  assert.equal(config.match(/database_id = "([^"]+)"/)[1], paper.match(/database_id = "([^"]+)"/)[1]);
  assert.doesNotMatch(config, /^\s*(JPTI_[A-Z_]*(TOKEN|SECRET|URL))\s*=/m);
});
