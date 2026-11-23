import test from 'node:test';
import assert from 'node:assert/strict';
import { apiFetch, apiUrl, getApiBaseUrl, getApiToken, isApiUnavailable, setApiBaseUrl, setApiToken, validateApiBaseUrl, getApiSource } from './api.js';

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

test('legacy API tokens are cleared and never attached to Cloudflare API requests', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch, store = new Map([['jpti.apiToken', 'old-secret']]);
  globalThis.window = { location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' }, localStorage: {
    getItem: key => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key)
  } };
  let captured = null;
  globalThis.fetch = async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json', 'x-jpti-runtime': 'cloudflare-edge' } }); };
  try {
    assert.equal(setApiToken('secret-token'), '');
    assert.equal(getApiToken(), '');
    await apiFetch('/api/health');
    assert.equal(captured.options.headers.get('x-jpti-api-token'), null);
    assert.equal(captured.url, 'https://jpti.pages.dev/api/health');
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
