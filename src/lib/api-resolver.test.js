import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveApiEndpoint, detectNative, validateOrigin, normalizePathPrefix, buildApiUrl, deriveWebSocketUrl } from './api-resolver.js';

const loc = (origin) => { const u = new URL(origin); return { protocol: u.protocol, origin: u.origin, hostname: u.hostname }; };

test('browser same-origin: HTTPS deployment uses the serving origin', () => {
  const r = resolveApiEndpoint({ location: loc('https://jpti.example.com/dashboard') });
  assert.equal(r.baseUrl, 'https://jpti.example.com');
  assert.equal(r.source, 'browser-origin');
  assert.equal(r.status, 'ok');
  assert.equal(buildApiUrl(r, '/api/health'), 'https://jpti.example.com/api/health');
});

test('browser same-origin: HTTP localhost development, including a non-default port', () => {
  const r = resolveApiEndpoint({ location: loc('http://localhost:5173/') });
  assert.equal(r.baseUrl, 'http://localhost:5173');
  assert.equal(r.warnings.length, 0);
});

test('mobile browser on a LAN address or custom domain simply follows its serving origin', () => {
  assert.equal(resolveApiEndpoint({ location: loc('http://192.168.1.20:5173') }).baseUrl, 'http://192.168.1.20:5173');
  assert.equal(resolveApiEndpoint({ location: loc('https://trade.mycompany.io') }).baseUrl, 'https://trade.mycompany.io');
});

test('Cloudflare Pages uses its same-origin Pages Functions API without a separate gateway', () => {
  for (const url of ['https://jpti.pages.dev/', 'https://trade.example.com/']) {
    const r = resolveApiEndpoint({ location: loc(url) });
    assert.equal(r.baseUrl, new URL(url).origin);
    assert.equal(r.source, 'browser-origin');
    assert.equal(buildApiUrl(r, '/api/health'), new URL('/api/health', url).href);
  }
});

test('GitHub Pages is treated as static-only and is not a supported hosting target', () => {
  const r = resolveApiEndpoint({ location: loc('https://kyleel2249.github.io/JPTI/') });
  assert.equal(r.baseUrl, '');
  assert.equal(r.status, 'configuration-required');
  assert.ok(r.warnings.some(w => w.code === 'static-host-needs-api'));
});

test('Capacitor native: the WebView origin is never mistaken for an API server', () => {
  for (const origin of ['https://localhost', 'capacitor://localhost', 'http://localhost']) {
    const r = resolveApiEndpoint({ location: loc(origin), native: true });
    assert.equal(r.baseUrl, '', origin);
    assert.equal(r.status, 'configuration-required');
    assert.ok(r.warnings.some((w) => w.code === 'native-needs-api'));
  }
  const viaCapacitor = resolveApiEndpoint({ location: loc('https://localhost'), capacitor: { isNativePlatform: () => true } });
  assert.equal(viaCapacitor.native, true);
  assert.equal(viaCapacitor.status, 'configuration-required');
});

test('native detection covers plugin flags and local schemes but not plain https://localhost dev', () => {
  assert.equal(detectNative({ capacitor: { isNativePlatform: () => true } }), true);
  assert.equal(detectNative({ capacitor: { getPlatform: () => 'android' } }), true);
  assert.equal(detectNative({ capacitor: { getPlatform: () => 'web', isNativePlatform: () => false } }), false);
  assert.equal(detectNative({ location: { protocol: 'capacitor:' } }), true);
  assert.equal(detectNative({ location: { protocol: 'https:' } }), false);
  assert.equal(detectNative({ capacitor: { isNativePlatform() { throw new Error('boom'); } } }), false);
});

test('native with an explicit or deployment origin uses it', () => {
  assert.equal(resolveApiEndpoint({ native: true, location: loc('https://localhost'), saved: 'https://api.example.com' }).baseUrl, 'https://api.example.com');
  const deployed = resolveApiEndpoint({ native: true, location: loc('https://localhost'), deployment: 'https://api.example.com' });
  assert.equal(deployed.source, 'deployment');
});

test('priority: user override > deployment > browser origin', () => {
  const all = { location: loc('https://app.example.com'), deployment: 'https://deploy.example.com', saved: 'https://user.example.com' };
  assert.equal(resolveApiEndpoint(all).source, 'user');
  assert.equal(resolveApiEndpoint({ ...all, saved: '' }).source, 'deployment');
  assert.equal(resolveApiEndpoint({ ...all, saved: '', deployment: '' }).source, 'browser-origin');
});

test('stale saved override is surfaced, never silent', () => {
  const r = resolveApiEndpoint({ location: loc('https://app.example.com'), deployment: 'https://new.example.com', saved: 'https://old.example.com' });
  assert.equal(r.baseUrl, 'https://old.example.com');
  assert.ok(r.warnings.some((w) => w.code === 'override-differs-from-deployment' && w.message.includes('old.example.com') && w.message.includes('new.example.com')));
  const noDeploy = resolveApiEndpoint({ location: loc('https://app.example.com'), saved: 'https://old.example.com' });
  assert.ok(noDeploy.warnings.some((w) => w.code === 'override-differs-from-origin'));
});

test('invalid or missing origins fall through with a warning or a configuration-required state', () => {
  const bad = resolveApiEndpoint({ location: loc('https://app.example.com'), saved: 'http://192.168.1.2:8787' });
  assert.equal(bad.source, 'browser-origin');
  assert.ok(bad.warnings.some((w) => w.code === 'saved-invalid'));
  const missing = resolveApiEndpoint({});
  assert.equal(missing.status, 'configuration-required');
  assert.equal(missing.baseUrl, '');
  assert.equal(buildApiUrl(missing, '/api/health'), '/api/health');
  const opaque = resolveApiEndpoint({ location: { protocol: 'file:', origin: 'null' } });
  assert.equal(opaque.status, 'configuration-required');
});

test('HTTPS page with an insecure remote API warns about mixed content', () => {
  const r = resolveApiEndpoint({ location: loc('https://app.example.com'), saved: 'http://localhost:8787' });
  assert.equal(r.warnings.some((w) => w.code === 'mixed-content'), false); // loopback is exempt
});

test('path prefixes are validated, normalised and applied', () => {
  assert.deepEqual(normalizePathPrefix('/jpti/'), { valid: true, value: '/jpti' });
  assert.deepEqual(normalizePathPrefix(''), { valid: true, value: '' });
  assert.equal(normalizePathPrefix('jpti').valid, false);
  assert.equal(normalizePathPrefix('/a/../b').valid, false);
  assert.equal(normalizePathPrefix('/a?b=1').valid, false);
  const r = resolveApiEndpoint({ location: loc('https://app.example.com'), deploymentPrefix: '/jpti' });
  assert.equal(buildApiUrl(r, '/api/health'), 'https://app.example.com/jpti/api/health');
  const userWins = resolveApiEndpoint({ location: loc('https://app.example.com'), deploymentPrefix: '/jpti', savedPrefix: '/v2' });
  assert.equal(userWins.pathPrefix, '/v2');
  const badPrefix = resolveApiEndpoint({ location: loc('https://app.example.com'), savedPrefix: 'no-slash' });
  assert.equal(badPrefix.pathPrefix, '');
  assert.ok(badPrefix.warnings.some((w) => w.code === 'invalid-prefix'));
});

test('absolute URLs pass through and WebSocket URLs are derived from the API origin', () => {
  const r = resolveApiEndpoint({ location: loc('https://app.example.com'), deploymentPrefix: '/jpti' });
  assert.equal(buildApiUrl(r, 'https://other.example.com/x'), 'https://other.example.com/x');
  assert.equal(deriveWebSocketUrl(r, '/ws'), 'wss://app.example.com/jpti/ws');
  assert.equal(deriveWebSocketUrl(resolveApiEndpoint({ location: loc('http://localhost:5173') })), 'ws://localhost:5173/ws');
  assert.equal(deriveWebSocketUrl(resolveApiEndpoint({})), '');
});

test('origin validation keeps the established rules', () => {
  assert.equal(validateOrigin('').valid, true);
  assert.equal(validateOrigin('https://a.example.com/').value, 'https://a.example.com');
  assert.equal(validateOrigin('http://127.0.0.1:8787').valid, true);
  assert.equal(validateOrigin('http://10.0.0.5:8787').valid, false);
  assert.equal(validateOrigin('ftp://localhost').valid, false);
  assert.equal(validateOrigin('https://u:p@a.example.com').valid, false);
});
