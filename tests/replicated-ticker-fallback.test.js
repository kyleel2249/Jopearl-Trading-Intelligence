import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const NOW = Date.parse('2026-11-27T02:00:00.000Z');

function makeEnv(observation, snapshot = null) {
  return {
    JPTI_KV: { get: async () => null },
    JPTI_DB: {
      prepare(sql) {
        return {
          args: [],
          bind(...args) { this.args = args; return this; },
          async first() {
            if (sql.includes("observation_kind = 'ticker'")) {
              const [, marketType, symbol] = this.args;
              if (!observation || observation.marketType !== marketType || observation.symbol !== symbol) return null;
              return { payload: JSON.stringify(observation), observed_at: observation.observedAt, received_at: observation.receivedAt };
            }
            if (sql.includes("kind = 'market-snapshot'")) return snapshot;
            return null;
          },
          async all() { return { results: [] }; }
        };
      }
    }
  };
}

function makeObservation(receivedAt, overrides = {}) {
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
    quality: { stale: false },
    ...overrides
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


test('replicated derivative tickers normalize settlement symbols for all Bitget contract categories', async () => {
  const cases = [
    { type: 'margin', path: 'BTC-USDT', marketType: 'margin', symbol: 'BTC/USDT' },
    { type: 'usdt-m', path: 'BTC-USDT', marketType: 'usdt-m', symbol: 'BTC/USDT:USDT' },
    { type: 'coin-m', path: 'BTC-USD', marketType: 'coin-m', symbol: 'BTC/USD:BTC' },
    { type: 'usdc-m', path: 'BTC-USDC', marketType: 'usdc-m', symbol: 'BTC/USDC:USDC' }
  ];
  for (const item of cases) {
    const handler = createPagesApiHandler({
      marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
      now: () => new Date(NOW)
    });
    const receivedAt = new Date(NOW - 2 * 60 * 1000).toISOString();
    const observation = makeObservation(receivedAt, { marketType: item.marketType, symbol: item.symbol });
    const response = await handler({
      request: new Request('https://jpti.example/api/exchanges/bitget/ticker/' + item.path + '?type=' + item.type),
      env: makeEnv(observation)
    });
    const body = await response.json();
    assert.equal(response.status, 200, item.type);
    assert.equal(body.replication.marketType, item.marketType, item.type);
    assert.equal(body.symbol, item.symbol, item.type);
    assert.equal(body.stale, true, item.type);
    assert.equal(body.source, 'cloudflare-d1-replicated-history', item.type);
  }
});


test('Bitget ticker upstream 404 uses a matching durable D1 quote', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 404, body: { error: 'Exchange answered HTTP 404.' } }) },
    now: () => new Date(NOW)
  });
  const observation = makeObservation(new Date(NOW - 2 * 60 * 1000).toISOString());
  const response = await handler({
    request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'),
    env: makeEnv(observation)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'cloudflare-d1-replicated-history');
  assert.equal(body.exchange, 'bitget');
  assert.equal(body.stale, true);
});


test('replicated ticker fallback rejects crossed quotes, impossible ranges and negative volumes', async () => {
  const invalidCases = [
    { name: 'crossed bid and ask', overrides: { bid: 91002, ask: 91001 } },
    { name: 'negative bid', overrides: { bid: -1 } },
    { name: 'last above 24h high', overrides: { last: 93000 } },
    { name: 'last below 24h low', overrides: { last: 89000 } },
    { name: 'inverted high and low', overrides: { high: 89000, low: 90000 } },
    { name: 'negative base volume', overrides: { baseVolume: -1 } },
    { name: 'negative quote volume', overrides: { quoteVolume: -1 } },
    { name: 'non-finite ask', overrides: { ask: 'not-a-price' } }
  ];
  for (const item of invalidCases) {
    const handler = createPagesApiHandler({
      marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream unavailable' } }) },
      now: () => new Date(NOW)
    });
    const receivedAt = new Date(NOW - 2 * 60 * 1000).toISOString();
    const response = await handler({
      request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'),
      env: makeEnv(makeObservation(receivedAt, item.overrides))
    });
    assert.equal(response.status, 502, item.name);
    assert.equal((await response.json()).error, 'Bitget upstream unavailable', item.name);
  }
});

test('replicated ticker fallback preserves null optional quote fields instead of converting them to zero', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream unavailable' } }) },
    now: () => new Date(NOW)
  });
  const receivedAt = new Date(NOW - 2 * 60 * 1000).toISOString();
  const observation = makeObservation(receivedAt, {
    bid: null, ask: null, high: null, low: null, baseVolume: null, quoteVolume: null, changePct: null
  });
  const response = await handler({
    request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'),
    env: makeEnv(observation)
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  for (const key of ['bid', 'ask', 'high', 'low', 'baseVolume', 'quoteVolume', 'percentage']) {
    assert.equal(body[key], null, key);
  }
});


test('outage fallback never serves another exchange snapshot for a venue-specific ticker request', async () => {
  const handler = createPagesApiHandler({ marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream unavailable' } }) }, now: () => new Date(NOW) });
  const snapshotBody = { exchange: 'bybit', symbol: 'BTC/USDT', last: 60947, bid: 60947, ask: 60947.1, stale: true, source: 'cloudflare-d1-stale', requestedExchange: 'bitget', failedOver: true };
  const response = await handler({ request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'), env: makeEnv(null, { payload: JSON.stringify(snapshotBody), occurred_at: new Date(NOW - 60000).toISOString() }) });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, 'Bitget upstream unavailable');
});

test('outage fallback can still serve a matching same-exchange stored ticker snapshot', async () => {
  const handler = createPagesApiHandler({ marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream unavailable' } }) }, now: () => new Date(NOW) });
  const snapshotBody = { exchange: 'bitget', symbol: 'BTC/USDT', last: 91000, bid: 90999, ask: 91001, stale: false, source: 'cloudflare-edge' };
  const response = await handler({ request: new Request('https://jpti.example/api/exchanges/bitget/ticker/BTC-USDT?type=spot'), env: makeEnv(null, { payload: JSON.stringify(snapshotBody), occurred_at: new Date(NOW - 60000).toISOString() }) });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.exchange, 'bitget');
  assert.equal(body.symbol, 'BTC/USDT');
  assert.equal(body.stale, true);
});
