import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from './api/[[path]].js';

test('Pages API uses the same-origin Cloudflare runtime without an upstream URL', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/health') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, 'cloudflare-edge');
  assert.equal(body.source, 'cloudflare-edge');
});

test('Pages API forwards Bitget derivative chart requests with their product type', async () => {
  let requested = '';
  const handler = createPagesApiHandler({ marketProvider: { request: async (path) => {
    requested = path;
    return { status: 200, body: { exchange: 'bitget', symbol: 'BTC/USDT:USDT', timeframe: '1h', candles: [[1, 1, 2, 0.5, 1.5, 10]] } };
  } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/ohlcv/BTC-USDT%3AUSDT?timeframe=1h&limit=200&type=futures') });
  assert.equal(response.status, 200);
  assert.match(requested, /type=futures/);
  assert.equal((await response.json()).exchange, 'bitget');
});

test('Pages API forwards exact Bitget instrument IDs into intelligence-context candles', async () => {
  let requested = '';
  const candles = Array.from({ length: 30 }, (_, index) => [1700000000000 + index * 3600000, 100 + index, 102 + index, 99 + index, 101 + index, 10 + index]);
  const handler = createPagesApiHandler({ marketProvider: { request: async (path) => {
    requested = path;
    return { status: 200, body: { exchange: 'bitget', symbol: 'BTC/USD:BTC', timeframe: '1h', candles } };
  } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/intelligence/market/bitget/BTC-USD%3ABTC/context?timeframe=1h&type=coin-futures&instrumentId=BTCUSD_CM') });
  assert.equal(response.status, 200);
  assert.match(requested, /type=coin-futures/);
  assert.match(requested, /instrumentId=BTCUSD_CM/);
});

test('Pages API does not claim derivative support for other direct-only exchanges', async () => {
  const handler = createPagesApiHandler({ marketProvider: { request: async () => { throw new Error('should not call provider'); } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=1h&type=futures') });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).code, 'EXCHANGE_PRODUCT_TYPE_UNAVAILABLE');
});
