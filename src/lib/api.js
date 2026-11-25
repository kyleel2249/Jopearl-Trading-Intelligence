import { JPTI_CONFIG } from './config.js';
import { resolveApiEndpoint, buildApiUrl, deriveWebSocketUrl, validateOrigin, normalizePathPrefix } from './api-resolver.js';
import { createConnectionMonitor, computeBackoffMs } from './connection-monitor.js';
import { createCircuit } from './api-circuit.js';
import { createDirectProvider, isDirectCapable, DIRECT_SOURCE } from './browser-direct.js';

const STORAGE_KEY = 'jpti.apiBaseUrl';
const PREFIX_KEY = 'jpti.apiPathPrefix';
const TOKEN_KEY = 'jpti.apiToken';
export const API_CONFIG_EVENT = 'jpti:api-config-changed';

const storage = () => {
  try { return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null; } catch { return null; }
};

function emitConfigChange() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(API_CONFIG_EVENT));
    }
  } catch { /* notification is best effort */ }
}

const sessionStorageSafe = () => {
  try { return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null; } catch { return null; }
};
function isPrivateJournalRoute(path) {
  const value = String(path || '').split('?')[0];
  return value === '/api/journal/entries' || value === '/api/mentor/analyze' || value === '/api/session/memory' || value === '/api/session/memory/batch' || value === '/api/alpha/gainz/outcomes' || value.startsWith('/api/paper/') || value.startsWith('/api/org/') || value.startsWith('/api/agents/');
}

export function getApiToken() {
  const store = sessionStorageSafe();
  try { return String(store?.getItem(TOKEN_KEY) || ''); } catch { return ''; }
}
export function setApiToken(value = '') {
  const store = sessionStorageSafe();
  const token = String(value || '').trim();
  try {
    if (token) store?.setItem(TOKEN_KEY, token);
    else store?.removeItem(TOKEN_KEY);
  } catch { /* session-only token storage is best effort */ }
  try { storage()?.removeItem(TOKEN_KEY); } catch { /* remove any legacy localStorage token copy */ }
  emitConfigChange();
  return token;
}

// ---------------------------------------------------------------------------
// Endpoint resolution (see api-resolver.js for the priority rules).
// ---------------------------------------------------------------------------
export function getApiResolution() {
  const win = typeof window === 'undefined' ? null : window;
  const store = storage();
  try {
    store?.removeItem(STORAGE_KEY);
    store?.removeItem(PREFIX_KEY);
    store?.removeItem(TOKEN_KEY);
  } catch { /* old endpoint settings are ignored even if cleanup is blocked */ }
  return resolveApiEndpoint({
    saved: '',
    savedPrefix: '',
    deployment: JPTI_CONFIG.apiBaseUrl,
    deploymentPrefix: '',
    location: win ? win.location : undefined,
    capacitor: win ? win.Capacitor : undefined
  });
}

export function getApiBaseUrl() {
  return getApiResolution().baseUrl;
}

export function getApiPathPrefix() {
  return getApiResolution().pathPrefix;
}

export function getWebSocketUrl() {
  return JPTI_CONFIG.websocketUrl;
}

// WebSocket address that belongs to the resolved API origin (explicit VITE_WS_URL wins).
export function resolveWebSocketUrl(path = '/ws') {
  return JPTI_CONFIG.websocketUrl || deriveWebSocketUrl(getApiResolution(), path);
}

export function validateApiBaseUrl(value) {
  return validateOrigin(value);
}

export function validateApiPathPrefix(value) {
  return normalizePathPrefix(value);
}

export function setApiBaseUrl(value) {
  const result = validateApiBaseUrl(value);
  if (!result.valid) throw new Error(result.error);
  if (result.value) throw new Error('External API gateway URLs are disabled. JPTI uses its same-origin Cloudflare Pages Functions API.');
  const store = storage();
  try { store?.removeItem(STORAGE_KEY); } catch { /* best-effort cleanup */ }
  emitConfigChange();
  return '';
}

export function setApiPathPrefix(value) {
  const result = normalizePathPrefix(value);
  if (!result.valid) throw new Error(result.error);
  const store = storage();
  if (store) {
    if (result.value) store.setItem(PREFIX_KEY, result.value);
    else store.removeItem(PREFIX_KEY);
  }
  emitConfigChange();
  return result.value;
}

export function apiUrl(path) {
  return buildApiUrl(getApiResolution(), path);
}

export const API_UNAVAILABLE_MESSAGE = 'The JPTI API is not reachable from this site: the server returned a web page instead of data.';
export const API_NOT_CONFIGURED_MESSAGE = 'The JPTI API address is not configured. The native app needs the public Cloudflare Pages origin baked into its build as VITE_API_BASE_URL. No separate API gateway is used.';

export class ApiUnavailableError extends Error {
  constructor(message = API_UNAVAILABLE_MESSAGE, code = 'unavailable') {
    super(message);
    this.name = 'ApiUnavailableError';
    this.code = code;
  }
}

export function isApiUnavailable(error) {
  return Boolean(error) && error.name === 'ApiUnavailableError';
}

// Static hosts (static-only hosting origins, the Capacitor shell) answer unknown /api/* paths with
// an HTML page. Calling response.json() on that raised the cryptic
// "Unexpected token '<'" error. Responses that are not JSON now fail with a clear,
// typed error that every existing `await response.json()` call site already handles.
function guardJsonResponse(response) {
  try {
    const type = response?.headers?.get?.('content-type');
    const noBody = response?.status === 204 || response?.status === 205;
    if (typeof type === 'string' && type && !/json/i.test(type) && !noBody) {
      response.json = async () => { throw new ApiUnavailableError(); };
    }
  } catch {
    // Never let diagnostics interfere with the request itself.
  }
  return response;
}

function assertApiConfigured(path) {
  if (/^https?:\/\//i.test(String(path || ''))) return;
  const resolution = getApiResolution();
  if (resolution.native && resolution.status === 'configuration-required') {
    throw new ApiUnavailableError(API_NOT_CONFIGURED_MESSAGE, 'configuration-required');
  }
}

// ---------------------------------------------------------------------------
// Availability layer: where the data on screen comes from.
//
//   mode 'api'    the JPTI API answered
//   mode 'direct' the API is unreachable (static host, sleeping/missing server, unconfigured native app) and
//                 the public market-data routes were answered straight from the exchanges' public REST
//                 endpoints (see browser-direct.js). Ledger, trading and analytics still need the API.
//
// A circuit breaker stops waiting on a dead API after repeated failures, re-probes it on its own and switches
// back as soon as it answers, so the app heals without a reload.
// ---------------------------------------------------------------------------
export const API_SOURCE_EVENT = 'jpti:api-source';
const apiCircuit = createCircuit();
const directProvider = createDirectProvider();
let apiSource = Object.freeze({ mode: 'api', reason: '', servedBy: null, since: Date.now() });

export function getApiSource() { return apiSource; }

export function subscribeApiSource(listener) {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  window.addEventListener(API_SOURCE_EVENT, listener);
  return () => window.removeEventListener(API_SOURCE_EVENT, listener);
}

function setApiSource(mode, reason = '', servedBy = null) {
  if (apiSource.mode === mode && apiSource.reason === reason && apiSource.servedBy === servedBy) return;
  apiSource = Object.freeze({ mode, reason, servedBy, since: Date.now() });
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(API_SOURCE_EVENT, { detail: apiSource }));
    }
  } catch { /* notification is best effort */ }
}

export function getApiCircuitState() { return apiCircuit.snapshot(); }
export function resetApiAvailability() { apiCircuit.reset(); setApiSource('api'); directProvider.clearCache(); }

const isHtmlish = (response) => {
  const type = response?.headers?.get?.('content-type') || '';
  const noBody = response?.status === 204 || response?.status === 205;
  return !noBody && Boolean(type) && !/json/i.test(type);
};

async function directFallback(path, options, reason) {
  const result = await directProvider.request(path, { method: options.method || 'GET', signal: options.signal });
  if (!result || (result.failed && result.status >= 500)) return null; // leave the original error visible
  setApiSource('direct', reason, result.servedBy);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json', 'x-jpti-source': DIRECT_SOURCE }
  });
}

export async function apiFetch(path, options = {}) {
  const direct = isDirectCapable(path, options.method || 'GET');
  if (direct && !apiCircuit.shouldTryApi()) {
    const served = await directFallback(path, options, 'circuit-open');
    if (served) return served;
  }
  try {
    assertApiConfigured(path);
  } catch (error) {
    if (direct) {
      const served = await directFallback(path, options, 'not-configured');
      if (served) return served;
    }
    throw error;
  }
  const headers = new Headers(options.headers || {});
  const token = getApiToken();
  if (token && isPrivateJournalRoute(path) && !headers.has('x-jpti-api-token')) headers.set('x-jpti-api-token', token);
  let response;
  try {
    response = await fetch(apiUrl(path), { ...options, headers });
  } catch (error) {
    if (error && error.name === 'AbortError') throw error; // a cancelled request is not an outage
    apiCircuit.failure();
    if (direct) {
      const served = await directFallback(path, options, 'network');
      if (served) return served;
    }
    throw error;
  }
  if (isHtmlish(response)) {
    apiCircuit.failure(); // a static host or proxy answered with a web page, not the API
    if (direct) {
      const served = await directFallback(path, options, 'bad-response');
      if (served) return served;
    }
  } else if (response.status >= 500 && response.status !== 501) {
    // Cloudflare edge can be healthy while an upstream exchange rejects its egress IP.
    // Count this as an API-path failure so repeated requests prefer the browser-direct
    // public-data adapter and only probe the edge again after the circuit cooldown.
    apiCircuit.failure();
    if (direct) {
      const served = await directFallback(path, options, 'server-error');
      if (served) return served;
    }
  } else {
    apiCircuit.success();
    const runtime = response.headers?.get?.('x-jpti-runtime');
    setApiSource(runtime === 'cloudflare-edge' ? 'cloudflare-edge' : 'api');
  }
  return guardJsonResponse(response);
}

// ---------------------------------------------------------------------------
// apiRequest: the full-featured client (timeout, cancellation, retry with
// exponential backoff, normalised errors, JSON/binary parsing).
// ---------------------------------------------------------------------------
export class ApiRequestError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.kind = kind; // timeout | offline | network | http | auth | unavailable | configuration-required | aborted
    this.retryable = false;
    Object.assign(this, extra);
  }
}

const newRequestId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));

const pause = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new ApiRequestError('aborted', 'The request was cancelled.')); }, { once: true });
});

export async function apiRequest(path, {
  method = 'GET', json, body, headers: extraHeaders, timeoutMs = 15000, retries,
  signal, parse = 'json', retryBaseMs = 500, fetchImpl
} = {}) {
  const verb = String(method).toUpperCase();
  const maxRetries = retries ?? (verb === 'GET' || verb === 'HEAD' ? 2 : 0);
  const requestId = newRequestId();
  const doFetch = fetchImpl || ((...args) => fetch(...args));

  const attemptOnce = async () => {
    try { assertApiConfigured(path); } catch (error) {
      throw new ApiRequestError('configuration-required', error.message, { requestId });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const headers = new Headers(extraHeaders || {});
    const token = getApiToken();
    if (token && isPrivateJournalRoute(path) && !headers.has('x-jpti-api-token')) headers.set('x-jpti-api-token', token);
    if (json !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const started = Date.now();
    try {
      const response = await doFetch(apiUrl(path), { method: verb, headers, body: json !== undefined ? JSON.stringify(json) : body, signal: controller.signal, cache: 'no-store' });
      const latencyMs = Date.now() - started;
      const type = response.headers?.get?.('content-type') || '';
      if (response.status === 204 || response.status === 205 || parse === 'none') return { ok: response.ok, status: response.status, data: null, headers: response.headers, requestId, latencyMs };
      if (parse === 'blob' || parse === 'text') {
        const data = parse === 'blob' ? await response.blob() : await response.text();
        if (!response.ok) throw new ApiRequestError('http', 'HTTP ' + response.status, { status: response.status, requestId, retryable: response.status >= 500 });
        return { ok: true, status: response.status, data, headers: response.headers, requestId, latencyMs };
      }
      if (!/json/i.test(type)) throw new ApiRequestError('unavailable', API_UNAVAILABLE_MESSAGE, { status: response.status, requestId });
      const data = await response.json();
      if (!response.ok) {
        const message = (data && (data.error || data.message)) || 'HTTP ' + response.status;
        const kind = response.status === 401 || response.status === 403 ? 'auth' : 'http';
        throw new ApiRequestError(kind, String(message), { status: response.status, data, requestId, retryable: response.status === 429 || (response.status >= 500 && response.status !== 501) });
      }
      return { ok: true, status: response.status, data, headers: response.headers, requestId, latencyMs };
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (error && error.name === 'AbortError') {
        if (timedOut) throw new ApiRequestError('timeout', 'The API did not answer within ' + timeoutMs + ' ms.', { requestId, retryable: true });
        throw new ApiRequestError('aborted', 'The request was cancelled.', { requestId });
      }
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      throw new ApiRequestError(offline ? 'offline' : 'network', offline ? 'The device appears to be offline.' : 'The API could not be reached.', { requestId, retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    try { return await attemptOnce(); } catch (error) {
      if (!(error instanceof ApiRequestError) || !error.retryable || attempt >= maxRetries || (signal && signal.aborted)) throw error;
      await pause(computeBackoffMs(attempt + 1, { baseDelayMs: retryBaseMs, maxDelayMs: 8000 }), signal);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared connection monitor (one per app) used by the Connection Health dashboard.
// ---------------------------------------------------------------------------
let sharedMonitor = null;
export function getConnectionMonitor() {
  if (!sharedMonitor) {
    sharedMonitor = createConnectionMonitor({
      getResolution: getApiResolution,
      buildUrl: apiUrl,
      fetchImpl: (url, init) => fetch(url, init)
    });
  }
  return sharedMonitor;
}
