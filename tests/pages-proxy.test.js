import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

test('Cloudflare Pages health reports the native edge market-data runtime', async () => {
  const handler = createPagesApiHandler({ now: () => new Date('2026-11-23T00:00:00.000Z') });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/health') });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'JPTI Cloudflare Edge Market Data');
  assert.equal(body.liveTradingEnabled, false);
  assert.equal(body.capabilities.publicCandlesticks, true);
  assert.equal(body.capabilities.orderExecution, false);
});

test('Cloudflare Pages routes public chart requests through the normalized market provider', async () => {
  const calls = [];
  const marketProvider = {
    async request(path, options) {
      calls.push({ path, method: options.method });
      return { status: 200, body: { exchange: 'binance', symbol: 'BTC/USDT', candles: [[1, 2, 3, 1, 2.5, 10]] } };
    }
  };
  const handler = createPagesApiHandler({ marketProvider });
  const response = await handler({
    request: new Request('https://jpti.pages.dev/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=1m&limit=200')
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ path: '/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=1m&limit=200', method: 'GET' }]);
  const body = await response.json();
  assert.equal(body.source, 'cloudflare-edge');
  assert.equal(body.candles.length, 1);
});

test('unsupported server-only API routes return an explicit capability response, never proxy elsewhere', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/portfolio/balances') });
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.code, 'CLOUDFLARE_EDGE_ROUTE_UNAVAILABLE');
});

test('Cloudflare Pages edge API rejects writes and handles preflight', async () => {
  const handler = createPagesApiHandler();
  const denied = await handler({ request: new Request('https://jpti.pages.dev/api/orders', { method: 'POST' }) });
  assert.equal(denied.status, 405);
  const options = await handler({ request: new Request('https://jpti.pages.dev/api/health', { method: 'OPTIONS' }) });
  assert.equal(options.status, 204);
});

test('Cloudflare Pages builds chart context from closed OHLCV candles with explicit limitations', async () => {
  const candles = Array.from({ length: 30 }, (_, index) => {
    const close = 100 + index;
    return [index * 60000, close - 0.5, close + 1, close - 1, close, 100 + index * 2];
  });
  const marketProvider = {
    async request(path) {
      assert.match(path, /ohlcv/);
      return { status: 200, body: { candles } };
    }
  };
  const handler = createPagesApiHandler({ marketProvider, now: () => new Date('2026-11-23T12:00:00.000Z') });
  const response = await handler({
    request: new Request('https://jpti.pages.dev/api/intelligence/market/binance/BTC-USDT/context?timeframe=1h')
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.market.exchange, 'binance');
  assert.equal(body.multiTimeframe[0].timeframe, '1h');
  assert.ok(Number.isFinite(body.score.score));
  assert.equal(body.market.orderBookImbalancePct, null);
  assert.match(body.limitations[1], /not included/);
});

test('Cloudflare edge API permits only the standard Capacitor WebView origin for native requests', async () => {
  const handler = createPagesApiHandler();
  const allowed = await handler({
    request: new Request('https://jpti.pages.dev/api/health', { headers: { origin: 'capacitor://localhost' } })
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const denied = await handler({
    request: new Request('https://jpti.pages.dev/api/health', { headers: { origin: 'https://attacker.example' } })
  });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('Cloudflare edge API refuses unsupported derivatives on spot-only exchanges', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({
    request: new Request('https://jpti.pages.dev/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=1h&type=futures')
  });
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.code, 'EXCHANGE_PRODUCT_TYPE_UNAVAILABLE');
  assert.deepEqual(body.supportedTypes, ['spot']);
});
