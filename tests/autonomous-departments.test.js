import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('autonomous department migration creates persistent shared-memory and accountability tables', async () => {
  const sql = await readFile(new URL('../migrations/d1/0009_autonomous_departments.sql', import.meta.url), 'utf8');
  for (const table of ['jpti_org_departments','jpti_org_agents','jpti_org_missions','jpti_org_memory','jpti_org_messages','jpti_org_reviews','jpti_org_pulse_runs','jpti_org_agent_metrics']) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
  assert.match(sql, /PRIMARY KEY \(review_date, department_id\)/);
  assert.match(sql, /kpi_json TEXT NOT NULL/);
  assert.match(sql, /INSERT OR IGNORE INTO jpti_schema_migrations/);
});

test('organization API keeps the three department routes and private authorization boundary wired', async () => {
  const source = await readFile(new URL('../functions/organization-intelligence.js', import.meta.url), 'utf8');
  for (const route of ['/api/org/overview','/api/org/missions','/api/org/autonomy/pulse','/api/org/reviews/daily']) assert.ok(source.includes(route));
  assert.match(source, /JPTI_JOURNAL_TOKEN/);
  assert.match(source, /env\.AI\.run/);
});


test('scheduled department worker uses the persistent organization pulse', async () => {
  const worker = await readFile(new URL('../workers/department-intelligence-scheduler.js', import.meta.url), 'utf8');
  const config = await readFile(new URL('../workers/department-intelligence-scheduler.wrangler.toml', import.meta.url), 'utf8');
  assert.match(worker, /runOrganizationPulse/);
  assert.match(config, /crons = \["0 \*\/6 \* \* \*"\]/);
  assert.match(config, /binding = "JPTI_DB"/);
  assert.match(config, /binding = "AI"/);
});

test('department workspace turns private API authorization failures into a direct settings recovery path', async () => {
  const source = await readFile(new URL('../src/AutonomousDepartments.jsx', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(source, /result\.status === 401/);
  assert.match(source, /this browser session did not present a matching token/);
  assert.match(source, /onOpenSettings/);
  assert.match(source, /Open Connection Settings/);
  assert.match(app, /<AutonomousDepartments onOpenSettings=\{\(\) => activeNav\('Connection Settings'\)\}\/>/);
});
