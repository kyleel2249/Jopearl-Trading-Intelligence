import test from 'node:test';
import assert from 'node:assert/strict';
import { createBitgetCfdProvider } from './bitget-cfd.js';

const ok = (data) => { const body = JSON.stringify({ code: '00000', msg: 'success', requestTime: 1700000000000, data }); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body }; };
const env = { JPTI_BITGET_API_KEY: 'test-key', JPTI_BITGET_API_SECRET: 'test-secret', JPTI_BITGET_API_PASSPHRASE: 'test-passphrase' };

test('Bitget CFD provider requires credentials only on the Cloudflare server', async () => {
  const provider = createBitgetCfdProvider({ fetchImpl: async () => ok([]) });
  await assert.rejects(() => provider.request({}, { kind: 'markets' }), (error) => error.status === 503 && error.code === 'BITGET_CFD_CREDENTIALS_REQUIRED');
});

test('Bitget CFD instruments are normalized without converting CFD symbols into crypto pairs', async () => {
  let requestUrl = '';
  let requestHeaders;
  const provider = createBitgetCfdProvider({
    now: () => 1700000000000,
    fetchImpl: async (url, init) => { requestUrl = String(url); requestHeaders = init.headers; return ok([
      { symbol: 'XAUUSD.s', currency: 'XAU', profitCurrency: 'USD', marginCurrency: 'USD', digits: '2', spread: '25', contractSize: '100' },
      { symbol: 'EURUSD', currency: 'EUR', profitCurrency: 'USD', digits: '5' }
    ]); }
  });
  const result = await provider.request(env, { kind: 'markets', search: 'xau' });
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal(result.body.markets[0].symbol, 'XAUUSD.s');
  assert.equal(result.body.markets[0].id, 'XAUUSD.s');
  assert.equal(result.body.markets[0].productCategory, 'CFD');
  assert.equal(result.body.markets[0].cfd, true);
  assert.match(requestUrl, /\/api\/v3\/cfd\/account\/instruments$/);
  assert.equal(requestHeaders['ACCESS-KEY'], 'test-key');
  assert.equal(requestHeaders['ACCESS-PASSPHRASE'], 'test-passphrase');
  assert.ok(requestHeaders['ACCESS-SIGN']);
  assert.equal(requestHeaders['ACCESS-TIMESTAMP'], '1700000000000');
});

test('Bitget CFD ticker exposes bid, ask and a clearly-labelled midpoint', async () => {
  const provider = createBitgetCfdProvider({ fetchImpl: async () => ok([
    { symbol: 'XAUUSD.s', bid1: '2620.50', ask1: '2620.60', highPrice: '2650.12', lowPrice: '2610.34', askOpenPriceChange: '0.001', quoteTime: '1700000000000' }
  ]) });
  const result = await provider.request(env, { kind: 'ticker', symbol: 'XAUUSD.s' });
  assert.equal(result.body.last, 2620.55);
  assert.equal(result.body.priceType, 'bid-ask-midpoint');
  assert.equal(result.body.percentage, 0.1);
  assert.equal(result.body.bid, 2620.5);
  assert.equal(result.body.ask, 2620.6);
});

test('Bitget CFD candle feed normalizes side-specific OHLC without inventing volume', async () => {
  let url = '';
  const provider = createBitgetCfdProvider({ fetchImpl: async (value) => { url = String(value); return ok([
    ['1700003600000', '2621', '2625', '2618', '2624'],
    ['1700000000000', '2610', '2622', '2608', '2621']
  ]); } });
  const result = await provider.request(env, { kind: 'ohlcv', symbol: 'XAUUSD.s', timeframe: '1h', side: 'sell', limit: 40 });
  assert.match(url, /side=sell/);
  assert.match(url, /interval=1h/);
  assert.deepEqual(result.body.candles[0], [1700000000000, 2610, 2622, 2608, 2621, 0]);
  assert.equal(result.body.volumeAvailable, false);
  assert.equal(result.body.side, 'sell');
});

test('Bitget CFD timeframe and side validation rejects unsupported chart requests', async () => {
  const provider = createBitgetCfdProvider({ fetchImpl: async () => ok([]) });
  await assert.rejects(() => provider.request(env, { kind: 'ohlcv', symbol: 'XAUUSD', timeframe: '5m' }), (error) => error.status === 400 && error.code === 'BITGET_CFD_TIMEFRAME_UNSUPPORTED');
  await assert.rejects(() => provider.request(env, { kind: 'ohlcv', symbol: 'XAUUSD', timeframe: '1h', side: 'mid' }), (error) => error.status === 400 && error.code === 'BITGET_CFD_SIDE_INVALID');
});

test('Bitget CFD provider preserves safe upstream HTTP diagnostics without exposing request credentials', async () => {
  const provider = createBitgetCfdProvider({
    fetchImpl: async () => ({
      ok: false, status: 403,
      headers: { get: (name) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
      text: async () => JSON.stringify({ code: '40012', msg: 'API permission denied' })
    })
  });
  await assert.rejects(() => provider.request(env, { kind: 'markets' }), (error) =>
    error.status === 403 &&
    error.upstreamStatus === 403 &&
    error.upstreamCode === '40012' &&
    error.upstreamMessage === 'API permission denied' &&
    !String(error.message).includes('test-secret')
  );
});
