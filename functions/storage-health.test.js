import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from './api/[[path]].js';

const TABLES = [
  'jpti_events',
  'jpti_outbox',
  'jpti_scheduler_leases',
  'jpti_schema_migrations',
  'jpti_sync_cursors'
];

function request() {
  return new Request('https://jpti.pages.dev/api/storage/health');
}

test('storage health reports missing Cloudflare bindings without throwing', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).missingBindings, ['JPTI_DB', 'JPTI_KV']);
});

test('storage health verifies D1 schema and performs a read-only KV lookup', async () => {
  let kvRead = false;
  const env = {
    JPTI_DB: {
      prepare(sql) {
        assert.match(sql, /sqlite_master/);
        return { all: async () => ({ results: TABLES.map((name) => ({ name })) }) };
      }
    },
    JPTI_KV: { get: async (key) => { kvRead = key === 'jpti:system:health'; return null; } }
  };
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.d1.connected, true);
  assert.equal(body.kv.connected, true);
  assert.equal(kvRead, true);
});

test('storage health reports missing schema tables as migration-required', async () => {
  const env = {
    JPTI_DB: { prepare: () => ({ all: async () => ({ results: [{ name: 'jpti_events' }] }) }) },
    JPTI_KV: { get: async () => null }
  };
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'migration-required');
  assert.ok(body.d1.missingTables.includes('jpti_outbox'));
});
