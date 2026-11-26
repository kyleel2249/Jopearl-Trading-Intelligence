import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createDirectProvider } from '../src/lib/browser-direct.js';
import { createPagesApiHandler } from '../functions/api/[[path]].js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('server-side Bitget requests send a User-Agent and retry an alternate host after HTTP 403', async () => {
  const seen = [];
  const provider = createDirectProvider({ fetchImpl: async (url, init) => {
    seen.push({ host: new URL(url).hostname, ua: init.headers['user-agent'] });
    return new URL(url).hostname === 'api.bitget.com'
      ? json({ msg: 'blocked' }, 403)
      : json({ code: '00000', data: [{ symbol: 'BTCUSDT', lastPr: '100', open24h: '90', high24h: '110', low24h: '80', baseVolume: '5', quoteVolume: '500', ts: '1700000000000' }] });
  } });
  await provider.request('/api/exchanges/bitget/ticker/BTC-USDT');
  assert.ok(seen.length >= 2, 'a second host must be tried');
  assert.equal(seen[0].host, 'api.bitget.com');
  assert.match(seen[0].ua || '', /JPTI/);
});

test('global header and aside element selectors never leak into page layouts', () => {
  const css = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.equal(/(^|[}\s,])header\s*\{/.test(css), false, 'bare header{} rule makes every <header> sticky');
  assert.equal(/(^|[}\s,])aside\s*\{/.test(css), false, 'bare aside{} rule fixes every <aside> off-screen on mobile');
});

test('journal entries and signal rows are guarded against undefined lists', () => {
  const journal = fs.readFileSync(new URL('../src/ReflectiveJournal.jsx', import.meta.url), 'utf8');
  assert.match(journal, /const normalizeEntry = /);
  assert.equal(/active\.rules\.map/.test(journal), false);
  const dash = fs.readFileSync(new URL('../dashboard/app/DashboardApp.jsx', import.meta.url), 'utf8');
  assert.equal(/signal\.direction\.toUpperCase/.test(dash), false);
  assert.equal(/signal\.reasons\.slice/.test(dash), false);
});

test('unimplemented edge routes explain themselves and proxy to the Node API when configured', async () => {
  const bare = createPagesApiHandler({ fetchImpl: async () => json({}) });
  const missing = await bare({ request: new Request('https://jpti.test/api/ledger'), env: {} });
  assert.equal(missing.status, 501);
  const body = await missing.json();
  assert.equal(body.code, 'CLOUDFLARE_EDGE_ROUTE_UNAVAILABLE');
  assert.match(body.error, /JPTI_NODE_API_ORIGIN/);

  let forwarded = '';
  const proxied = createPagesApiHandler({ fetchImpl: async (url) => { forwarded = String(url); return json({ ok: true, ledger: [] }); } });
  const ok = await proxied({ request: new Request('https://jpti.test/api/ledger?x=1'), env: { JPTI_NODE_API_ORIGIN: 'https://node.example.com/' } });
  assert.equal(ok.status, 200);
  assert.equal(forwarded, 'https://node.example.com/api/ledger?x=1');

  const insecure = await proxied({ request: new Request('https://jpti.test/api/ledger'), env: { JPTI_NODE_API_ORIGIN: 'http://node.example.com' } });
  assert.equal(insecure.status, 501);
});
