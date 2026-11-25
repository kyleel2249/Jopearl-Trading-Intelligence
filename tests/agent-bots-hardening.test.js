import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';
import { unrealizedPnlForSymbol } from '../functions/api/paper/[[path]].js';
import scheduler from '../workers/paper-scheduler.js';

const TOKEN = 'test-private-token';
// Minimal D1 stand-in that enforces the jpti_events primary key so id collisions fail like production.
function fakeD1({ failWrites = false, failTables = [], sessionCount = 0 } = {}) {
  const events = new Map();
  const duplicates = [];
  const db = {
    events, duplicates,
    prepare(sql) {
      const exec = (values) => ({
        async run() {
          for (const table of failTables) if (sql.includes(table)) throw new Error('simulated D1 failure on ' + table);
          if (/INSERT (OR IGNORE )?INTO jpti_events/.test(sql)) {
            if (failWrites) throw new Error('simulated D1 outage');
            let row;
            if (sql.includes("'paper-scheduler-health'")) { const [id, external, at, payload] = values; row = { id, kind: 'paper-scheduler-health', external_id: external, occurred_at: at, payload }; }
            else { const [id, kind, source, external, symbol, at, payload] = values; row = { id, kind, source, external_id: external, symbol, occurred_at: at, payload, created_at: at }; }
            if (events.has(row.id)) { duplicates.push(row.id); if (/OR IGNORE/.test(sql)) return { success: true, meta: { changes: 0 } }; throw new Error('UNIQUE constraint failed: jpti_events.id'); }
            events.set(row.id, row);
          }
          return { success: true, meta: { changes: 1 } };
        },
        async all() {
          if (/SELECT COUNT\(\*\) AS count FROM jpti_events/.test(sql)) return { results: [{ count: sessionCount }] };
          if (/SELECT payload FROM jpti_events WHERE kind = \?/.test(sql)) {
            const [kind, limit] = values;
            return { results: [...events.values()].filter(r => r.kind === kind).sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, limit).map(r => ({ payload: r.payload })) };
          }
          return { results: [] };
        },
        async first() {
          if (/SELECT payload FROM jpti_events WHERE id = \? AND kind = 'agent-fleet-evaluation'/.test(sql)) { const r = events.get(values[0]); return r && r.kind === 'agent-fleet-evaluation' ? { payload: r.payload } : null; }
          return null;
        }
      });
      return { ...exec([]), bind: (...values) => exec(values) };
    }
  };
  return db;
}
const handler = () => createPagesApiHandler({
  marketProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  bitgetCfdProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } }
});
const call = (db, method, path, body, { token = TOKEN, rawBody } = {}) => handler()({
  request: new Request('https://jpti.example' + path, { method, headers: { ...(token ? { 'x-jpti-api-token': token } : {}), ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined }),
  env: { ...(db ? { JPTI_DB: db } : {}), JPTI_JOURNAL_TOKEN: TOKEN }
});
const evidence = () => ({ symbol: 'BTC/USDT', evidence: { timestamp: new Date().toISOString(), momentumPct: 1.8, timeframeAlignment: .8, relativeVolume: 1.6, depthImbalance: .35, fundingRate: .0001, openInterestChangePct: 4, volatilityPct: 2.5, liquidityUsd: 250000, correlationBias: .2, highImpactEvent: false, macroBias: 'risk-on', sources: [{ id: 'op', status: 'ok' }] } });

test('agent catalog is public static metadata and does not need D1 or a token', async () => {
  const response = await call(null, 'GET', '/api/agents/catalog', undefined, { token: '' });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.agents.length, 10);
  assert.ok(data.capabilities.includes('outcome-performance-reporting'));
});

test('private agent routes fail closed without a token and without storage', async () => {
  assert.equal((await call(fakeD1(), 'POST', '/api/agents/evaluate', evidence(), { token: '' })).status, 401);
  assert.equal((await call(fakeD1(), 'GET', '/api/agents/history', undefined, { token: 'wrong' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/agents/evaluate', evidence())).status, 503);
});

test('evaluate -> history -> feedback -> performance round trip persists and reports observationally', async () => {
  const db = fakeD1();
  const evaluated = await (await call(db, 'POST', '/api/agents/evaluate', evidence())).json();
  assert.equal(evaluated.persisted, true);
  assert.equal(evaluated.permissions.ordersCreated, 0);
  const history = await (await call(db, 'GET', '/api/agents/history?limit=5')).json();
  assert.equal(history.evaluations[0].id, evaluated.id);
  const saved = await call(db, 'POST', '/api/agents/feedback', { evaluationId: evaluated.id, outcome: 'win', realizedR: 2.5 });
  assert.equal(saved.status, 201);
  const report = await (await call(db, 'GET', '/api/agents/performance')).json();
  assert.equal(report.mode, 'observational_only');
  assert.equal(report.evaluationsWithFeedback, 1);
  assert.equal(report.overall.counts.win, 1);
  assert.equal(report.overall.sampleQuality, 'insufficient');
});

test('feedback is validated, bounded and tied to a stored evaluation', async () => {
  const db = fakeD1();
  const evaluated = await (await call(db, 'POST', '/api/agents/evaluate', evidence())).json();
  assert.equal((await call(db, 'POST', '/api/agents/feedback', { evaluationId: evaluated.id, outcome: 'moon' })).status, 400);
  assert.equal((await call(db, 'POST', '/api/agents/feedback', { evaluationId: 'does-not-exist', outcome: 'win' })).status, 404);
  const huge = await (await call(db, 'POST', '/api/agents/feedback', { evaluationId: evaluated.id, outcome: 'win', realizedR: 1e9 })).json();
  assert.equal(huge.realizedR, 100);
  const junk = await (await call(db, 'POST', '/api/agents/feedback', { evaluationId: evaluated.id, outcome: 'loss', realizedR: 'abc' })).json();
  assert.equal(junk.realizedR, null);
});

test('payload limit is enforced on the body itself, not only on a Content-Length header that may be absent', async () => {
  const db = fakeD1();
  const oversized = JSON.stringify({ symbol: 'BTC/USDT', evidence: { timestamp: new Date().toISOString(), padding: 'x'.repeat(130000) } });
  const request = new Request('https://jpti.example/api/agents/evaluate', { method: 'POST', headers: { 'x-jpti-api-token': TOKEN }, body: oversized });
  assert.equal(request.headers.get('content-length'), null, 'precondition: no declared length');
  const response = await handler()({ request, env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: TOKEN } });
  assert.equal(response.status, 413);
  assert.equal((await call(db, 'POST', '/api/agents/evaluate', undefined, { rawBody: '{not json' })).status, 400);
  assert.equal(db.events.size, 0);
});

test('a storage outage never discards a computed evaluation and never fakes a saved feedback', async () => {
  const db = fakeD1({ failWrites: true });
  const response = await call(db, 'POST', '/api/agents/evaluate', evidence());
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.persisted, false);
  assert.match(data.warning, /not saved/i);
  assert.ok(data.consensus);
  const readable = fakeD1();
  const ok = await (await call(readable, 'POST', '/api/agents/evaluate', evidence())).json();
  readable.prepare = new Proxy(readable.prepare, {});
  const failing = fakeD1({ failWrites: true });
  failing.events.set(ok.id, readable.events.get(ok.id));
  const feedback = await call(failing, 'POST', '/api/agents/feedback', { evaluationId: ok.id, outcome: 'win' });
  assert.equal(feedback.status, 503);
});

test('research council runs on Cloudflare with the shared engine, risk veto and D1 history', async () => {
  const db = fakeD1();
  const input = { symbol: 'ETH/USDT', assetClass: 'crypto_spot', evidence: { ...evidence().evidence, liquidityUsd: 100000 } };
  const ok = await (await call(db, 'POST', '/api/council/evaluate', input)).json();
  assert.equal(ok.persisted, true);
  assert.equal(ok.permissions.liveExecutionAuthorized, false);
  const vetoed = await (await call(db, 'POST', '/api/council/evaluate', { ...input, evidence: { ...input.evidence, liquidityUsd: 500 } })).json();
  assert.equal(vetoed.consensus.stance, 'risk_blocked');
  const history = await (await call(db, 'GET', '/api/council/history?limit=10')).json();
  assert.equal(history.count, 2);
  assert.equal((await call(db, 'GET', '/api/council/history', undefined, { token: '' })).status, 401);
});

test('session outcome memory refuses new writes at its retention cap instead of growing without bound', async () => {
  const response = await call(fakeD1({ sessionCount: 20000 }), 'POST', '/api/session/memory', { id: 'x', symbol: 'BTCUSDT' });
  const data = await response.json();
  assert.equal(response.status, 409);
  assert.equal(data.cap, 20000);
});

test('daily-loss mark-to-market never values a position with another symbol\'s price', () => {
  const trades = [
    { symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100, quantity: 1, entryFeeUsd: .1 },
    { symbol: 'ETHUSDT', direction: 'LONG', entryPrice: 2, quantity: 10, entryFeeUsd: .02 }
  ];
  const result = unrealizedPnlForSymbol(trades, 'BTCUSDT', 101, 0);
  // BTC: +1 move - 0.1 fee. ETH carried at entry: -0.02 fee only (the old code would have added (101-2)*10 = +990).
  assert.ok(Math.abs(result - (1 - .1 - .02)) < 1e-9, 'got ' + result);
  assert.equal(unrealizedPnlForSymbol([], 'BTCUSDT', 101, 0), 0);
});

async function runScheduler(db, cron) {
  const waits = [];
  await scheduler.scheduled({ cron }, { JPTI_DB: db }, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
}
test('paper scheduler records every failure with a unique id, even when two crons fire in the same minute', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const db = fakeD1();
    await Promise.all([runScheduler(db, '*/1 * * * *'), runScheduler(db, '5 0 * * *')]);
    const health = [...db.events.values()].filter(r => r.kind === 'paper-scheduler-health');
    assert.equal(health.length, 2, 'the second invocation must not be dropped by an id collision');
    assert.equal(new Set(health.map(r => r.id)).size, 2);
    const payload = JSON.parse(health[0].payload);
    assert.equal(payload.mode, 'PAPER_ONLY');
    assert.ok(payload.failures.length >= 10);
  } finally { globalThis.fetch = realFetch; }
});

test('a failing daily review is recorded instead of vanishing as an unhandled rejection', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const db = fakeD1({ failTables: ['jpti_paper_reviews'] });
    await runScheduler(db, '5 0 * * *');
    const health = [...db.events.values()].filter(r => r.kind === 'paper-scheduler-health');
    assert.equal(health.length, 1);
    assert.ok(JSON.parse(health[0].payload).failures.some(f => f.stage === 'daily-review'));
  } finally { globalThis.fetch = realFetch; }
});
