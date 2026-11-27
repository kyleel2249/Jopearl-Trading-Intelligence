import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, apiUrl, getApiBaseUrl, getApiToken, isApiUnavailable, setApiBaseUrl, setApiToken, validateApiBaseUrl, getApiSource, resetApiAvailability } from './api.js';

test('accepts blank same-origin and loopback desktop API addresses', () => {
  assert.deepEqual(validateApiBaseUrl(''), { valid: true, value: '' });
  assert.equal(validateApiBaseUrl('http://127.0.0.1:8787').valid, true);
  assert.equal(validateApiBaseUrl('http://localhost:8787').valid, true);
});

test('requires HTTPS for remote API origins', () => {
  assert.equal(validateApiBaseUrl('https://jpti.example.com').valid, true);
  assert.equal(validateApiBaseUrl('http://192.168.1.20:8787').valid, false);
});

test('rejects URL credentials, paths, query strings and fragments', () => {
  for (const value of [
    'https://user:pass@jpti.example.com',
    'https://jpti.example.com/api',
    'https://jpti.example.com?token=x',
    'https://jpti.example.com#section'
  ]) assert.equal(validateApiBaseUrl(value).valid, false);
});

test('ignores and clears stale external API gateway settings in favour of the Cloudflare origin', () => {
  const previous = globalThis.window;
  const store = new Map([
    ['jpti.apiBaseUrl', 'https://old-render-host.example.com'],
    ['jpti.apiToken', 'old-secret-token']
  ]);
  globalThis.window = {
    location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' },
    localStorage: {
      getItem: key => store.get(key) || null,
      setItem: (key, value) => store.set(key, value),
      removeItem: key => store.delete(key)
    }
  };
  try {
    assert.equal(getApiBaseUrl(), 'https://jpti.pages.dev');
    assert.equal(apiUrl('/api/health'), 'https://jpti.pages.dev/api/health');
    assert.equal(store.has('jpti.apiBaseUrl'), false);
    assert.equal(store.has('jpti.apiToken'), false);
    assert.throws(() => setApiBaseUrl('https://another-api.example.com'), /External API gateway URLs are disabled/);
    assert.equal(setApiBaseUrl(''), '');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('private journal token stays in session storage and is sent only to private JPTI routes', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const local = new Map([['jpti.apiToken', 'old-secret']]), session = new Map();
  const makeStore = map => ({ getItem: key => map.get(key) || null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  globalThis.window = { location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' }, localStorage: makeStore(local), sessionStorage: makeStore(session) };
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ status: 'ok', entries: [] }), { status: 200, headers: { 'content-type': 'application/json', 'x-jpti-runtime': 'cloudflare-edge' } }); };
  try {
    assert.equal(setApiToken('secret-token'), 'secret-token');
    assert.equal(getApiToken(), 'secret-token');
    assert.equal(local.has('jpti.apiToken'), false);
    await apiFetch('/api/health');
    assert.equal(requests[0].options.headers.get('x-jpti-api-token'), null);
    await apiFetch('/api/journal/entries');
    assert.equal(requests[1].options.headers.get('x-jpti-api-token'), 'secret-token');
    assert.equal(requests[1].url, 'https://jpti.pages.dev/api/journal/entries');
    await apiFetch('/api/session/memory');
    assert.equal(requests[2].options.headers.get('x-jpti-api-token'), 'secret-token');
    await apiFetch('/api/alpha/gainz/outcomes');
    assert.equal(requests[3].options.headers.get('x-jpti-api-token'), 'secret-token');
    await apiFetch('/api/org/overview');
    assert.equal(requests[4].options.headers.get('x-jpti-api-token'), 'secret-token');
    await apiFetch('/api/agents/history?limit=12');
    assert.equal(requests[5].options.headers.get('x-jpti-api-token'), 'secret-token');
    await apiFetch('/api/agents/evaluate', { method: 'POST', body: '{}' });
    assert.equal(requests[6].options.headers.get('x-jpti-api-token'), 'secret-token');
    assert.equal(getApiSource().mode, 'cloudflare-edge');
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
});

test('an HTML page from a static host surfaces a clear API-unavailable error instead of a JSON syntax error', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  globalThis.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
  try {
    globalThis.fetch = async () => new Response('<!DOCTYPE html><html></html>', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const html = await apiFetch('/api/operations/overview');
    await assert.rejects(() => html.json(), error => {
      assert.equal(isApiUnavailable(error), true);
      assert.doesNotMatch(error.message, /Unexpected token/);
      assert.match(error.message, /not reachable/);
      return true;
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.deepEqual(await (await apiFetch('/api/health')).json(), { status: 'ok' });
    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal((await apiFetch('/api/x')).status, 204);
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
});

test('retries a market-data 404 directly against the same exchange without cross-venue substitution', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const makeStore = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  globalThis.window = {
    location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' },
    localStorage: makeStore(),
    sessionStorage: makeStore()
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('https://jpti.pages.dev/api/exchanges/bitget/ticker/')) {
      return new Response(JSON.stringify({ error: 'Bitget edge ticker returned 404.' }), {
        status: 404, headers: { 'content-type': 'application/json' }
      });
    }
    if (target.startsWith('https://api.bitget.com/api/v3/market/tickers?')) {
      return new Response(JSON.stringify({
        code: '00000',
        requestTime: 1700000000000,
        data: [{
          symbol: 'BTCUSDT', ts: '1700000000000', lastPrice: '123.45',
          bid1Price: '123.44', ask1Price: '123.46', highPrice24h: '130',
          lowPrice24h: '110', volume24h: '100', turnover24h: '12345',
          price24hPcnt: '0.01'
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected cross-venue or external request: ' + target);
  };
  try {
    resetApiAvailability();
    const response = await apiFetch('/api/exchanges/bitget/ticker/BTC%2FUSDT?type=spot');
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.exchange, 'bitget');
    assert.equal(body.symbol, 'BTC/USDT');
    assert.equal(body.last, 123.45);
    assert.equal(body.source, 'browser-direct');
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith('https://api.bitget.com/'));
    assert.equal(getApiSource().mode, 'direct');
  } finally {
    resetApiAvailability();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});

test('keeps the original market-data 404 when the requested venue also fails', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const makeStore = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  globalThis.window = {
    location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' },
    localStorage: makeStore(),
    sessionStorage: makeStore()
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.startsWith('https://jpti.pages.dev/api/exchanges/bitget/ticker/')) {
      return new Response(JSON.stringify({ error: 'Bitget edge ticker returned 404.' }), {
        status: 404, headers: { 'content-type': 'application/json' }
      });
    }
    if (target.startsWith('https://api.bitget.com/')) {
      return new Response(JSON.stringify({ code: '500', msg: 'temporarily unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error('Cross-venue fallback is forbidden: ' + target);
  };
  try {
    resetApiAvailability();
    const response = await apiFetch('/api/exchanges/bitget/ticker/BTC%2FUSDT?type=spot');
    assert.equal(response.status, 404);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith('https://api.bitget.com/'));
  } finally {
    resetApiAvailability();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  }
});
