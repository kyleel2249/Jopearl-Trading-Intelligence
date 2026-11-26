import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { apiFetch, setApiToken } from '../src/lib/api.js';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

test('a blank panel token never masks the verified session token, and a typed one still wins', async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch, session = new Map(), sent = [];
  const store = { getItem: (key) => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) };
  globalThis.window = { location: { protocol: 'https:', origin: 'https://jpti.pages.dev', hostname: 'jpti.pages.dev' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: store };
  globalThis.fetch = async (_url, options) => { sent.push(options.headers.get('x-jpti-api-token')); return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  try {
    setApiToken('session-token');
    await apiFetch('/api/council/history', { headers: { 'x-jpti-api-token': '' } });
    await apiFetch('/api/universal/control', { headers: { 'x-jpti-api-token': 'typed-token' } });
    await apiFetch('/api/elite-traders?limit=10');
    await apiFetch('/api/health', { headers: { 'x-jpti-api-token': '' } });
    assert.deepEqual(sent, ['session-token', 'typed-token', 'session-token', null]);
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
});

test('the Node API proxy forwards the private token and refuses to call itself', async () => {
  const calls = [];
  const handler = createPagesApiHandler({ fetchImpl: async (url, init) => { calls.push({ url, token: init.headers.get('x-jpti-api-token') }); return new Response('{}', { headers: { 'content-type': 'application/json' } }); } });
  const request = () => new Request('https://jpti.pages.dev/api/portfolio/balances', { headers: { 'x-jpti-api-token': 'tok' } });
  await handler({ request: request(), env: { JPTI_NODE_API_ORIGIN: 'https://node.example.com' } });
  assert.deepEqual(calls, [{ url: 'https://node.example.com/api/portfolio/balances', token: 'tok' }]);
  const self = await handler({ request: request(), env: { JPTI_NODE_API_ORIGIN: 'https://jpti.pages.dev/' } });
  assert.equal(self.status, 501);
  assert.equal(calls.length, 1);
});

test('every name used by the paper trading route is imported', async () => {
  const source = await readFile(new URL('../functions/api/paper/[[path]].js', import.meta.url), 'utf8');
  assert.match(source, /import \{[^}]*calculateAllInRiskPerUnit[^}]*\} from '\.\.\/\.\.\/\.\.\/src\/paper-trading-engine\.js'/);
});

test('re-applying the T-Bots adapter cannot remove the global safety switch check', async () => {
  const adapter = await readFile(new URL('../integrations/t-bots-adapter/jpti-bridge.js', import.meta.url), 'utf8');
  const shipped = await readFile(new URL('../integrations/t-bots/public/js/services/jpti-bridge.js', import.meta.url), 'utf8');
  assert.match(adapter, /\/paper\/safety/);
  assert.equal(shipped, adapter, 'run node scripts/apply-tbots-adapter.mjs and commit the shipped copy');
});
