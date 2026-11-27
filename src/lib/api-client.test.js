import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, ApiRequestError, apiFetch, apiUrl, getApiResolution, setApiBaseUrl, setApiPathPrefix, resolveWebSocketUrl, isApiUnavailable } from './api.js';

function withWindow(extra = {}, fn) {
  const previous = globalThis.window;
  const store = new Map();
  globalThis.window = {
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    ...extra
  };
  const done = () => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; };
  return Promise.resolve(fn(store)).finally(done);
}
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('browser mode resolves the serving origin and builds same-origin API URLs', () => withWindow({ location: new URL('https://jpti.example.com/app') }, () => {
  assert.equal(getApiResolution().source, 'browser-origin');
  assert.equal(apiUrl('/api/health'), 'https://jpti.example.com/api/health');
}));

test('external gateway overrides are rejected and the same-origin Cloudflare API remains canonical', () => withWindow({ location: new URL('https://app.example.com') }, () => {
  assert.throws(() => setApiBaseUrl('https://api.example.com'), /External API gateway URLs are disabled/);
  assert.equal(apiUrl('/api/health'), 'https://app.example.com/api/health');
  assert.equal(resolveWebSocketUrl('/ws'), 'wss://app.example.com/ws');
  setApiPathPrefix('/jpti');
  assert.equal(apiUrl('/api/health'), 'https://app.example.com/api/health');
  assert.throws(() => setApiBaseUrl('http://10.0.0.1:8787'));
  assert.throws(() => setApiPathPrefix('no-slash'));
}));

test('Android Capacitor shell without an API address fails with a clear configuration error', () => withWindow({
  location: new URL('https://localhost/'), Capacitor: { isNativePlatform: () => true }
}, async () => {
  const resolution = getApiResolution();
  assert.equal(resolution.native, true);
  assert.equal(resolution.status, 'configuration-required');
  // Routes with no browser-direct equivalent still fail with the clear configuration error.
  await assert.rejects(() => apiFetch('/api/operations/overview'), (error) => { assert.equal(isApiUnavailable(error), true); assert.equal(error.code, 'configuration-required'); return true; });
  // Health is answered by the direct fallback, honestly marked as degraded direct mode (never "ok").
  const direct = await (await apiFetch('/api/health')).json();
  assert.equal(direct.directMode, true);
  assert.notEqual(direct.status, 'ok');
  assert.throws(() => setApiBaseUrl('https://api.example.com'), /External API gateway URLs are disabled/);
  const directAgain = await (await apiFetch('/api/health')).json();
  assert.equal(directAgain.directMode, true);
}));

test('apiRequest returns parsed JSON and latency, sending the saved token', () => withWindow({ location: new URL('https://app.example.com') }, async (store) => {
  store.set('jpti.apiToken', 'tok');
  let captured;
  const result = await apiRequest('/api/health', { fetchImpl: async (url, init) => { captured = { url, init }; return json({ status: 'ok' }); } });
  assert.equal(result.data.status, 'ok');
  assert.equal(captured.url, 'https://app.example.com/api/health');
  assert.equal(captured.init.headers.has('x-jpti-api-token'), false, 'legacy user-supplied gateway tokens are ignored');
  assert.ok(result.requestId);
}));

test('apiRequest retries idempotent requests with backoff and gives up after the limit', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls < 3) return json({ error: 'busy' }, { status: 503 }); return json({ ok: 1 }); };
  const result = await apiRequest('/api/x', { fetchImpl: flaky, retryBaseMs: 1 });
  assert.equal(calls, 3);
  assert.equal(result.data.ok, 1);
  calls = 0;
  await assert.rejects(() => apiRequest('/api/x', { fetchImpl: async () => { calls += 1; return json({ error: 'down' }, { status: 503 }); }, retries: 1, retryBaseMs: 1 }), (error) => { assert.equal(error.kind, 'http'); assert.equal(error.status, 503); return true; });
  assert.equal(calls, 2);
}));

test('apiRequest does not retry POST by default or auth failures', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  let calls = 0;
  await assert.rejects(() => apiRequest('/api/x', { method: 'POST', json: { a: 1 }, retryBaseMs: 1, fetchImpl: async () => { calls += 1; return json({ error: 'x' }, { status: 503 }); } }));
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => apiRequest('/api/x', { retryBaseMs: 1, fetchImpl: async () => { calls += 1; return json({ error: 'no' }, { status: 401 }); } }), (error) => error.kind === 'auth');
  assert.equal(calls, 1);
}));

test('apiRequest normalises timeouts, network failures, cancellation and HTML responses', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  const hang = (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
  await assert.rejects(() => apiRequest('/api/x', { fetchImpl: hang, timeoutMs: 5, retries: 0 }), (e) => e instanceof ApiRequestError && e.kind === 'timeout' && e.retryable);
  await assert.rejects(() => apiRequest('/api/x', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, retries: 0 }), (e) => e.kind === 'network');
  const controller = new AbortController();
  const pending = apiRequest('/api/x', { fetchImpl: hang, signal: controller.signal, retries: 0, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(() => pending, (e) => e.kind === 'aborted');
  await assert.rejects(() => apiRequest('/api/x', { retries: 0, fetchImpl: async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }) }), (e) => e.kind === 'unavailable');
}));

test('apiRequest supports binary and empty responses', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  const blob = await apiRequest('/api/file', { parse: 'blob', fetchImpl: async () => new Response(new Blob(['abc']), { status: 200 }) });
  assert.equal(await blob.data.text(), 'abc');
  const empty = await apiRequest('/api/x', { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(empty.status, 204);
}));


test('apiRequest falls back to the same Bitget venue when the Cloudflare edge returns 502', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  const previousFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requestedUrls.push(value);
    if (value.includes('/api/v3/market/tickers')) {
      return new Response(JSON.stringify({ code: '403', msg: 'edge route blocked' }), {
        status: 403, headers: { 'content-type': 'application/json' }
      });
    }
    if (value.includes('/api/v2/spot/market/tickers')) {
      return new Response(JSON.stringify({ code: '00000', data: [{
        symbol: 'BTCUSDT', lastPr: '64000.5', bidPr: '64000.4', askPr: '64000.6',
        high24h: '65000', low24h: '63000', baseVolume: '12', quoteVolume: '768000'
      }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected direct market URL: ' + value);
  };
  try {
    let edgeCalls = 0;
    const result = await apiRequest('/api/exchanges/bitget/ticker/ETH%2FUSDT?type=spot', {
      retries: 0,
      fetchImpl: async () => {
        edgeCalls += 1;
        return json({ error: 'Bitget upstream denied Cloudflare egress.' }, { status: 502 });
      }
    });
    assert.equal(edgeCalls, 1);
    assert.equal(result.status, 200);
    assert.equal(result.data.exchange, 'bitget');
    assert.equal(result.data.requestedExchange, 'bitget');
    assert.equal(result.data.failedOver, false);
    assert.equal(result.data.last, 64000.5);
    assert.ok(requestedUrls.some(url => url.includes('/api/v3/market/tickers')));
    assert.ok(requestedUrls.some(url => url.includes('/api/v2/spot/market/tickers')));
    assert.ok(requestedUrls.every(url => {
      const host = new URL(url).hostname;
      return host === 'api.bitget.com' || host === 'capi.bitget.com' || host === 'api.bitgetapi.com';
    }), 'all direct fallback requests must stay on Bitget-owned API hosts');
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test('apiRequest recovers Bitget when the edge wraps an upstream error in HTTP 200', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  const previousFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const value = String(url);
    requestedUrls.push(value);
    if (value.includes('/api/v3/market/tickers')) {
      return json({ code: '00000', msg: 'success', data: [{
        symbol: 'ETHUSDT', lastPrice: '3162.15', bid1Price: '3160', ask1Price: '3164',
        highPrice24h: '3186.59', lowPrice24h: '2992', volume24h: '3103.02',
        turnover24h: '188887283.30', price24hPcnt: '0.01208', ts: '1795750000000'
      }] });
    }
    throw new Error('Unexpected direct market URL: ' + value);
  };
  try {
    const result = await apiRequest('/api/exchanges/bitget/ticker/BTC%2FUSDT?type=spot', {
      retries: 0,
      fetchImpl: async () => json({ error: 'Bitget upstream failed inside Cloudflare.', source: 'cloudflare-edge' })
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.exchange, 'bitget');
    assert.equal(result.data.last, 3162.15);
    assert.equal(result.data.source, 'browser-direct');
    assert.ok(requestedUrls.some(url => url.includes('/api/v3/market/tickers?category=SPOT&symbol=ETHUSDT')));
  } finally {
    globalThis.fetch = previousFetch;
  }
}));

test('apiRequest does not use Bitget error-envelope recovery for private or other-venue routes', () => withWindow({ location: new URL('https://app.example.com') }, async () => {
  const previousFetch = globalThis.fetch;
  let directCalls = 0;
  globalThis.fetch = async () => { directCalls += 1; throw new Error('Direct fallback must not run.'); };
  try {
    const otherVenue = await apiRequest('/api/exchanges/binance/ticker/BTC%2FUSDT?type=spot', {
      retries: 0,
      fetchImpl: async () => json({ error: 'venue error' })
    });
    assert.equal(otherVenue.data.error, 'venue error');
    const privateRoute = await apiRequest('/api/account/balance', {
      retries: 0,
      fetchImpl: async () => json({ error: 'private route error' })
    });
    assert.equal(privateRoute.data.error, 'private route error');
    assert.equal(directCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
}));
