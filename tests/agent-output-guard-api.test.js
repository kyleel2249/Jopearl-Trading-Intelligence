import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { handleIntelligenceFoundationApi } from '../functions/intelligence-foundation.js';

const root = fileURLToPath(new URL('..', import.meta.url));

// Minimal D1 shim over node:sqlite so the REAL task runner runs against the REAL migrations.
function createD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = join(root, 'migrations/d1');
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(join(dir, file), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: r.changes } }; }
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { const out = []; for (const s of list) out.push(await s.run()); return out; }, sqlite };
}

const env = (ai, db) => ({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'test-token-test-token-test-token-0001', AI: { run: ai } });
const call = (e, method, path, body) => handleIntelligenceFoundationApi({ env: e, request: new Request('https://jpti.test' + path, { method, headers: { 'x-jpti-api-token': e.JPTI_JOURNAL_TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }) });
const modelJson = (extra = {}) => JSON.stringify({ summary: 'BTC is range-bound.', findings: ['Funding is neutral'], evidence: ['Verified fact: spread is tight'], risks: ['Event risk Friday'], nextActions: ['Re-check at the NY open'], handoffs: [], ...extra });
const task = { title: 'BTC range check', objective: 'Assess BTC range conditions', departmentId: 'research', execute: true };

test('task runner stores readable output instead of JSON and records a clean sample', async () => {
  const db = createD1(); const e = env(async () => ({ response: modelJson() }), db);
  const response = await call(e, 'POST', '/api/intelligence-foundation/agents/tasks', task);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const out = body.task.result.output;
  assert.match(out, /^Summary\nBTC is range-bound\./);
  assert.match(out, /Key findings\n• Funding is neutral/);
  assert.doesNotMatch(out, /[{}"]/);
  assert.equal(body.task.result.structured.summary, 'BTC is range-bound.', 'structured data is still kept for programmatic use');
  assert.deepEqual(body.task.result.outputQuality, { attempts: 1, repaired: false, fellBack: false });
  const quality = await (await call(e, 'GET', '/api/intelligence-foundation/agents/output-quality')).json();
  assert.equal(quality.totals.clean, 1);
});

test('nested-JSON strings trigger exactly one repair retry', async () => {
  const db = createD1(); let calls = 0; const prompts = [];
  const e = env(async (_model, { messages }) => { calls += 1; prompts.push(messages.at(-1).content); return { response: calls === 1 ? modelJson({ summary: '{"inner":"json blob"}' }) : modelJson() }; }, db);
  const body = await (await call(e, 'POST', '/api/intelligence-foundation/agents/tasks', task)).json();
  assert.equal(calls, 2);
  assert.match(prompts[1], /not valid JSON for the required schema/);
  assert.equal(body.task.result.outputQuality.repaired, true);
  const quality = await (await call(e, 'GET', '/api/intelligence-foundation/agents/output-quality')).json();
  assert.equal(quality.totals.repaired, 1);
});

test('a model that never returns JSON falls back to its prose, still readable', async () => {
  const db = createD1(); let calls = 0;
  const e = env(async () => { calls += 1; return { response: 'The market looks calm. Funding is neutral.' }; }, db);
  const body = await (await call(e, 'POST', '/api/intelligence-foundation/agents/tasks', task)).json();
  assert.equal(calls, 2, 'bounded to one retry');
  assert.equal(body.task.result.output, 'The market looks calm. Funding is neutral.');
  assert.equal(body.task.result.outputQuality.fellBack, true);
  const quality = await (await call(e, 'GET', '/api/intelligence-foundation/agents/output-quality')).json();
  assert.equal(quality.totals.fallback, 1); assert.equal(quality.agents[0].cleanRate, 0);
});

test('handoff messages expose priority and can be marked read', async () => {
  const db = createD1(); const e = env(async () => ({ response: modelJson() }), db);
  const created = await call(e, 'POST', '/api/intelligence-foundation/agents/messages', { fromDepartment: 'research', toDepartment: 'trading-social', subject: 'Verify ETF flows', body: 'Check sources', priority: 'urgent' });
  assert.ok([200, 201].includes(created.status), 'message created: ' + created.status);
  db.sqlite.prepare("UPDATE jpti_agent_messages SET priority='urgent'").run();
  let overview = await (await call(e, 'GET', '/api/intelligence-foundation/agents')).json();
  assert.equal(overview.messages[0].priority, 'urgent'); assert.equal(overview.messages[0].status, 'unread');
  const read = await call(e, 'POST', '/api/intelligence-foundation/agents/messages/' + overview.messages[0].id + '/read');
  assert.equal(read.status, 200);
  overview = await (await call(e, 'GET', '/api/intelligence-foundation/agents')).json();
  assert.equal(overview.messages[0].status, 'read');
});
