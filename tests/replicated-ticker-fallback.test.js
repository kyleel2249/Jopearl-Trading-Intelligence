import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const NOW = Date.parse('2026-11-27T02:00:00.000Z');

function makeEnv(observation) {
  return {
    JPTI_KV: { get: async () => null },
    JPTI_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("observation_kind = 'ticker'")) {
              return observation ? {
                payload: JSON.stringify(observation),
                observed_at: observation.observedAt,
                received_at: observation.receivedAt
              } : null;
            }
            return null;
          },
          async all() { return { results: [] }; }
        };
      }
    }
  };
}

function makeObservation(receivedAt) {
  const observedAt = new Date(Date.parse(receivedAt) - 1000).toISOString();
  return {
    exchange: 'bitget',
    marketType: 'spot',
    symbol: 'BTC/USDT',
    kind: 'ticker',
    observedAt,
    receivedAt,
    last: 91000,
    bid: 90999,
    ask: 91001,
    high: 92000,
    low: 90000,
    baseVolume: 123,
    quoteVolume: 11200000,
    changePct: 1.25,
    quality: { stale: false }
  };
}

test('exchange outage serves a recent durable replicated ticker with an explicit stale marker', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
    now: () => new Date(NOW)
  });
  const observation = makeObservation(new Date(NOW - 5 * 60 * 1000).toISOString());
  const response = await handler({
    request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'),
    env: makeEnv(observation)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.last, 91000);
  assert.equal(body.symbol, 'BTC/USDT');
  assert.equal(body.stale, true);
  assert.equal(body.source, 'cloudflare-d1-replicated-history');
  assert.equal(body.replication.durable, true);
  assert.ok(body.replication.ageMs > 0);
});

test('replicated ticker older than the bounded fallback window is not returned as a quote', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
    now: () => new Date(NOW)
  });
  const observation = makeObservation(new Date(NOW - 16 * 60 * 1000).toISOString());
  const response = await handler({
    request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'),
    env: makeEnv(observation)
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, 'Bitget upstream HTTP 403');
});
