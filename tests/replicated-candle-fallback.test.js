import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const NOW = Date.parse('2026-11-27T03:00:00.000Z');

function makeEnv(symbol, marketType, timeframe = '1m', mutate = () => {}) {
  const observations = Array.from({ length: 24 }, (_, index) => {
    const timestamp = NOW - (24 - index) * 60000;
    return {
      exchange: 'bitget', marketType, symbol, kind: 'ohlcv', timeframe,
      observedAt: new Date(timestamp).toISOString(),
      receivedAt: new Date(NOW - 30000).toISOString(),
      open: 90000 + index, high: 90100 + index, low: 89900 + index,
      close: 90050 + index, volume: 10 + index,
      quality: { stale: false, validOhlc: true }
    };
  });
  mutate(observations);
  return {
    JPTI_DB: {
      prepare(sql) {
        return {
          args: [],
          bind(...args) { this.args = args; return this; },
          async all() {
            if (!sql.includes("observation_kind = 'ohlcv'")) return { results: [] };
            const [, requestedType, requestedSymbol, requestedTimeframe, requestedLimit] = this.args;
            if (requestedType !== marketType || requestedSymbol !== symbol || requestedTimeframe !== timeframe) return { results: [] };
            return { results: observations.slice().reverse().slice(0, Number(requestedLimit) || observations.length).map(payload => ({ payload: JSON.stringify(payload), observed_at: payload.observedAt })) };
          }
        };
      }
    }
  };
}

test('Bitget candle outage serves exact-venue replicated Spot candles, not another exchange', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
    now: () => new Date(NOW)
  });
  const response = await handler({
    request: new Request('https://jpti.test/api/exchanges/bitget/ohlcv/BTC-USDT?type=spot&timeframe=1m&limit=20'),
    env: makeEnv('BTC/USDT', 'spot')
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.exchange, 'bitget');
  assert.equal(body.symbol, 'BTC/USDT');
  assert.equal(body.candles.length, 20);
  assert.equal(body.stale, true);
  assert.equal(body.source, 'cloudflare-d1-replicated-history');
  assert.equal(body.replication.marketType, 'spot');
  assert.ok(body.candles[0][0] < body.candles.at(-1)[0]);
});

test('Bitget contract candle fallback maps settlement symbols for USDT-M, Coin-M and USDC-M', async () => {
  const cases = [
    { type: 'usdt-m', path: 'BTC-USDT', symbol: 'BTC/USDT:USDT' },
    { type: 'coin-m', path: 'BTC-USD', symbol: 'BTC/USD:BTC' },
    { type: 'usdc-m', path: 'BTC-USDC', symbol: 'BTC/USDC:USDC' }
  ];
  for (const item of cases) {
    const handler = createPagesApiHandler({
      marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream HTTP 403' } }) },
      now: () => new Date(NOW)
    });
    const response = await handler({
      request: new Request('https://jpti.test/api/exchanges/bitget/ohlcv/' + item.path + '?type=' + item.type + '&timeframe=1m&limit=30'),
      env: makeEnv(item.symbol, item.type)
    });
    const body = await response.json();
    assert.equal(response.status, 200, item.type);
    assert.equal(body.exchange, 'bitget', item.type);
    assert.equal(body.symbol, item.symbol, item.type);
    assert.equal(body.candles.length, 24, item.type);
    assert.equal(body.stale, true, item.type);
    assert.equal(body.source, 'cloudflare-d1-replicated-history', item.type);
    assert.equal(body.replication.marketType, item.type, item.type);
  }
});


test('Bitget upstream 404 also uses a matching durable candle snapshot', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 404, body: { error: 'Exchange answered HTTP 404.' } }) },
    now: () => new Date(NOW)
  });
  const response = await handler({
    request: new Request('https://jpti.test/api/exchanges/bitget/ohlcv/BTC-USDT?type=spot&timeframe=1m&limit=30'),
    env: makeEnv('BTC/USDT', 'spot')
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.source, 'cloudflare-d1-replicated-history');
  assert.equal(body.exchange, 'bitget');
  assert.equal(body.stale, true);
});


test('replicated candle fallback rejects impossible OHLC, negative volume and invalid timestamps', async () => {
  const handler = createPagesApiHandler({
    marketProvider: { request: async () => ({ status: 502, body: { error: 'Bitget upstream unavailable' } }) },
    now: () => new Date(NOW)
  });
  const env = makeEnv('BTC/USDT', 'spot', '1m', (observations) => {
    observations[0].high = observations[0].close - 1;
    observations[1].volume = -1;
    observations[2].observedAt = 'not-a-timestamp';
  });
  const response = await handler({
    request: new Request('https://jpti.test/api/exchanges/bitget/ohlcv/BTC-USDT?type=spot&timeframe=1m&limit=30'),
    env
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.candles.length, 21);
  assert.ok(body.candles.every((candle) =>
    candle.every(Number.isFinite) &&
    candle[1] > 0 && candle[2] >= Math.max(candle[1], candle[4], candle[3]) &&
    candle[3] <= Math.min(candle[1], candle[4], candle[2]) &&
    candle[5] >= 0
  ));
});
