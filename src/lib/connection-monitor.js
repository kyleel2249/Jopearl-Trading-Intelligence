// Connection monitor: verifies real API reachability (via /api/health), measures
// latency, retries with exponential backoff and re-checks on network changes.
// Browser online/offline events are treated as advisory hints only; the verdict
// always comes from an actual health response.
// Dependency-free so it can be unit-tested with injected fetch/timers.

export const CONNECTION_STATES = Object.freeze(['connected', 'degraded', 'disconnected', 'offline', 'auth-failed', 'not-configured']);

export function computeBackoffMs(failures, { baseDelayMs = 2000, maxDelayMs = 60000, random = Math.random } = {}) {
  if (failures <= 0) return 0;
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1));
  return Math.round(raw * (0.8 + 0.4 * random())); // +/-20% jitter avoids thundering herds
}

export function classifyProbeFailure(error, { online = true } = {}) {
  const name = error && error.name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'timeout', message: 'The API did not answer in time.', remediation: 'Check that the server is running and reachable; slow networks may need a retry.' };
  }
  if (!online) {
    return { kind: 'offline', message: 'The device reports no network connection.', remediation: 'Reconnect to Wi-Fi or mobile data. JPTI will re-check automatically.' };
  }
  const code = (error && (error.cause && error.cause.code || error.code)) || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { kind: 'dns', message: 'The API host name could not be resolved.', remediation: 'Check the API address for typos and your DNS/network.' };
  if (/CERT|TLS|SSL/.test(code)) return { kind: 'tls', message: 'A secure (TLS) connection to the API could not be established.', remediation: 'Verify the HTTPS certificate on the API host.' };
  if (/ECONNREFUSED/.test(code)) return { kind: 'refused', message: 'The API host refused the connection.', remediation: 'Start the JPTI API or correct the address/port.' };
  return {
    kind: 'network',
    message: 'The API could not be reached.',
    remediation: 'Browsers cannot tell DNS, TLS and CORS failures apart. Confirm the address, that the API is running, that it is served over HTTPS, and that JPTI_CORS_ORIGINS includes this app\'s origin.'
  };
}

const INITIAL = Object.freeze({
  state: 'not-configured', online: true, endpoint: '', source: 'none', native: false,
  latencyMs: null, lastCheckedAt: null, lastSuccessAt: null, consecutiveFailures: 0,
  nextRetryInMs: null, nextRetryAt: null, error: null, service: null, mode: null, checks: 0
});

export function createConnectionMonitor({
  getResolution, buildUrl, fetchImpl, headers = () => ({}), now = Date.now,
  timeoutMs = 8000, degradedLatencyMs = 2500, pollMs = 30000,
  baseDelayMs = 2000, maxDelayMs = 60000, random = Math.random,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  isOnline = () => (typeof navigator === 'undefined' || navigator.onLine !== false),
  healthPath = '/api/health'
} = {}) {
  let state = { ...INITIAL };
  let timer = null;
  let running = false;
  let inflight = null;
  const listeners = new Set();

  const publish = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) { try { listener(state); } catch { /* listeners must not break monitoring */ } }
  };

  const schedule = (delay) => {
    if (!running) return;
    if (timer) clearTimer(timer);
    publish({ nextRetryInMs: delay, nextRetryAt: delay == null ? null : new Date(now() + delay).toISOString() });
    if (delay == null) { timer = null; return; }
    timer = setTimer(() => { timer = null; check(); }, delay);
  };

  async function probe() {
    const resolution = getResolution();
    const online = isOnline();
    const base = { endpoint: resolution.baseUrl, source: resolution.source, native: resolution.native, online };
    if (resolution.status === 'configuration-required') {
      publish({ ...base, state: 'not-configured', latencyMs: null, lastCheckedAt: new Date(now()).toISOString(), error: {
        kind: 'configuration-required', message: resolution.warnings.map((w) => w.message).join(' ') || 'No API address is configured.',
        remediation: 'Open the API gateway settings and enter the HTTPS address of your JPTI API.' }, consecutiveFailures: 0 });
      return { schedule: null };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const guard = controller ? setTimer(() => controller.abort(), timeoutMs) : null;
    const started = now();
    try {
      const response = await fetchImpl(buildUrl(healthPath), { cache: 'no-store', headers: headers(), signal: controller ? controller.signal : undefined });
      const latencyMs = Math.max(0, now() - started);
      const type = response.headers && response.headers.get ? response.headers.get('content-type') || '' : 'application/json';
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error('auth'), { probeKind: 'auth-failed', status: response.status });
      }
      if (!/json/i.test(type)) throw Object.assign(new Error('html'), { probeKind: 'unavailable', status: response.status });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error('http'), { probeKind: 'http', status: response.status });
      const healthy = data && data.status === 'ok';
      const slow = latencyMs > degradedLatencyMs;
      publish({
        ...base, state: healthy && !slow ? 'connected' : 'degraded', latencyMs, lastCheckedAt: new Date(now()).toISOString(),
        lastSuccessAt: new Date(now()).toISOString(), consecutiveFailures: 0, service: data && data.service || null, mode: data && data.mode || null,
        error: healthy ? (slow ? { kind: 'slow', message: 'The API answered but slowly (' + latencyMs + ' ms).', remediation: 'Check the network quality or server load.' } : null)
          : { kind: 'unhealthy', message: 'The API responded but did not report a healthy status.', remediation: 'Inspect the server logs.' },
        checks: state.checks + 1
      });
      return { schedule: pollMs };
    } catch (error) {
      let failure;
      let next = 'disconnected';
      if (error && error.probeKind === 'auth-failed') {
        next = 'auth-failed';
        failure = { kind: 'auth', message: 'The server rejected the request (HTTP ' + error.status + ').', remediation: 'Check the API token and any proxy or firewall in front of the API.' };
      } else if (error && error.probeKind === 'unavailable') {
        failure = { kind: 'unavailable', message: 'The address answered with a web page instead of JPTI API data (HTTP ' + error.status + ').', remediation: 'This looks like a static site. Point JPTI at the host that runs the Node API.' };
      } else if (error && error.probeKind === 'http') {
        failure = { kind: 'http', message: 'The API answered with HTTP ' + error.status + '.', remediation: 'Inspect the API server logs.' };
      } else {
        failure = classifyProbeFailure(error, { online });
        if (failure.kind === 'offline') next = 'offline';
      }
      const failures = state.consecutiveFailures + 1;
      publish({ ...base, state: next, latencyMs: null, lastCheckedAt: new Date(now()).toISOString(), consecutiveFailures: failures, error: failure, checks: state.checks + 1 });
      return { schedule: computeBackoffMs(failures, { baseDelayMs, maxDelayMs, random }) };
    } finally {
      if (guard) clearTimer(guard);
    }
  }

  function check() {
    if (inflight) return inflight;
    inflight = probe().then((result) => { if (result.schedule !== undefined) schedule(result.schedule); return state; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    check,
    start() { if (!running) { running = true; } return check(); },
    stop() { running = false; if (timer) clearTimer(timer); timer = null; },
    // Called on online/offline/connection-type/visibility/config changes: forget the
    // backoff and re-verify immediately instead of waiting for the next retry.
    notifyNetworkChange() {
      publish({ consecutiveFailures: 0, online: isOnline() });
      if (timer) { clearTimer(timer); timer = null; }
      return check();
    },
    markOffline() { publish({ online: false, state: 'offline' }); }
  };
}

// Wires browser signals to a monitor. Returns a detach function.
export function attachNetworkListeners(monitor, { win = typeof window !== 'undefined' ? window : null, nav = typeof navigator !== 'undefined' ? navigator : null, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const onOnline = () => { monitor.notifyNetworkChange(); };
  const onOffline = () => { monitor.markOffline(); };
  const onConfig = () => { monitor.notifyNetworkChange(); };
  const onVisible = () => { if (!doc || doc.visibilityState !== 'hidden') monitor.notifyNetworkChange(); };
  win.addEventListener('online', onOnline);
  win.addEventListener('offline', onOffline);
  win.addEventListener('jpti:api-config-changed', onConfig);
  const connection = nav && (nav.connection || nav.mozConnection || nav.webkitConnection);
  if (connection && typeof connection.addEventListener === 'function') connection.addEventListener('change', onOnline); // Wi-Fi <-> cellular
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);
  return () => {
    win.removeEventListener('online', onOnline);
    win.removeEventListener('offline', onOffline);
    win.removeEventListener('jpti:api-config-changed', onConfig);
    if (connection && typeof connection.removeEventListener === 'function') connection.removeEventListener('change', onOnline);
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
  };
}

// Opens a WebSocket and verifies that it opens AND delivers a message.
export function testWebSocket(url, { WebSocketImpl = typeof WebSocket !== 'undefined' ? WebSocket : null, openTimeoutMs = 8000, messageTimeoutMs = 5000, now = Date.now } = {}) {
  return new Promise((resolve) => {
    const started = now();
    if (!url) return resolve({ status: 'not-configured', error: 'No WebSocket URL is configured.' });
    if (!WebSocketImpl) return resolve({ status: 'disconnected', error: 'WebSocket is not available in this environment.' });
    let socket, opened = false, settled = false, openMs = null, openTimer, messageTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(openTimer); clearTimeout(messageTimer);
      try { socket && socket.close(); } catch { /* ignore */ }
      resolve(result);
    };
    try { socket = new WebSocketImpl(url); } catch (error) { return finish({ status: 'disconnected', error: error.message || 'Invalid WebSocket URL.' }); }
    openTimer = setTimeout(() => finish({ status: 'disconnected', error: 'The WebSocket did not open within ' + openTimeoutMs + ' ms.' }), openTimeoutMs);
    socket.onopen = () => {
      opened = true; openMs = now() - started;
      clearTimeout(openTimer);
      messageTimer = setTimeout(() => finish({ status: 'degraded', openMs, messageReceived: false, error: 'Connected, but no message arrived within ' + messageTimeoutMs + ' ms.' }), messageTimeoutMs);
    };
    socket.onmessage = () => finish({ status: 'connected', openMs, messageReceived: true, error: null });
    socket.onerror = () => { if (!opened) finish({ status: 'disconnected', error: 'The WebSocket connection failed (check WSS, certificate and server).' }); };
    socket.onclose = () => { if (!settled) finish({ status: opened ? 'degraded' : 'disconnected', openMs, messageReceived: false, error: 'The socket closed before a message was received.' }); };
  });
}
