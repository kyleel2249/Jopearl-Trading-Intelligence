import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertAiBudget, checkAiBudget, evaluateBudget, parseLimit } from '../functions/ai-budget.js';
import { recordOutputQuality } from '../functions/output-quality.js';

const root = fileURLToPath(new URL('..', import.meta.url));
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(join(root, 'migrations/d1')).sort()) sqlite.exec(readFileSync(join(root, 'migrations/d1', f), 'utf8'));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => sqlite.prepare(sql).get(...args) ?? null, all: async () => ({ results: sqlite.prepare(sql).all(...args) }), run: async () => ({ meta: { changes: sqlite.prepare(sql).run(...args).changes } }) });
  return { prepare: (sql) => stmt(sql), sqlite };
}

test('limit parsing', () => {
  assert.equal(parseLimit('25', 60), 25); assert.equal(parseLimit('', 60), 60); assert.equal(parseLimit('abc', 60), 60); assert.equal(parseLimit('-3', 60), 60);
  assert.equal(parseLimit('unlimited', 60), Infinity); assert.equal(parseLimit(undefined, 7), 7);
});

test('budget evaluation distinguishes hourly and daily exhaustion', () => {
  assert.equal(evaluateBudget({ hourlyUsed: 59, dailyUsed: 10, hourlyLimit: 60, dailyLimit: 400 }).ok, true);
  assert.equal(evaluateBudget({ hourlyUsed: 60, dailyUsed: 10, hourlyLimit: 60, dailyLimit: 400 }).scope, 'hourly');
  assert.equal(evaluateBudget({ hourlyUsed: 5, dailyUsed: 399, hourlyLimit: 60, dailyLimit: 400, needed: 4 }).scope, 'daily');
});

test('real D1: calls are counted from logged attempts and block at the cap with a 429', async () => {
  const db = d1();
  const env = { JPTI_AI_HOURLY_LIMIT: '4', JPTI_AI_DAILY_LIMIT: '100' };
  assert.equal((await checkAiBudget(db, env)).hourly.used, 0);
  await recordOutputQuality(db, { agentKey: 'a', source: 't', result: { attempts: 2, repaired: true, fellBack: false, reasons: [] } });
  await recordOutputQuality(db, { agentKey: 'a', source: 't', result: { attempts: 1, repaired: false, fellBack: false, reasons: [] } });
  const mid = await checkAiBudget(db, env);
  assert.equal(mid.hourly.used, 3); assert.equal(mid.ok, true); assert.equal(mid.measured, true);
  await assert.rejects(() => assertAiBudget(db, env, { needed: 2 }), (e) => e.status === 429 && /AI call budget reached: 3 of 4/.test(e.message) && /JPTI_AI_HOURLY_LIMIT/.test(e.message));
  db.sqlite.prepare("UPDATE jpti_agent_output_quality SET created_at='2020-01-01T00:00:00.000Z'").run();
  assert.equal((await checkAiBudget(db, env)).daily.used, 0, 'old calls fall out of the window');
});

test('fails open when telemetry is unreadable and says so', async () => {
  const broken = { prepare: () => { throw new Error('D1 down'); } };
  const r = await checkAiBudget(broken, {});
  assert.equal(r.ok, true); assert.equal(r.measured, false); assert.match(r.unavailable, /D1 down/);
});
