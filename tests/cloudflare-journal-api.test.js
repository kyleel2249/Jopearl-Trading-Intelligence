import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

function fakeDb() {
  const rows = new Map();
  const events = new Map();
  return {
    rows, events,
    prepare(sql) {
      return {
        async all() {
          if (sql.includes("SELECT name FROM sqlite_master WHERE type = 'table'")) return { results: ['jpti_events','jpti_outbox','jpti_scheduler_leases','jpti_schema_migrations','jpti_sync_cursors','jpti_journal_entries'].map(name=>({name})) };
          return { results: [] };
        },
        bind(...values) {
          return {
            async all() {
              if (sql.includes("SELECT name FROM sqlite_master WHERE type = 'table'")) return { results: ['jpti_events','jpti_outbox','jpti_scheduler_leases','jpti_schema_migrations','jpti_sync_cursors','jpti_journal_entries'].map(name=>({name})) };
              if (sql.includes('SELECT payload, updated_at FROM jpti_journal_entries')) return { results: [...rows.values()].map(row => ({ payload: row.payload, updated_at: row.updated_at })) };
              if (sql.includes('SELECT id, payload, occurred_at FROM jpti_events')) { const kind=values[0],rows=[...events.values()].filter(row=>row.kind===kind).sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)); return { results:rows.slice(0,values[1]).map(row=>({id:row.id,payload:row.payload,occurred_at:row.occurred_at})) }; }
              if (sql.includes('SELECT COUNT(*) AS count FROM jpti_events')) { const kind=values[0]; return { results:[{count:[...events.values()].filter(row=>row.kind===kind).length}] }; }
              if (sql.includes('SELECT payload FROM jpti_events WHERE id = ?')) { const row=events.get(values[0]); return { results:row?[{payload:row.payload}]:[] }; }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO jpti_journal_entries')) { const [owner,id,symbol,payload]=values; rows.set(owner+':'+id,{owner_key:owner,entry_id:id,symbol,payload,updated_at:new Date().toISOString()}); return {success:true,meta:{changes:1}}; }
              if (sql.includes('INSERT OR IGNORE INTO jpti_events')) { const [id,kind,source,external_id,symbol,occurred_at,payload]=values; if(events.has(id))return{success:true,meta:{changes:0}}; events.set(id,{id,kind,source,external_id,symbol,occurred_at,payload}); return{success:true,meta:{changes:1}}; }
              return { success: true, meta: { changes: 0 } };
            },
            async first() { if (sql.includes('sqlite_master')) return { name: values[0] }; return null; }
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

test('Cloudflare storage health verifies the event-time index required for outcome history', async () => {
  const db = fakeDb();
  const response = await handler(db)({ request: new Request('https://jpti.example/api/storage/health'), env: { JPTI_DB: db, JPTI_KV: { async get() { return null; } } } });
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual(data.d1.indexes.sort(), ['jpti_events_kind_time', 'jpti_events_market_snapshot_lookup']);
});
test('Cloudflare health reports private service readiness without exposing secrets', async () => {
  const db = fakeDb();
  const response = await handler(db)({ request: new Request('https://jpti.example/api/health'), env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: 'do-not-return-this', AI: {} } });
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.capabilities.journalAuthConfigured, true);
  assert.equal(data.capabilities.reflectiveJournal, true);
  assert.equal(data.capabilities.sessionOutcomeMemory, true);
  assert.equal(data.capabilities.gainzAlphaOutcomePersistence, true);
  assert.equal(data.capabilities.workersAiMentor, true);
  assert.equal(JSON.stringify(data).includes('do-not-return-this'), false);
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

const privateRequest=(path,method,body,token='test-private-token')=>new Request('https://jpti.example'+path,{method,headers:{...(token?{'x-jpti-api-token':token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
test('Cloudflare session memory API persists, summarizes and de-duplicates outcomes in D1',async()=>{
 const db=fakeDb(),env={JPTI_DB:db,JPTI_JOURNAL_TOKEN:'test-private-token'};
 const saved=await handler(db)({request:privateRequest('/api/session/memory','POST',{id:'session-1',session:'London',symbol:'BTC/USDT',strategy:'liquidity reclaim',volatility:'normal',outcome:'win',returnR:1.75}),env});
 assert.equal(saved.status,201);assert.equal((await saved.json()).storage,'cloudflare-d1');
 const duplicate=await handler(db)({request:privateRequest('/api/session/memory','POST',{id:'session-1',session:'London',symbol:'BTC/USDT',outcome:'win',returnR:1.75}),env});assert.equal((await duplicate.json()).duplicate,true);
 const loaded=await handler(db)({request:privateRequest('/api/session/memory','GET'),env}),data=await loaded.json();assert.equal(data.count,1);assert.equal(data.returned,1);assert.equal(data.summary[0].winRate,100);
});
test('Cloudflare session memory batch imports idempotently and validates outcomes',async()=>{
 const db=fakeDb(),env={JPTI_DB:db,JPTI_JOURNAL_TOKEN:'test-private-token'},records=[{id:'b1',session:'Asia',symbol:'ETH/USDT',outcome:'loss',returnR:-1},{id:'b2',session:'London',symbol:'BTC/USDT',outcome:'breakeven',returnR:0}];
 const first=await handler(db)({request:privateRequest('/api/session/memory/batch','POST',{records}),env});assert.equal((await first.json()).imported,2);
 const again=await handler(db)({request:privateRequest('/api/session/memory/batch','POST',{records}),env});assert.equal((await again.json()).duplicates,2);
 const invalid=await handler(db)({request:privateRequest('/api/session/memory','POST',{outcome:'invalid'}),env});assert.equal(invalid.status,400);
});
test('Cloudflare GainzAlpha outcomes API persists, filters and de-duplicates learning records',async()=>{
 const db=fakeDb(),env={JPTI_DB:db,JPTI_JOURNAL_TOKEN:'test-private-token'};
 const record={id:'gainz-1',setupId:'setup-1',symbol:'BTC/USDT',exchange:'bitget',timeframe:'15m',preset:'balanced',setupType:'sweep-reclaim',direction:'bullish',session:'london',regime:'trend',volRegime:'normal',candleTs:1795500000000,outcome:'win',returnR:1.5,confidence:72,factors:{liquidity:.8,volume:.4}};
 const saved=await handler(db)({request:privateRequest('/api/alpha/gainz/outcomes','POST',{records:[record]}),env});assert.equal((await saved.json()).saved,1);
 const duplicate=await handler(db)({request:privateRequest('/api/alpha/gainz/outcomes','POST',{records:[record]}),env});assert.equal((await duplicate.json()).duplicates,1);
 const loaded=await handler(db)({request:privateRequest('/api/alpha/gainz/outcomes?symbol=BTC%2FUSDT&timeframe=15m','GET'),env});const data=await loaded.json();assert.equal(data.count,1);assert.equal(data.records[0].factors.liquidity,.8);
 const invalid=await handler(db)({request:privateRequest('/api/alpha/gainz/outcomes','POST',{records:[{...record,outcome:'invalid'}]}),env});assert.equal((await invalid.json()).rejected.length,1);
});
test('Cloudflare session and learning routes reject unauthenticated requests',async()=>{
 const db=fakeDb(),env={JPTI_DB:db,JPTI_JOURNAL_TOKEN:'test-private-token'};
 for(const path of ['/api/session/memory','/api/alpha/gainz/outcomes']){const response=await handler(db)({request:privateRequest(path,'GET',null,''),env});assert.equal(response.status,401);}
});
