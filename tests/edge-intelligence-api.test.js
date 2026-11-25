import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const HOUR = 3600e3, NOW = Date.UTC(2026, 5, 1, 12), TOKEN = 'test-private-token';

function fakeD1() {
  const events = new Map();
  return {
    events,
    prepare: (sql) => ({
      bind: (...values) => ({
        async all() {
          if (sql.includes('SELECT id, payload, occurred_at FROM jpti_events')) {
            const rows = [...events.values()].filter((e) => e.kind === values[0]).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).slice(0, values[1]);
            return { results: rows };
          }
          if (sql.includes('SELECT payload FROM jpti_events WHERE id = ?')) return { results: events.has(values[0]) ? [{ payload: events.get(values[0]).payload }] : [] };
          return { results: [] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; }
      })
    })
  };
}
const put = (db, id, kind, occurredAt, record) => db.events.set(id, { id, kind, occurred_at: occurredAt, payload: JSON.stringify({ record }) });
const handler = () => createPagesApiHandler({
  marketProvider: { async request() { return { status: 404, body: {} }; } },
  bitgetCfdProvider: { async request() { return { status: 404, body: {} }; } },
  now: () => new Date(NOW)
});
const call = (path, { db, token = TOKEN, method = 'GET', headers = {}, env = {} } = {}) => handler()({
  request: new Request('https://jpti.example' + path, { method, headers: { ...(token ? { 'x-jpti-api-token': token } : {}), ...headers } }),
  env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: TOKEN, ...env }
});

function outcome(i, win, extra = {}) {
  return { id: 'o' + i, candleTs: NOW - (400 - i) * HOUR, outcome: win ? 'win' : 'loss', returnR: win ? 2 : -1, confidence: 60, preset: 'alpha', setupType: 'reversal', session: 'new-york', symbol: 'ETH/USDT', timeframe: '1h', ...extra };
}
function seedDecaying(db, extra = () => ({})) {
  let s = 99; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 300; i++) { const rec = outcome(i, i < 240 ? r() < 0.58 : r() < 0.06, extra(i)); put(db, 'gainz:' + rec.id, 'gainz-alpha-outcome', new Date(rec.candleTs).toISOString(), rec); }
}
const alert = (n, severity, rule = 'edge-decay') => ({ id: 'alert:' + n, rule, severity, key: 'k' + n, title: 'T' + n, message: 'M' + n, createdAt: new Date(NOW - (10 - n) * HOUR).toISOString(), data: {} });
function seedAlerts(db) { for (const [n, sev, rule] of [[1, 'info', 'edge-recovered'], [2, 'warning', 'loss-streak'], [3, 'critical', 'edge-decay'], [4, 'critical', 'daily-loss-limit']]) { const a = alert(n, sev, rule); put(db, a.id, 'alert', a.createdAt, a); } }

test('calibration and alert routes require the private token', async () => {
  const db = fakeD1();
  for (const path of ['/api/alpha/gainz/calibration', '/api/alerts']) {
    assert.equal((await call(path, { db, token: '' })).status, 401, path);
    assert.equal((await call(path, { db, token: 'wrong-token' })).status, 401, path);
    assert.equal((await call(path, { db, token: '', headers: { authorization: 'Bearer ' + TOKEN } })).status, 200, path + ' accepts Bearer');
    assert.equal((await call(path, { db, env: { JPTI_JOURNAL_TOKEN: '' } })).status, 503, path + ' without a configured secret');
    assert.equal((await call(path, { db: undefined })).status, 503, path + ' without D1');
    assert.equal((await call(path, { db, method: 'POST' })).status, 405, path);
  }
});

test('calibration route reports the decaying strategy from stored outcomes and no scheduler yet', async () => {
  const db = fakeD1(); seedDecaying(db);
  const response = await call('/api/alpha/gainz/calibration', { db });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.count, 300);
  assert.equal(data.report.n, 300);
  assert.equal(data.report.asOf, NOW);
  assert.equal(data.report.groups.strategy[0].key, 'alpha / reversal');
  assert.equal(data.report.groups.strategy[0].status, 'decaying');
  assert.ok(data.report.flagged.some((f) => f.status === 'decaying'));
  assert.equal(data.lastPulse, null);
  assert.equal(data.scheduler.configured, false);
});

test('calibration route filters by symbol and timeframe before analysing', async () => {
  const db = fakeD1(); seedDecaying(db, (i) => (i % 2 ? { symbol: 'BTC/USDT' } : {}));
  const all = await (await call('/api/alpha/gainz/calibration', { db })).json();
  const eth = await (await call('/api/alpha/gainz/calibration?symbol=eth/usdt', { db })).json();
  const none = await (await call('/api/alpha/gainz/calibration?timeframe=4h', { db })).json();
  assert.equal(all.count, 300);
  assert.equal(eth.count, 150);
  assert.equal(none.count, 0);
  assert.equal(none.report.status, 'empty');
});

test('calibration route includes the last scheduled run without exposing delivery targets', async () => {
  const db = fakeD1(); seedDecaying(db);
  db.events.set('edge-intelligence:state', { id: 'edge-intelligence:state', kind: 'edge-intelligence-state', occurred_at: new Date(NOW).toISOString(), payload: JSON.stringify({ lastRunAt: new Date(NOW).toISOString(), outcomes: 300, flagged: 3, newAlerts: 2, overall: { n: 300, edge: 'decaying' }, delivery: { channels: ['webhook'], delivered: ['webhook'], failed: [] }, pending: [{ id: 'x' }], statuses: { 'strategy|a': 'decaying' } }) });
  const data = await (await call('/api/alpha/gainz/calibration', { db })).json();
  assert.equal(data.scheduler.configured, true);
  assert.equal(data.lastPulse.lastRunAt, new Date(NOW).toISOString());
  assert.equal(data.lastPulse.newAlerts, 2);
  assert.equal(data.lastPulse.pending, 1);
  assert.deepEqual(data.lastPulse.delivery.delivered, ['webhook']);
  assert.equal('statuses' in data.lastPulse, false);
});

test('alert feed returns newest first and honours severity, rule and limit filters', async () => {
  const db = fakeD1(); seedAlerts(db);
  const all = await (await call('/api/alerts', { db })).json();
  assert.deepEqual(all.alerts.map((a) => a.id), ['alert:4', 'alert:3', 'alert:2', 'alert:1']);
  const critical = await (await call('/api/alerts?severity=critical', { db })).json();
  assert.deepEqual(critical.alerts.map((a) => a.id), ['alert:4', 'alert:3']);
  const warningUp = await (await call('/api/alerts?severity=WARNING', { db })).json();
  assert.equal(warningUp.count, 3);
  const rule = await (await call('/api/alerts?rule=loss-streak', { db })).json();
  assert.deepEqual(rule.alerts.map((a) => a.id), ['alert:2']);
  const limited = await (await call('/api/alerts?limit=1', { db })).json();
  assert.deepEqual(limited.alerts.map((a) => a.id), ['alert:4']);
  assert.equal((await call('/api/alerts?severity=loud', { db })).status, 400);
});

test('alert feed is empty rather than an error before the scheduler has run', async () => {
  const data = await (await call('/api/alerts', { db: fakeD1() })).json();
  assert.deepEqual(data.alerts, []);
  assert.equal(data.count, 0);
});

test('trailing slashes resolve and health advertises both routes and capabilities', async () => {
  const db = fakeD1();
  assert.equal((await call('/api/alerts/', { db })).status, 200);
  assert.equal((await call('/api/alpha/gainz/calibration/', { db })).status, 200);
  const health = await (await handler()({ request: new Request('https://jpti.example/api/health'), env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: TOKEN } })).json();
  assert.equal(health.capabilities.calibrationReport, true);
  assert.equal(health.capabilities.alertFeed, true);
  const off = await (await handler()({ request: new Request('https://jpti.example/api/health'), env: {} })).json();
  assert.equal(off.capabilities.calibrationReport, false);
  // Unknown paths reach the real provider, which answers 501 with the list of implemented routes.
  const unknown = await createPagesApiHandler()({ request: new Request('https://jpti.example/api/definitely-not-a-route'), env: {} });
  const index = await unknown.json();
  assert.equal(unknown.status, 501);
  assert.ok(index.available.includes('/api/alerts'), JSON.stringify(index.available));
  assert.ok(index.available.includes('/api/alpha/gainz/calibration'));
});
