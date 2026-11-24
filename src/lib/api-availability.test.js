import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, getApiSource, resetApiAvailability, getApiCircuitState } from './api.js';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = () => new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } });

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return handler(String(url), init); };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = original; resetApiAvailability(); });
}

const isVenue = (url) => /^https:\/\/(api\.binance|api\.bybit|www\.okx|api\.bitget)/.test(url);
const binanceTicker = () => json({ symbol: 'BTCUSDT', lastPrice: '100', bidPrice: '99', askPrice: '101', highPrice: '110', lowPrice: '90', volume: '5', quoteVolume: '500', priceChangePercent: '1.5', openPrice: '98', closeTime: Date.now() });

test('a working API is used as-is and reported as the source', async () => {
  await withFetch(() => json({ status: 'ok' }), async () => {
    const res = await apiFetch('/api/health');
    assert.equal((await res.json()).status, 'ok');
    assert.equal(getApiSource().mode, 'api');
  });
});

test('a genuine JSON 404 from a working API passes through without fallback', async () => {
  await withFetch(() => json({ error: 'not found' }, 404), async (calls) => {
    const res = await apiFetch('/api/exchanges/binance/ticker/BTC%2FUSDT');
    assert.equal(res.status, 404);
    assert.equal(getApiSource().mode, 'api');
    assert.equal(calls.length, 1);
  });
});

test('an HTML response from the API origin falls back to browser-direct data', async () => {
  await withFetch((url) => (isVenue(url) ? binanceTicker() : html()), async () => {
    const res = await apiFetch('/api/exchanges/binance/ticker/BTC%2FUSDT');
    assert.equal(res.headers.get('x-jpti-source'), 'browser-direct');
    assert.equal(getApiSource().mode, 'direct');
    assert.equal(getApiSource().reason, 'bad-response');
  });
});

test('network failure opens the circuit and later calls skip the dead API', async () => {
  await withFetch((url) => { if (isVenue(url)) return binanceTicker(); throw new TypeError('network'); }, async (calls) => {
    const path = '/api/exchanges/binance/ticker/BTC%2FUSDT';
    await apiFetch(path); await apiFetch(path);
    assert.equal(getApiCircuitState().state, 'open');
    const before = calls.filter(u => !isVenue(u)).length;
    await apiFetch(path);
    assert.equal(calls.filter(u => !isVenue(u)).length, before);
  });
});

test('Bitget edge 502 falls back to direct public data and opens the API circuit', async () => {
  await withFetch((url) => {
    if (isVenue(url)) return json({ code: '00000', data: [{ symbol: 'BTCUSDT', lastPrice: '100', bid1Price: '99', ask1Price: '101', highPrice24h: '110', lowPrice24h: '90', volume24h: '5', turnover24h: '500', price24hPcnt: '0.01', ts: String(Date.now()) }] });
    return json({ error: 'Bitget upstream returned HTTP 403' }, 502, { 'x-jpti-runtime': 'cloudflare-edge' });
  }, async (calls) => {
    const path = '/api/exchanges/bitget/ticker/BTC%2FUSDT';
    const first = await apiFetch(path);
    assert.equal(first.headers.get('x-jpti-source'), 'browser-direct');
    assert.equal((await first.json()).last, 100);
    assert.equal(getApiSource().mode, 'direct');
    await apiFetch(path);
    assert.equal(getApiCircuitState().state, 'open');
    const edgeCallsBefore = calls.filter((url) => !isVenue(url)).length;
    const third = await apiFetch(path);
    assert.equal((await third.json()).last, 100);
    assert.equal(calls.filter((url) => !isVenue(url)).length, edgeCallsBefore, 'open circuit skips the blocked Cloudflare edge path');
  });
});

test('routes with no direct equivalent surface the original error', async () => {
  await withFetch(() => html(), async () => {
    await assert.rejects(async () => (await apiFetch('/api/ledger/trades')).json());
  });
});

test('aborted requests do not count as outages', async () => {
  await withFetch(() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, async () => {
    await assert.rejects(() => apiFetch('/api/exchanges/binance/ticker/BTC%2FUSDT'), { name: 'AbortError' });
    assert.equal(getApiCircuitState().failures, 0);
  });
});
