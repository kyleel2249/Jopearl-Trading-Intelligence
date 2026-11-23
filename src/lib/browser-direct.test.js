import test from 'node:test';
import assert from 'node:assert/strict';
import { createCircuit } from './api-circuit.js';
import {
  DIRECT_EXCHANGES, createDirectProvider, matchDirectRoute, parseSymbol, venueSymbol, tickerUrl, candlesUrl, marketsUrl, parsers, DirectError
} from './browser-direct.js';

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const PAYLOADS = {
  binanceTicker: { symbol: 'BTCUSDT', lastPrice: '98123.45', bidPrice: '98123.00', askPrice: '98124.00', highPrice: '99000', lowPrice: '97000', volume: '1234.5', quoteVolume: '120000000', priceChangePercent: '1.20', closeTime: 1700000000000 },
  bybitTicker: { retCode: 0, time: 1700000000000, result: { list: [{ symbol: 'BTCUSDT', lastPrice: '98123.45', bid1Price: '98123', ask1Price: '98124', highPrice24h: '99000', lowPrice24h: '97000', volume24h: '1234.5', turnover24h: '1.2e8', price24hPcnt: '0.012' }] } },
  okxTicker: { code: '0', data: [{ instId: 'BTC-USDT', last: '101', bidPx: '100.9', askPx: '101.1', open24h: '100', high24h: '102', low24h: '99', vol24h: '10', volCcy24h: '1000', ts: '1700000000000' }] },
  bitgetTicker: { code: '00000', data: [{ symbol: 'BTCUSDT', lastPr: '98123.45', bidPr: '98123', askPr: '98124', high24h: '99000', low24h: '97000', baseVolume: '1234.5', quoteVolume: '1.2e8', change24h: '0.012', ts: '1700000000000' }] },
  binanceKlines: [[1700000900000, '2', '3', '1', '2.5', '10'], [1700000000000, '1', '2', '0.5', '1.5', '8']], // deliberately newest-first
  bybitKlines: { retCode: 0, result: { list: [['1700000900000', '2', '3', '1', '2.5', '10', '25'], ['1700000000000', '1', '2', '0.5', '1.5', '8', '12']] } },
  okxCandles: { code: '0', data: [['1700000900000', '2', '3', '1', '2.5', '10', '25', '25', '1'], ['1700000000000', '1', '2', '0.5', '1.5', '8', '12', '12', '1']] },
  bitgetCandles: { code: '00000', data: [['1700000000000', '1', '2', '0.5', '1.5', '8', '12', '12'], ['1700000900000', '2', '3', '1', '2.5', '10', '25', '25']] }
};

test('symbols are validated and mapped to each venue format', () => {
  assert.deepEqual(parseSymbol('btc-usdt'), { base: 'BTC', quote: 'USDT', symbol: 'BTC/USDT' });
  assert.equal(venueSymbol('okx', parseSymbol('ETH/USDT')), 'ETH-USDT');
  assert.equal(venueSymbol('binance', parseSymbol('ETH/USDT')), 'ETHUSDT');
  for (const bad of ['BTC/USDT:USDT', 'BTC', '', 'A/B', 'BTC/USDT/EXTRA', '../etc']) assert.throws(() => parseSymbol(bad), DirectError, bad);
});

test('route matching covers only the supported GET routes and never absolute URLs', () => {
  assert.equal(matchDirectRoute('/api/health').kind, 'health');
  assert.equal(matchDirectRoute('/api/exchanges').kind, 'catalog');
  assert.equal(matchDirectRoute('/api/exchanges/compare/ticker?symbol=BTC%2FUSDT').kind, 'compare');
  assert.deepEqual(matchDirectRoute('/api/exchanges/binance/ticker/BTC-USDT'), { kind: 'ticker', exchange: 'binance', symbol: 'BTC-USDT', query: {} });
  assert.equal(matchDirectRoute('/api/exchanges/okx/ohlcv/BTC-USDT?timeframe=15m&limit=50').query.timeframe, '15m');
  assert.equal(matchDirectRoute('/api/exchanges/bybit/markets?type=spot').kind, 'markets');
  assert.equal(matchDirectRoute('/api/exchanges/binance/orders', 'POST'), null);
  assert.equal(matchDirectRoute('/api/exchanges/binance/balance'), null);
  assert.equal(matchDirectRoute('/api/ledger'), null);
  assert.equal(matchDirectRoute('https://evil.example/api/health'), null);
});

test('ticker parsers return the API field names for all four venues', () => {
  const b = parsers.ticker.binance(PAYLOADS.binanceTicker);
  assert.equal(b.last, 98123.45); assert.equal(b.percentage, 1.2); assert.equal(b.quoteVolume, 120000000);
  assert.equal(parsers.ticker.bybit(PAYLOADS.bybitTicker).percentage, 1.2);
  const o = parsers.ticker.okx(PAYLOADS.okxTicker);
  assert.equal(o.last, 101); assert.ok(Math.abs(o.percentage - 1) < 1e-9);
  assert.equal(parsers.ticker.bitget(PAYLOADS.bitgetTicker).last, 98123.45);
  assert.throws(() => parsers.ticker.bybit({ retCode: 10001, retMsg: 'params error' }), /params error/);
  assert.throws(() => parsers.ticker.okx({ code: '51001', msg: 'Instrument ID does not exist' }), /Instrument/);
  assert.throws(() => parsers.ticker.binance({ code: -1121, msg: 'Invalid symbol.' }), DirectError);
});

test('candle parsers return ascending numeric rows regardless of the venue order', () => {
  for (const [venue, payload] of [['binance', PAYLOADS.binanceKlines], ['bybit', PAYLOADS.bybitKlines], ['okx', PAYLOADS.okxCandles], ['bitget', PAYLOADS.bitgetCandles]]) {
    const rows = parsers.candles[venue](payload);
    assert.deepEqual(rows.map((r) => r[0]), [1700000000000, 1700000900000], venue);
    assert.deepEqual(rows[0], [1700000000000, 1, 2, 0.5, 1.5, 8], venue);
  }
  assert.throws(() => parsers.candles.binance([]), /No candles/);
  assert.throws(() => parsers.candles.binance([[1, 'x', 2, 1, 1, 1]]), /No candles/); // malformed rows are dropped
});

test('urls use each venue format and reject unsupported timeframes', () => {
  const s = parseSymbol('BTC/USDT');
  assert.match(tickerUrl('okx', s), /instId=BTC-USDT$/);
  assert.match(tickerUrl('bybit', s), /category=spot&symbol=BTCUSDT$/);
  assert.match(candlesUrl('bybit', s, '1h', 100), /interval=60&limit=100$/);
  assert.match(candlesUrl('okx', s, '4h', 999), /bar=4H&limit=300$/);
  assert.match(candlesUrl('bitget', s, '1d', 50), /granularity=1day/);
  assert.throws(() => candlesUrl('bitget', s, '3m', 50), /Unsupported timeframe/);
  assert.match(marketsUrl('binance'), /exchangeInfo/);
});

test('provider serves ticker and candles in the API shape and caches repeated calls', async () => {
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; return json(String(url).includes('klines') ? PAYLOADS.binanceKlines : PAYLOADS.binanceTicker); };
  let t = 1000;
  const provider = createDirectProvider({ fetchImpl, now: () => t });
  const a = await provider.request('/api/exchanges/binance/ticker/BTC-USDT');
  assert.equal(a.status, 200);
  assert.equal(a.body.exchange, 'binance'); assert.equal(a.body.symbol, 'BTC/USDT'); assert.equal(a.body.last, 98123.45);
  assert.equal(a.body.source, 'browser-direct'); assert.equal(a.body.failedOver, false);
  await provider.request('/api/exchanges/binance/ticker/BTC-USDT');
  assert.equal(calls, 1, 'second call inside the TTL is served from cache');
  t += 4000;
  await provider.request('/api/exchanges/binance/ticker/BTC-USDT');
  assert.equal(calls, 2, 'cache expires');
  const c = await provider.request('/api/exchanges/binance/ohlcv/BTC-USDT?timeframe=15m&limit=20');
  assert.equal(c.body.timeframe, '15m'); assert.equal(c.body.candles.length, 2); assert.ok(c.body.candles[0][0] < c.body.candles[1][0]);
});

test('provider fails over to the next venue and says so', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('api.binance.com')) return json({ msg: 'Service unavailable from a restricted location' }, 451);
    if (String(url).includes('api.bybit.com')) throw new TypeError('Failed to fetch');
    return json(PAYLOADS.okxTicker);
  };
  const r = await createDirectProvider({ fetchImpl }).request('/api/exchanges/binance/ticker/BTC-USDT');
  assert.equal(r.status, 200);
  assert.equal(r.body.exchange, 'okx'); assert.equal(r.body.requestedExchange, 'binance'); assert.equal(r.body.failedOver, true);
});

test('provider reports failure (not invented data) when every venue is down, and 404 for bad symbols', async () => {
  const down = createDirectProvider({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  const r = await down.request('/api/exchanges/binance/ticker/BTC-USDT');
  assert.equal(r.failed, true); assert.equal(r.status, 502); assert.ok(r.body.error);
  const bad = await down.request('/api/exchanges/binance/ticker/BTC-USDT:USDT');
  assert.equal(bad.status, 404);
  const unsupportedFrame = await createDirectProvider({ fetchImpl: async () => json({}) }).request('/api/exchanges/bitget/ohlcv/BTC-USDT?timeframe=3m');
  assert.equal(unsupportedFrame.status, 400);
  assert.equal(await down.request('/api/ledger'), null);
});

test('timeouts abort a hung exchange instead of waiting forever', async () => {
  const hung = (url, init) => new Promise((_, reject) => {
    const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (init.signal.aborted) fail(); else init.signal.addEventListener('abort', fail, { once: true }); // like a real fetch
  });
  const started = Date.now();
  const provider = createDirectProvider({ fetchImpl: hung });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const r = await provider.request('/api/exchanges/okx/ticker/BTC-USDT', { signal: controller.signal });
  assert.equal(r.failed, true);
  assert.equal(r.status, 499, 'a cancelled request stops instead of trying the other venues');
  assert.ok(Date.now() - started < 2000);
});

test('health never claims the API is up; catalog lists the four venues', async () => {
  const p = createDirectProvider({ fetchImpl: async () => json({}) });
  const h = (await p.request('/api/health')).body;
  assert.equal(h.status, 'degraded'); assert.equal(h.directMode, true); assert.equal(h.liveTradingEnabled, false);
  const c = (await p.request('/api/exchanges')).body;
  assert.deepEqual(c.exchanges.map((e) => e.id), DIRECT_EXCHANGES);
  assert.ok(c.exchanges.every((e) => e.capabilities.createOrder === false && e.capabilities.balance === false));
});

test('markets: spot list is parsed, searchable and non-spot filters are empty', async () => {
  const info = { symbols: [{ symbol: 'BTCUSDT', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT' }, { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' }, { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT' }] };
  const p = createDirectProvider({ fetchImpl: async () => json(info) });
  const all = (await p.request('/api/exchanges/binance/markets?type=all')).body;
  assert.equal(all.totalMarkets, 2); assert.deepEqual(all.markets.map((m) => m.symbol), ['BTC/USDT', 'ETH/BTC']);
  assert.equal((await p.request('/api/exchanges/binance/markets?search=eth')).body.count, 1);
  assert.equal((await p.request('/api/exchanges/binance/markets?type=perpetual')).body.count, 0);
  assert.equal((await p.request('/api/exchanges/kraken/markets')).status, 404);
});

test('circuit breaker opens after repeated failures, probes once after cooldown, and recovers', () => {
  let t = 0;
  const c = createCircuit({ failureThreshold: 2, cooldownMs: 1000, maxCooldownMs: 4000, now: () => t });
  assert.equal(c.shouldTryApi(), true);
  c.failure(); assert.equal(c.shouldTryApi(), true);
  c.failure(); assert.equal(c.snapshot().state, 'open'); assert.equal(c.shouldTryApi(), false);
  t = 999; assert.equal(c.shouldTryApi(), false);
  t = 1000; assert.equal(c.shouldTryApi(), true, 'one probe after the cooldown');
  assert.equal(c.shouldTryApi(), false, 'concurrent callers do not all probe');
  c.failure(); // probe failed: longer cooldown (2000)
  t = 2500; assert.equal(c.shouldTryApi(), false);
  t = 3000; assert.equal(c.shouldTryApi(), true);
  c.success(); assert.equal(c.snapshot().state, 'closed'); assert.equal(c.shouldTryApi(), true);
});


test('direct multi-exchange comparison returns per-venue observations and indicative spread', async () => {
  const payloadByHost = {
    'api.binance.com': PAYLOADS.binanceTicker,
    'api.bybit.com': PAYLOADS.bybitTicker,
    'www.okx.com': PAYLOADS.okxTicker,
    'api.bitget.com': PAYLOADS.bitgetTicker
  };
  const provider = createDirectProvider({ fetchImpl: async (url) => {
    const host = new URL(url).hostname;
    return json(payloadByHost[host]);
  } });
  const result = await provider.request('/api/exchanges/compare/ticker?symbol=BTC%2FUSDT&exchanges=binance,bybit,okx,bitget');
  assert.equal(result.status, 200);
  assert.equal(result.body.source, 'browser-direct');
  assert.equal(result.body.venueCount, 4);
  assert.equal(result.body.venues.length, 4);
  assert.equal(result.body.results.filter((item) => item.status === 'ok').length, 4);
  assert.equal(result.body.medianLast, 98123.45);
  assert.ok(result.body.bestIndicativeTopOfBook);
  assert.ok(Array.isArray(result.body.caveats));
});

test('direct multi-exchange comparison reports venue failures without discarding healthy venues', async () => {
  const provider = createDirectProvider({ fetchImpl: async (url) => {
    if (new URL(url).hostname === 'api.binance.com') throw new TypeError('network unavailable');
    if (new URL(url).hostname === 'api.bybit.com') return json(PAYLOADS.bybitTicker);
    return json({ retCode: 10001, retMsg: 'unsupported' }, 400);
  } });
  const result = await provider.request('/api/exchanges/compare/ticker?symbol=BTC%2FUSDT&exchanges=binance,bybit');
  assert.equal(result.status, 200);
  assert.equal(result.body.venueCount, 1);
  assert.equal(result.body.results.find((item) => item.exchange === 'binance').status, 'error');
  assert.equal(result.body.results.find((item) => item.exchange === 'bybit').status, 'ok');
});
