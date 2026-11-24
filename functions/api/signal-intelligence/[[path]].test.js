import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from './[[path]].js';

function dbMock() {
  const calls = [];
  return { calls, prepare(sql) { return { bind(...args) { return { sql, args }; } }; }, async batch(items) { calls.push(...items); return []; } };
}

test('signal observation writes require a bounded valid signal list and persist to D1', async () => {
  const db = dbMock();
  const request = new Request('https://jpti.example/api/signal-intelligence/observations', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '198.51.100.1' }, body: JSON.stringify({ signals: [{ signalId: 'bitget:BTC/USDT:1h:123:long', symbol: 'BTC/USDT', direction: 'long', score: 75 }] }) });
  const response = await onRequest({ request, env: { JPTI_DB: db } });
  assert.equal(response.status, 200);
  assert.equal(db.calls.length, 1);
});

test('invalid signal writes fail closed', async () => {
  const request = new Request('https://jpti.example/api/signal-intelligence/observations', { method: 'POST', body: JSON.stringify({ signals: [{ signalId: 'bad', symbol: 'BTC/USDT', direction: 'moon', score: 150 }] }) });
  const response = await onRequest({ request, env: { JPTI_DB: dbMock() } });
  assert.equal(response.status, 400);
});

test('history reads use bounded D1 query', async () => {
  const db = { prepare(sql) { return { bind(limit) { return { async all() { assert.equal(limit, 12); return { results: [] }; } }; } }; } };
  const response = await onRequest({ request: new Request('https://jpti.example/api/signal-intelligence/history?limit=12'), env: { JPTI_DB: db } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).records, []);
});
