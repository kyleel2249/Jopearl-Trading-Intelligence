import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunnerReplicationIngestHandler } from '../functions/api/replication/ingest.js';
import { runRunnerReplication } from '../scripts/replicate-market-data.mjs';

const NOW = Date.parse('2026-11-27T02:00:00.000Z');

function makeDb() {
  const observations = new Map();
  const runs = new Map();
  const cursors = new Map();
  return {
    observations, runs, cursors,
    prepare(sql) {
      return {
        sql, args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (sql.startsWith('INSERT INTO jpti_market_replication_runs')) {
            const [runId, startedAt, plan, counts, errors] = this.args;
            runs.set(runId, { run_id: runId, status: 'running', started_at: startedAt, plan_json: plan, counts_json: counts, errors_json: errors });
          } else if (sql.startsWith('UPDATE jpti_market_replication_runs')) {
            const [status, finishedAt, duration, counts, errors, runId] = this.args;
            Object.assign(runs.get(runId), { status, finished_at: finishedAt, duration_ms: duration, counts_json: counts, errors_json: errors });
          } else if (sql.startsWith('INSERT INTO jpti_market_replication_cursors')) {
            cursors.set(this.args[0], this.args[1]);
          }
          return { meta: { changes: 1 } };
        }
      };
    },
    async batch(statements) {
      return statements.map(statement => {
        const [key, exchange, marketType, symbol, kind, timeframe, observedAt, receivedAt, payload, quality] = statement.args;
        const existed = observations.has(key);
        if (!existed) observations.set(key, { observation_key: key, exchange, market_type: marketType, symbol, observation_kind: kind, timeframe, observed_at: observedAt, received_at: receivedAt, payload, quality });
        return { meta: { changes: existed ? 0 : 1 } };
      });
    }
  };
}

function makeTicker(timestamp = NOW - 1000) {
  return { exchange: 'binance', requestedExchange: 'binance', failedOver: false, symbol: 'BTC/USDT', timestamp, last: 91000, bid: 90999, ask: 91001, high: 92000, low: 90000, baseVolume: 12, quoteVolume: 1092000, percentage: 1.2 };
}
const candles = [
  [NOW - 60000, 90000, 91000, 89000, 90500, 10],
  [NOW - 120000, 89000, 90000, 88000, 89500, 8]
];

test('runner ingest authenticates and durably stores venue-verified tickers and candles', async () => {
  const db = makeDb();
  const handler = createRunnerReplicationIngestHandler({ now: () => new Date(NOW), verifyToken: async () => ({ ok: true }) });
  const request = new Request('https://jpti.example/api/replication/ingest', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'secret' },
    body: JSON.stringify({ attempted: 2, observations: [
      { exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ticker', ticker: makeTicker(), sourceExchange: 'binance', requestedExchange: 'binance', failedOver: false },
      { exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ohlcv', timeframe: '1m', candles, sourceExchange: 'binance', requestedExchange: 'binance', failedOver: false }
    ] })
  });
  const response = await handler({ request, env: { JPTI_DB: db } });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.source, 'github-actions-runner');
  assert.equal(body.counts.inserted, 3);
  assert.equal(db.observations.size, 3);
  assert.equal(db.runs.get(body.runId).status, 'completed');
  assert.ok(db.cursors.has('last-successful-run'));
});

test('runner ingest rejects cross-exchange failover data instead of misattributing it', async () => {
  const db = makeDb();
  const handler = createRunnerReplicationIngestHandler({ now: () => new Date(NOW), verifyToken: async () => ({ ok: true }) });
  const response = await handler({
    request: new Request('https://jpti.example/api/replication/ingest', {
      method: 'POST', body: JSON.stringify({ observations: [
        { exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ticker', ticker: makeTicker(), sourceExchange: 'okx', requestedExchange: 'binance', failedOver: true }
      ] })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.status, 'failed');
  assert.equal(db.observations.size, 0);
  assert.match(body.errors[0].error, /Cross-exchange failover/);
});

test('runner ingest validates nested ticker source identity even if wrapper metadata is forged', async () => {
  const db = makeDb();
  const handler = createRunnerReplicationIngestHandler({ now: () => new Date(NOW), verifyToken: async () => ({ ok: true }) });
  const response = await handler({
    request: new Request('https://jpti.example/api/replication/ingest', {
      method: 'POST', body: JSON.stringify({ observations: [
        { exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ticker', ticker: { ...makeTicker(), exchange: 'okx', requestedExchange: 'binance', failedOver: true }, sourceExchange: 'binance', requestedExchange: 'binance', failedOver: false }
      ] })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(db.observations.size, 0);
  assert.match(body.errors[0].error, /Cross-exchange failover/);
});

test('runner ingest rejects unauthenticated writes and oversized observation batches', async () => {
  const db = makeDb();
  const denied = createRunnerReplicationIngestHandler({ verifyToken: async () => ({ ok: false, status: 401, error: 'denied' }) });
  const deniedResponse = await denied({ request: new Request('https://jpti.example/api/replication/ingest', { method: 'POST', body: '{}' }), env: { JPTI_DB: db } });
  assert.equal(deniedResponse.status, 401);
  const accepted = createRunnerReplicationIngestHandler({ verifyToken: async () => ({ ok: true }) });
  const tooMany = Array.from({ length: 121 }, () => ({ exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', kind: 'ticker', ticker: makeTicker() }));
  const oversizedResponse = await accepted({ request: new Request('https://jpti.example/api/replication/ingest', { method: 'POST', body: JSON.stringify({ observations: tooMany }) }), env: { JPTI_DB: db } });
  assert.equal(oversizedResponse.status, 400);
});

test('runner acquires requested venues only and posts validated observations to durable ingest', async () => {
  const paths = [];
  const posts = [];
  const provider = {
    async request(path) {
      paths.push(path);
      if (path.includes('/markets?')) return { status: 200, body: { markets: [{ symbol: 'BTC/USDT', id: 'BTCUSDT', active: true }] } };
      if (path.includes('/ticker/')) return { status: 200, body: makeTicker() };
      if (path.includes('/ohlcv/')) return { status: 200, body: { exchange: 'binance', requestedExchange: 'binance', failedOver: false, candles } };
      return { status: 404, body: { error: 'unknown route' } };
    }
  };
  const summary = await runRunnerReplication({
    endpoint: 'https://jopearl-trading-intelligence.pages.dev/api/replication',
    token: 'secret',
    provider,
    planInput: { exchanges: ['binance'], symbols: ['BTC/USDT'], marketTypes: ['spot'], timeframes: ['1m'], marketLimit: 1, candleLimit: 20 },
    fetchImpl: async (url, init) => {
      posts.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ runId: 'ingest-1', status: 'completed', counts: { inserted: 4, duplicates: 0, valid: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { log() {}, warn() {} }
  });
  assert.equal(summary.status, 'completed');
  assert.equal(summary.counts.succeeded, 3);
  assert.equal(summary.counts.inserted, 4);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://jopearl-trading-intelligence.pages.dev/api/replication/ingest');
  assert.equal(posts[0].init.headers['x-jpti-api-token'], 'secret');
  assert.equal(posts[0].body.observations.length, 3);
  assert.equal(posts[0].body.observations[0].kind, 'markets');
  assert.equal(posts[0].body.observations[0].market.id, 'BTCUSDT');
  assert.ok(paths.filter(path => path.includes('/ticker/') || path.includes('/ohlcv/')).every(path => path.includes('failover=false')));
});

test('runner records a failover response as an error and never persists it under the requested venue', async () => {
  const posts = [];
  const provider = {
    async request(path) {
      if (path.includes('/markets?')) return { status: 200, body: { markets: [{ symbol: 'BTC/USDT', id: 'BTCUSDT', active: true }] } };
      if (path.includes('/ticker/')) return { status: 200, body: { ...makeTicker(), exchange: 'okx', requestedExchange: 'binance', failedOver: true } };
      if (path.includes('/ohlcv/')) return { status: 200, body: { exchange: 'binance', requestedExchange: 'binance', failedOver: false, candles } };
      return null;
    }
  };
  const summary = await runRunnerReplication({
    endpoint: 'https://jopearl-trading-intelligence.pages.dev/api/replication', token: 'secret', provider,
    planInput: { exchanges: ['binance'], symbols: ['BTC/USDT'], marketTypes: ['spot'], timeframes: ['1m'], marketLimit: 1, candleLimit: 20 },
    fetchImpl: async (_url, init) => {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ runId: 'ingest-2', status: 'partial', counts: { inserted: 3, duplicates: 0, valid: 3 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { log() {}, warn() {} }
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.counts.tickers, 0);
  assert.equal(summary.counts.candles, 2);
  assert.equal(posts[0].observations.length, 2);
  assert.equal(posts[0].observations[0].kind, 'markets');
  assert.match(posts[0].errors[0].error, /cross-venue failover data was rejected/i);
});


test('authenticated runner ingest stores exact-venue Bitget market instrument metadata',async()=>{
 const db=makeDb();
 const handler=createRunnerReplicationIngestHandler({now:()=>new Date(NOW),verifyToken:async()=>({ok:true})});
 const response=await handler({request:new Request('https://jpti.example/api/replication/ingest',{
  method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':'secret'},
  body:JSON.stringify({observations:[{
   exchange:'bitget',marketType:'spot',symbol:'BTC/USDT',kind:'markets',
   observedAt:new Date(NOW-1000).toISOString(),
   market:{id:'BTCUSDT',symbol:'BTC/USDT',base:'BTC',quote:'USDT',active:true,productCategory:'SPOT',spot:true},
   sourceExchange:'bitget',requestedExchange:'bitget',failedOver:false
  }]})
 }),env:{JPTI_DB:db}});
 const body=await response.json();
 assert.equal(response.status,200);
 assert.equal(body.counts.markets,1);
 assert.equal(body.counts.inserted,1);
 const saved=[...db.observations.values()][0];
 assert.equal(saved.observation_kind,'markets');
 assert.equal(JSON.parse(saved.payload).id,'BTCUSDT');
});

test('runner ingest rejects market metadata with mismatched product category or inactive instrument',async()=>{
 const db=makeDb();
 const handler=createRunnerReplicationIngestHandler({now:()=>new Date(NOW),verifyToken:async()=>({ok:true})});
 const base={exchange:'bitget',marketType:'spot',symbol:'BTC/USDT',kind:'markets',observedAt:new Date(NOW-1000).toISOString(),sourceExchange:'bitget',requestedExchange:'bitget',failedOver:false};
 const response=await handler({request:new Request('https://jpti.example/api/replication/ingest',{
  method:'POST',body:JSON.stringify({observations:[
   {...base,market:{id:'BTCUSDT',symbol:'BTC/USDT',active:true,productCategory:'USDT-FUTURES'}},
   {...base,market:{id:'BTCUSDT',symbol:'BTC/USDT',active:false,productCategory:'SPOT'}}
  ]})
 }),env:{JPTI_DB:db}});
 const body=await response.json();
 assert.equal(response.status,502);
 assert.equal(body.status,'failed');
 assert.equal(body.counts.inserted,0);
 assert.equal(db.observations.size,0);
});
