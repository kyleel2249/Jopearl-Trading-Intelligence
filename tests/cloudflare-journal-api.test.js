import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              if (sql.includes('SELECT payload, updated_at FROM jpti_journal_entries')) {
                return { results: [...rows.values()].map(row => ({ payload: row.payload, updated_at: row.updated_at })) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO jpti_journal_entries')) {
                const [owner, id, symbol, payload] = values;
                rows.set(owner + ':' + id, { owner_key: owner, entry_id: id, symbol, payload, updated_at: new Date().toISOString() });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async first() { return null; }
          };
        }
      };
    }
  };
}

const handler = db => createPagesApiHandler({
  marketProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  bitgetCfdProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } }
});
const request = (method, body, token = 'test-private-token') => new Request('https://jpti.example/api/journal/entries', {
  method,
  headers: { ...(token ? { 'x-jpti-api-token': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
});

test('Cloudflare journal API denies unauthenticated reads', async () => {
  const db = fakeDb();
  const response = await handler(db)({ request: request('GET', null, ''), env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'test-private-token' } });
  assert.equal(response.status, 401);
});

test('Cloudflare journal API persists and returns authenticated entries', async () => {
  const db = fakeDb();
  const entry = { id: 'entry-001', symbol: 'SOPH/USDT', direction: 'long', entryPrice: 0.000815 };
  const env = { JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'test-private-token' };
  const saved = await handler(db)({ request: request('POST', { entry }), env });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).durable, true);
  const loaded = await handler(db)({ request: request('GET', null), env });
  const payload = await loaded.json();
  assert.equal(loaded.status, 200);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.entries[0], entry);
});

test('Cloudflare journal API refuses writes when its private secret is missing', async () => {
  const db = fakeDb();
  const response = await handler(db)({ request: request('POST', { entry: { id: 'entry-001', symbol: 'SOPH/USDT' } }), env: { JPTI_DB: db } });
  assert.equal(response.status, 503);
});
