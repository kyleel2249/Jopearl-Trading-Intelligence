import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from './api/[[path]].js';

const TABLES = [
  'jpti_events',
  'jpti_outbox',
  'jpti_scheduler_leases',
  'jpti_schema_migrations',
  'jpti_sync_cursors',
  'jpti_journal_entries'
];
const SNAPSHOT_INDEX = 'jpti_events_market_snapshot_lookup';

function request() {
  return new Request('https://jpti.pages.dev/api/storage/health');
}

function storageEnv({ tables = TABLES, indexPresent = true, kvRead = null } = {}) {
  return {
    JPTI_DB: {
      prepare(sql) {
        if (/type\s*=\s*'index'/i.test(sql)) {
          return {
            bind(name) {
              return {
                first: async () => indexPresent && name === SNAPSHOT_INDEX ? { name } : null
              };
            }
          };
        }
        return { all: async () => ({ results: tables.map((name) => ({ name })) }) };
      }
    },
    JPTI_KV: { get: async (key) => { if (kvRead) kvRead(key); return null; } }
  };
}

test('storage health reports missing Cloudflare bindings without throwing', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env: {} });
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).missingBindings, ['JPTI_DB', 'JPTI_KV']);
});

test('storage health verifies required D1 tables and index and performs a read-only KV lookup', async () => {
  let kvRead = false;
  const env = storageEnv({ kvRead: (key) => { kvRead = key === 'jpti:system:health'; } });
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.d1.connected, true);
  assert.deepEqual(body.d1.indexes, [SNAPSHOT_INDEX]);
  assert.deepEqual(body.d1.missingIndexes, []);
  assert.equal(body.kv.connected, true);
  assert.equal(kvRead, true);
});

test('storage health reports missing schema tables as migration-required', async () => {
  const env = storageEnv({ tables: ['jpti_events'] });
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'migration-required');
  assert.ok(body.d1.missingTables.includes('jpti_outbox'));
  assert.deepEqual(body.d1.missingIndexes, []);
});

test('storage health reports a missing market snapshot index as migration-required', async () => {
  const env = storageEnv({ indexPresent: false });
  const handler = createPagesApiHandler();
  const response = await handler({ request: request(), env });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'migration-required');
  assert.deepEqual(body.d1.missingTables, []);
  assert.deepEqual(body.d1.missingIndexes, [SNAPSHOT_INDEX]);
});
