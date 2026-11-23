import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionMonitor, computeBackoffMs, classifyProbeFailure, attachNetworkListeners, testWebSocket } from './connection-monitor.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const okResolution = { baseUrl: 'https://api.example.com', source: 'user', native: false, status: 'ok', warnings: [] };

function harness(overrides = {}) {
  const timers = [];
  let clock = 1_000_000;
  const monitor = createConnectionMonitor({
    getResolution: () => overrides.resolution || okResolution,
    buildUrl: (p) => 'https://api.example.com' + p,
    fetchImpl: overrides.fetchImpl,
    now: () => clock,
    random: () => 0.5, // jitter factor 1.0
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    isOnline: overrides.isOnline || (() => true),
    ...overrides.options
  });
  return { monitor, timers, tick: (ms) => { clock += ms; } };
}

test('a healthy API reports connected with latency and last-success time', async () => {
  const h = harness({ fetchImpl: async () => json({ status: 'ok', service: 'JPTI Exchange Gateway', mode: 'paper' }) });
  const state = await h.monitor.start();
  assert.equal(state.state, 'connected');
  assert.equal(state.service, 'JPTI Exchange Gateway');
  assert.equal(state.consecutiveFailures, 0);
  assert.ok(state.lastSuccessAt);
  assert.equal(state.error, null);
  h.monitor.stop();
});

test('a slow or unhealthy answer is degraded, not connected', async () => {
  let clock = 0;
  const slow = createConnectionMonitor({
    getResolution: () => okResolution, buildUrl: (p) => p, now: () => (clock += 3000), degradedLatencyMs: 2500,
    fetchImpl: async () => json({ status: 'ok' }), setTimer: () => 1, clearTimer: () => {}
  });
  assert.equal((await slow.check()).state, 'degraded');
  const h = harness({ fetchImpl: async () => json({ status: 'starting' }) });
  assert.equal((await h.monitor.check()).state, 'degraded');
});

test('failures back off exponentially and a success resets the counter', async () => {
  let fail = true;
  const h = harness({ fetchImpl: async () => { if (fail) throw new TypeError('Failed to fetch'); return json({ status: 'ok' }); } });
  await h.monitor.start();
  assert.equal(h.monitor.getState().state, 'disconnected');
  assert.equal(h.monitor.getState().consecutiveFailures, 1);
  assert.equal(h.timers.at(-1).ms, 2000);
  await h.timers.at(-1).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.monitor.getState().consecutiveFailures, 2);
  assert.equal(h.timers.at(-1).ms, 4000);
  fail = false;
  await h.monitor.check();
  assert.equal(h.monitor.getState().state, 'connected');
  assert.equal(h.monitor.getState().consecutiveFailures, 0);
  assert.equal(h.timers.at(-1).ms, 30000);
  h.monitor.stop();
});

test('backoff is capped and jittered', () => {
  assert.equal(computeBackoffMs(0), 0);
  assert.equal(computeBackoffMs(1, { random: () => 0.5 }), 2000);
  assert.equal(computeBackoffMs(20, { random: () => 0.5 }), 60000);
  assert.equal(computeBackoffMs(2, { random: () => 0 }), 3200);
  assert.equal(computeBackoffMs(2, { random: () => 1 }), 4800);
});

test('timeouts abort the request and are reported as timeouts', async () => {
  const h = harness({
    options: { timeoutMs: 5 },
    fetchImpl: (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  });
  const realSetTimer = (fn, ms) => setTimeout(fn, ms);
  const monitor = createConnectionMonitor({
    getResolution: () => okResolution, buildUrl: (p) => p, timeoutMs: 5, setTimer: realSetTimer, clearTimer: clearTimeout,
    fetchImpl: (_url, { signal }) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  });
  const state = await monitor.check();
  assert.equal(state.state, 'disconnected');
  assert.equal(state.error.kind, 'timeout');
  monitor.stop();
  assert.ok(h.monitor);
});

test('authentication failures and HTML-instead-of-JSON are distinguished', async () => {
  const auth = harness({ fetchImpl: async () => new Response('no', { status: 401, headers: { 'content-type': 'text/plain' } }) });
  assert.equal((await auth.monitor.check()).state, 'auth-failed');
  const html = harness({ fetchImpl: async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  const state = await html.monitor.check();
  assert.equal(state.state, 'disconnected');
  assert.equal(state.error.kind, 'unavailable');
  const server = harness({ fetchImpl: async () => json({ error: 'x' }, { status: 503 }) });
  assert.equal((await server.monitor.check()).error.kind, 'http');
});

test('offline devices are reported as offline and recover when the network returns', async () => {
  let online = false;
  const h = harness({ isOnline: () => online, fetchImpl: async () => { if (!online) throw new TypeError('Failed to fetch'); return json({ status: 'ok' }); } });
  await h.monitor.check();
  assert.equal(h.monitor.getState().state, 'offline');
  online = true;
  await h.monitor.notifyNetworkChange();
  assert.equal(h.monitor.getState().state, 'connected');
  assert.equal(h.monitor.getState().consecutiveFailures, 0);
});

test('an unconfigured native app reports not-configured with guidance and does not poll', async () => {
  const h = harness({
    resolution: { baseUrl: '', source: 'none', native: true, status: 'configuration-required', warnings: [{ message: 'Enter your reachable HTTPS API address once.' }] },
    fetchImpl: async () => { throw new Error('must not be called'); }
  });
  const state = await h.monitor.start();
  assert.equal(state.state, 'not-configured');
  assert.match(state.error.message, /HTTPS API address/);
  assert.equal(h.timers.length, 0);
});

test('concurrent checks share one in-flight request and subscribers are notified', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => { calls += 1; return json({ status: 'ok' }); } });
  const seen = [];
  const off = h.monitor.subscribe((s) => seen.push(s.state));
  await Promise.all([h.monitor.check(), h.monitor.check()]);
  assert.equal(calls, 1);
  assert.ok(seen.includes('connected'));
  off();
});

test('classifyProbeFailure recognises DNS, TLS and refused connections', () => {
  assert.equal(classifyProbeFailure({ cause: { code: 'ENOTFOUND' } }).kind, 'dns');
  assert.equal(classifyProbeFailure({ cause: { code: 'CERT_HAS_EXPIRED' } }).kind, 'tls');
  assert.equal(classifyProbeFailure({ code: 'ECONNREFUSED' }).kind, 'refused');
  assert.equal(classifyProbeFailure(new TypeError('x'), { online: false }).kind, 'offline');
  assert.match(classifyProbeFailure(new TypeError('x')).remediation, /CORS/);
});

test('network listeners re-check on online, connection change, config change and visibility', () => {
  const handlers = {};
  const mk = () => ({ addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; } });
  const win = mk(), doc = Object.assign(mk(), { visibilityState: 'visible' }), connection = mk();
  let rechecks = 0, offline = 0;
  const monitor = { notifyNetworkChange: () => { rechecks += 1; }, markOffline: () => { offline += 1; } };
  const detach = attachNetworkListeners(monitor, { win, doc, nav: { connection } });
  handlers.online(); handlers.change(); handlers['jpti:api-config-changed'](); handlers.visibilitychange(); handlers.offline();
  assert.equal(rechecks, 4);
  assert.equal(offline, 1);
  detach();
  assert.deepEqual(Object.keys(handlers), []);
});

class FakeSocket {
  constructor(url) { FakeSocket.last = this; this.url = url; setImmediate(() => FakeSocket.script(this)); }
  close() { this.closed = true; }
}

test('WebSocket test requires both open and a received message', async () => {
  FakeSocket.script = (s) => { s.onopen(); setImmediate(() => s.onmessage({ data: 'hi' })); };
  const good = await testWebSocket('wss://x.example/ws', { WebSocketImpl: FakeSocket });
  assert.equal(good.status, 'connected');
  assert.equal(good.messageReceived, true);
  assert.equal(FakeSocket.last.closed, true);

  FakeSocket.script = (s) => s.onopen();
  const silent = await testWebSocket('wss://x.example/ws', { WebSocketImpl: FakeSocket, messageTimeoutMs: 10 });
  assert.equal(silent.status, 'degraded');

  FakeSocket.script = (s) => s.onerror(new Error('boom'));
  assert.equal((await testWebSocket('wss://x.example/ws', { WebSocketImpl: FakeSocket })).status, 'disconnected');

  assert.equal((await testWebSocket('', { WebSocketImpl: FakeSocket })).status, 'not-configured');
  assert.equal((await testWebSocket('wss://x', { WebSocketImpl: null })).status, 'disconnected');
});
