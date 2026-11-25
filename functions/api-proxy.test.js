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
  assert.equal(body.capabilities.bitgetCfd, true);
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
  assert.match(requested, /BTC-USD%3ABTC/);
  assert.doesNotMatch(requested, /%253A/);
  assert.match(requested, /type=coin-futures/);
  assert.match(requested, /instrumentId=BTCUSD_CM/);
});



test('Pages API exposes sanitized Bitget CFD account diagnostics', async () => {
  const handler = createPagesApiHandler({ bitgetCfdProvider: { request: async (_env, args) => {
    assert.equal(args.kind, 'diagnostics');
    return { status: 200, body: { exchange: 'bitget', productType: 'cfd', authenticated: true, permissionType: 'read-only', permissions: ['uta_trade'], utaTradeReadOnly: true, ipWhitelistConfigured: false, ipWhitelistCount: 0 } };
  } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/cfd/diagnostics') });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.utaTradeReadOnly, true);
  assert.equal('userId' in body, false);
});

test('Pages API routes Bitget CFD instrument catalog through the signed edge provider', async () => {
  let requestArgs;
  const handler = createPagesApiHandler({ bitgetCfdProvider: { request: async (env, args) => {
    requestArgs = { env, args };
    return { status: 200, body: { exchange: 'bitget', markets: [{ symbol: 'XAUUSD.s', id: 'XAUUSD.s', cfd: true }], count: 1, timeframes: ['1m','15m','1h','4h','1d'] } };
  } } });
  const env = { JPTI_BITGET_API_KEY: 'server-secret-only' };
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/markets?type=cfd&search=xau'), env });
  assert.equal(response.status, 200);
  assert.equal(requestArgs.args.kind, 'markets');
  assert.equal(requestArgs.args.search, 'xau');
  assert.equal(requestArgs.env, env);
  assert.equal((await response.json()).markets[0].symbol, 'XAUUSD.s');
});

test('Pages API routes Bitget CFD ticker and OHLCV requests without using crypto symbol parsing', async () => {
  const calls = [];
  const handler = createPagesApiHandler({ bitgetCfdProvider: { request: async (_env, args) => {
    calls.push(args);
    return args.kind === 'ticker'
      ? { status: 200, body: { symbol: args.symbol, last: 2620.55, priceType: 'bid-ask-midpoint' } }
      : { status: 200, body: { symbol: args.symbol, side: args.side, candles: [[1,2,3,1,2,0]], volumeAvailable: false } };
  } } });
  const ticker = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/ticker/XAUUSD.s?type=cfd') });
  assert.equal(ticker.status, 200);
  assert.equal((await ticker.json()).last, 2620.55);
  const candles = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/ohlcv/XAUUSD.s?type=cfd&timeframe=1h&side=sell&limit=80') });
  assert.equal(candles.status, 200);
  assert.equal((await candles.json()).side, 'sell');
  assert.equal(calls[0].kind, 'ticker');
  assert.equal(calls[1].kind, 'ohlcv');
  assert.equal(calls[1].side, 'sell');
  assert.equal(calls[1].limit, '80');
});


test('Pages API builds Bitget CFD intelligence context from the selected candle side', async () => {
  let requestArgs;
  const handler = createPagesApiHandler({ bitgetCfdProvider: { request: async (_env, args) => {
    requestArgs = args;
    return { status: 200, body: { exchange: 'bitget', symbol: args.symbol, timeframe: args.timeframe, side: args.side, candles: Array.from({ length: 30 }, (_, index) => [1700000000000 + index * 3600000, 100 + index, 102 + index, 99 + index, 101 + index, 0]) } };
  } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/intelligence/market/bitget/XAUUSD.s/context?timeframe=1h&type=cfd&side=sell') });
  assert.equal(response.status, 200);
  assert.equal(requestArgs.kind, 'ohlcv');
  assert.equal(requestArgs.symbol, 'XAUUSD.s');
  assert.equal(requestArgs.side, 'sell');
  assert.equal((await response.json()).market.volumeChangePct, null);
});

test('Pages API returns a clear credential requirement when Bitget CFD secrets are missing', async () => {
  const handler = createPagesApiHandler();
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/bitget/markets?type=cfd'), env: {} });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'BITGET_CFD_CREDENTIALS_REQUIRED');
});

test('Pages API does not claim derivative support for other direct-only exchanges', async () => {
  const handler = createPagesApiHandler({ marketProvider: { request: async () => { throw new Error('should not call provider'); } } });
  const response = await handler({ request: new Request('https://jpti.pages.dev/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=1h&type=futures') });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).code, 'EXCHANGE_PRODUCT_TYPE_UNAVAILABLE');
});

// Minimal in-memory Workers KV stand-in that records every put() so TTL options can be asserted.
function createFakeKv() {
  const store = new Map();
  const puts = [];
  return {
    puts,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, options = {}) {
      puts.push({ key, options });
      store.set(key, value);
    }
  };
}

test('Pages API writes market cache entries with a Workers KV compliant TTL and serves them while fresh', async () => {
  const kv = createFakeKv();
  let upstreamCalls = 0;
  const handler = createPagesApiHandler({ marketProvider: { request: async () => {
    upstreamCalls += 1;
    return { status: 200, body: { exchange: 'binance', symbol: 'BTC/USDT', last: 100 } };
  } } });
  const env = { JPTI_KV: kv };
  const makeRequest = () => new Request('https://jpti.pages.dev/api/exchanges/binance/ticker/BTC-USDT');
  const first = await handler({ request: makeRequest(), env });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-jpti-cache'), 'miss');
  assert.ok(kv.puts.length > 0, 'the response should be written to KV');
  for (const { options } of kv.puts) {
    assert.ok(options.expirationTtl >= 60, 'Workers KV rejects expirationTtl below 60 seconds, received ' + options.expirationTtl);
  }
  const second = await handler({ request: makeRequest(), env });
  assert.equal(second.headers.get('x-jpti-cache'), 'hit');
  assert.equal(upstreamCalls, 1);
});

test('Pages API ignores KV market entries older than their intended freshness window', async () => {
  const kv = createFakeKv();
  let upstreamCalls = 0;
  // Entries are stamped one minute in the past, far older than the 8 second ticker window.
  const handler = createPagesApiHandler({ now: () => new Date(Date.now() - 60000), marketProvider: { request: async () => {
    upstreamCalls += 1;
    return { status: 200, body: { exchange: 'binance', symbol: 'BTC/USDT', last: 100 } };
  } } });
  const env = { JPTI_KV: kv };
  const makeRequest = () => new Request('https://jpti.pages.dev/api/exchanges/binance/ticker/BTC-USDT');
  await handler({ request: makeRequest(), env });
  const second = await handler({ request: makeRequest(), env });
  assert.equal(second.headers.get('x-jpti-cache'), 'miss');
  assert.equal(upstreamCalls, 2);
});

test('Pages API keeps multi-timeframe context separate for each requested timeframe', async () => {
  const kv = createFakeKv();
  const candles = Array.from({ length: 30 }, (_, index) => [1700000000000 + index * 3600000, 100 + index, 102 + index, 99 + index, 101 + index, 10 + index]);
  const offlineFetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
  const handler = createPagesApiHandler({
    fetchImpl: offlineFetch,
    marketProvider: { request: async () => ({ status: 200, body: { exchange: 'binance', symbol: 'BTC/USDT', candles } }) }
  });
  const env = { JPTI_KV: kv };
  const timeframesFor = async (timeframe) => {
    const response = await handler({ request: new Request('https://jpti.pages.dev/api/intelligence/market/binance/BTC-USDT/context?timeframe=' + timeframe), env });
    assert.equal(response.status, 200);
    return (await response.json()).multiTimeframe.map((item) => item.timeframe);
  };
  assert.deepEqual(await timeframesFor('1h'), ['1h', '4h', '1d', '1w']);
  // Requested straight after 1h on the same KV: it must not receive the 1h request's cached frames.
  assert.deepEqual(await timeframesFor('4h'), ['4h', '1d', '1w', '1h']);
});
