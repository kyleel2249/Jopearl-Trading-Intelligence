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

const handler = (db, fetchImpl) => createPagesApiHandler({
  marketProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  bitgetCfdProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  fetchImpl
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

test('AI mentor endpoint performs public pair research and returns the Cloudflare AI review', async () => {
  const db = fakeDb();
  const fetchImpl = async url => {
    if (String(url).includes('/search?query=')) return new Response(JSON.stringify({ coins: [{ id: 'sophon', name: 'Sophon', symbol: 'soph', market_cap_rank: 900 }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/coins/sophon?')) return new Response(JSON.stringify({ id: 'sophon', name: 'Sophon', symbol: 'soph', categories: ['Layer 2'], description: { en: 'Sophon project description.' }, market_cap_rank: 900, market_data: { current_price: { usd: 0.001 }, market_cap: { usd: 1000000 }, total_volume: { usd: 500000 }, circulating_supply: 1000000000, total_supply: 10000000000 }, links: { homepage: ['https://sophon.com'] }, last_updated: '2026-11-24T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('news.google.com')) return new Response('<rss><channel><item><title>Sophon product update</title><link>https://example.com/news</link><pubDate>Tue, 24 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    throw new Error('Unexpected research URL: ' + url);
  };
  const ai = { async run(model, input) { assert.equal(model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'); assert.ok(input.messages.length === 2); return { response: '# Executive assessment\\nReview complete.' }; } };
  const req = new Request('https://jpti.example/api/mentor/analyze', { method: 'POST', headers: { 'x-jpti-api-token': 'test-private-token', 'content-type': 'application/json' }, body: JSON.stringify({ entry: { id: 'entry-001', symbol: 'SOPH/USDT', openingNarrative: 'Today I have decided to start anew.' } }) });
  const response = await handler(db, fetchImpl)({ request: req, env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'test-private-token', AI: ai } });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.research.asset.name, 'Sophon');
  assert.equal(data.research.news.length, 1);
  assert.match(data.review, /Executive assessment/);
});

test('AI mentor endpoint reports missing Workers AI binding without pretending to review', async () => {
  const db = fakeDb();
  const req = new Request('https://jpti.example/api/mentor/analyze', { method: 'POST', headers: { 'x-jpti-api-token': 'test-private-token', 'content-type': 'application/json' }, body: JSON.stringify({ entry: { id: 'entry-001', symbol: 'SOPH/USDT' } }) });
  const response = await handler(db)({ request: req, env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'test-private-token' } });
  const data = await response.json();
  assert.equal(response.status, 503);
  assert.equal(data.code, 'WORKERS_AI_BINDING_MISSING');
});
