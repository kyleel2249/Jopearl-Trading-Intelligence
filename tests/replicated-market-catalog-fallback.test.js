import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const NOW = Date.parse('2026-11-27T09:30:00.000Z');

function marketRow({ marketType = 'spot', symbol = 'BTC/USDT', id = 'BTCUSDT', ageMs = 60_000, productCategory = 'SPOT', active = true } = {}) {
  const receivedAt = new Date(NOW - ageMs).toISOString();
  const observedAt = new Date(NOW - ageMs - 1000).toISOString();
  return {
    payload: JSON.stringify({
      exchange: 'bitget', marketType, symbol, kind: 'markets', observedAt, receivedAt,
      id, base: symbol.split('/')[0], quote: symbol.split('/')[1]?.split(':')[0],
      settle: marketType === 'usdt-m' ? 'USDT' : null, active,
      type: marketType === 'spot' ? 'spot' : 'perpetual',
      categories: [marketType], spot: marketType === 'spot', margin: marketType === 'margin',
      swap: ['usdt-m','coin-m','usdc-m'].includes(marketType),
      future: false, contract: ['usdt-m','coin-m','usdc-m'].includes(marketType),
      linear: ['usdt-m','usdc-m'].includes(marketType), inverse: marketType === 'coin-m',
      productCategory, contractType: 'perpetual', instrumentType: 'crypto',
      quality: { timestamped: true, exactVenue: true, activeInstrument: true, stale: false }
    }),
    observed_at: observedAt,
    received_at: receivedAt
  };
}

function makeEnv(rows) {
  return {
    JPTI_KV: { async get() { return null; } },
    JPTI_DB: {
      prepare(sql) {
        return {
          args: [],
          bind(...args) { this.args = args; return this; },
          async all() {
            if (!sql.includes("observation_kind = 'markets'")) return { results: [] };
            const [exchange, ...types] = this.args;
            return { results: rows.filter(row => {
              const payload = JSON.parse(row.payload);
              return payload.exchange === exchange && types.includes(payload.marketType);
            }) };
          },
          async first() { return null; }
        };
      }
    }
  };
}

function createHandler() {
  return createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
    now: () => new Date(NOW)
  });
}

test('Bitget market catalogue outage serves recent exact-venue D1 instrument metadata with stale provenance', async () => {
  const response = await createHandler()({
    request: new Request('https://jpti.test/api/exchanges/bitget/markets?type=spot&search=BTC'),
    env: makeEnv([
      marketRow(),
      marketRow({ symbol: 'ETH/USDT', id: 'ETHUSDT' }),
      marketRow({ symbol: 'BTC/USDT', id: 'WRONG-VENUE', marketType: 'spot', ageMs: 60_000 })
    ])
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.exchange, 'bitget');
  assert.equal(body.count, 1);
  assert.equal(body.markets[0].symbol, 'BTC/USDT');
  assert.equal(body.markets[0].id, 'BTCUSDT');
  assert.equal(body.stale, true);
  assert.equal(body.source, 'cloudflare-d1-replicated-market-catalog');
  assert.equal(body.replication.durable, true);
  assert.ok(body.replication.ageMs > 0);
});

test('Bitget all-category catalogue fallback combines the five supported product categories', async () => {
  const response = await createHandler()({
    request: new Request('https://jpti.test/api/exchanges/bitget/markets?type=all'),
    env: makeEnv([
      marketRow(),
      marketRow({ marketType: 'margin', id: 'BTCUSDT-MARGIN', productCategory: 'MARGIN' }),
      marketRow({ marketType: 'usdt-m', symbol: 'BTC/USDT:USDT', id: 'BTCUSDT_UMCBL', productCategory: 'USDT-FUTURES' }),
      marketRow({ marketType: 'coin-m', symbol: 'BTC/USD:BTC', id: 'BTCUSD_DMCBL', productCategory: 'COIN-FUTURES' }),
      marketRow({ marketType: 'usdc-m', symbol: 'BTC/USDC:USDC', id: 'BTCUSDC_UMCBL', productCategory: 'USDC-FUTURES' })
    ])
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.count, 5);
  assert.equal(body.counts.spot, 1);
  assert.equal(body.counts.margin, 1);
  assert.equal(body.counts.usdtFutures, 1);
  assert.equal(body.counts.coinFutures, 1);
  assert.equal(body.counts.usdcFutures, 1);
  assert.deepEqual(body.replication.marketTypes, ['spot','margin','usdt-m','coin-m','usdc-m']);
});

test('replicated market catalogue rejects expired, inactive and identity-incomplete instruments', async () => {
  const response = await createHandler()({
    request: new Request('https://jpti.test/api/exchanges/bitget/markets?type=spot'),
    env: makeEnv([
      marketRow({ ageMs: 31 * 60 * 1000 }),
      marketRow({ symbol: 'ETH/USDT', id: 'ETHUSDT', active: false }),
      marketRow({ symbol: 'SOL/USDT', id: '' })
    ])
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.error, 'Bitget upstream HTTP 403');
});

test('replicated market catalogue never answers a different exchange request', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bybit upstream unavailable' } }) },
    now: () => new Date(NOW)
  });
  const response = await handler({
    request: new Request('https://jpti.test/api/exchanges/bybit/markets?type=spot'),
    env: makeEnv([marketRow()])
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Bybit upstream unavailable');
});
