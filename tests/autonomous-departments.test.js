import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('autonomous department migration creates persistent shared-memory and accountability tables', async () => {
  const sql = await readFile(new URL('../migrations/d1/0009_autonomous_departments.sql', import.meta.url), 'utf8');
  for (const table of ['jpti_org_departments','jpti_org_agents','jpti_org_missions','jpti_org_memory','jpti_org_messages','jpti_org_reviews','jpti_org_pulse_runs']) {
    assert.match(sql, new RegExp('CREATE TABLE IF NOT EXISTS ' + table));
  }
  assert.match(sql, /PRIMARY KEY \(review_date, department_id\)/);
  assert.match(sql, /INSERT OR IGNORE INTO jpti_schema_migrations/);
});

test('organization API keeps the three department routes and private authorization boundary wired', async () => {
  const source = await readFile(new URL('../functions/organization-intelligence.js', import.meta.url), 'utf8');
  for (const route of ['/api/org/overview','/api/org/missions','/api/org/autonomy/pulse','/api/org/reviews/daily']) assert.ok(source.includes(route));
  assert.match(source, /JPTI_JOURNAL_TOKEN/);
  assert.match(source, /env\.AI\.run/);
});
