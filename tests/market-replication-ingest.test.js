import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketReplicationHandler } from '../functions/api/replication.js';

const NOW = Date.parse('2026-11-27T02:30:00.000Z');

function makeDb() {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() { writes.push({ sql: this.sql, args: this.args }); return { meta: { changes: 1 } }; }
      };
    },
    async batch(statements) {
      for (const statement of statements) writes.push({ sql: statement.sql, args: statement.args });
      return statements.map(() => ({ meta: { changes: 1 } }));
    }
  };
}

function ticker(overrides = {}) {
  return {
    exchange: 'bitget',
    marketType: 'spot',
    symbol: 'BTC/USDT',
    kind: 'ticker',
    observedAt: new Date(NOW - 1000).toISOString(),
    last: 91000,
    bid: 90999,
    ask: 91001,
    high: 92000,
    low: 90000,
    baseVolume: 12,
    quoteVolume: 1092000,
    changePct: 1.2,
    ...overrides
  };
}

function createHandler(db, verifyToken = async () => ({ ok: true })) {
  return createMarketReplicationHandler({
    now: () => new Date(NOW),
    verifyToken
  });
}

test('authenticated runner ingest stores a normalized Bitget ticker in durable D1', async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'test-token' },
      body: JSON.stringify({ mode: 'ingest', observations: [ticker()] })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, 'completed');
  assert.equal(body.counts.valid, 1);
  assert.equal(body.counts.inserted, 1);
  assert.equal(body.source, 'github-actions-direct-ingest');
  assert.ok(db.writes.some(write => write.sql.includes('INSERT INTO jpti_market_observations')));
});

test('runner ingest rejects unsupported market types and malformed prices without storing them', async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'test-token' },
      body: JSON.stringify({ mode: 'ingest', observations: [ticker({ marketType: 'cfd' }), ticker({ last: -1 })] })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.status, 'failed');
  assert.equal(body.counts.inserted, 0);
  assert.equal(body.errorCount, 2);
  assert.ok(!db.writes.some(write => write.sql.includes('INSERT INTO jpti_market_observations')));
});

test('runner ingest rejects unauthenticated writes', async () => {
  const db = makeDb();
  const handler = createHandler(db, async () => ({ ok: false, status: 401, error: 'Replication authorization failed.' }));
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'ingest', observations: [ticker()] })
    }),
    env: { JPTI_DB: db }
  });
  assert.equal(response.status, 401);
  assert.equal(db.writes.length, 0);
});

test('runner ingest rejects timestamps materially in the future', async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'test-token' },
      body: JSON.stringify({ mode: 'ingest', observations: [ticker({ observedAt: new Date(NOW + 60000).toISOString() })] })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.counts.inserted, 0);
});


test('authenticated runner ingest stores integrity-checked OHLCV candles', async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'test-token' },
      body: JSON.stringify({
        mode: 'ingest',
        observations: [{
          exchange: 'bitget', marketType: 'usdt-m', symbol: 'BTC/USDT',
          kind: 'ohlcv', timeframe: '1m',
          observedAt: new Date(NOW - 60000).toISOString(),
          open: 90000, high: 92000, low: 89000, close: 91000, volume: 10
        }]
      })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.counts.candles, 1);
  assert.equal(body.counts.inserted, 1);
  const observationWrite = db.writes.find(write => write.sql.includes('INSERT INTO jpti_market_observations'));
  assert.ok(observationWrite);
});

test('authenticated runner ingest rejects unsupported candle intervals', async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const response = await handler({
    request: new Request('https://jpti.example/api/replication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': 'test-token' },
      body: JSON.stringify({
        mode: 'ingest',
        observations: [{
          exchange: 'bitget', marketType: 'spot', symbol: 'BTC/USDT',
          kind: 'ohlcv', timeframe: '99x',
          observedAt: new Date(NOW - 60000).toISOString(),
          open: 90000, high: 92000, low: 89000, close: 91000, volume: 10
        }]
      })
    }),
    env: { JPTI_DB: db }
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.counts.inserted, 0);
});
