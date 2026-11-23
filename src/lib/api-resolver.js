// Centralised API endpoint resolution for JPTI. Pure functions: every input is
// passed in, so the same logic is unit-tested for browsers, PWAs and Capacitor.
//
// Resolution priority (highest first):
//   1. explicit, validated user override (saved on this device)
//   2. deployment-provided public API origin (VITE_API_BASE_URL)
//   3. the HTTP(S) origin currently serving the app (Cloudflare Pages / PWA)
//   4. (native shell) there is no usable origin -> configuration-required
//
// A Capacitor WebView origin such as https://localhost or capacitor://localhost is the
// app's own asset server, NOT the Cloudflare Pages API, so native builds need the public Pages origin.

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function validateOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return { valid: true, value: '' };
  let parsed;
  try { parsed = new URL(raw); } catch { return { valid: false, error: 'Enter a complete URL such as https://your-jpti.pages.dev.' }; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    return { valid: false, error: 'Use only the API origin or Pages site origin. Do not include credentials, paths, query strings or fragments.' };
  }
  const local = LOCAL_HOSTS.includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) {
    return { valid: false, error: 'Remote API connections must use HTTPS. Plain HTTP is allowed only for localhost.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { valid: false, error: 'Only http: and https: API origins are supported.' };
  }
  return { valid: true, value: parsed.origin };
}

export function normalizePathPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return { valid: true, value: '' };
  if (raw.length > 100 || !/^\/[A-Za-z0-9._~\-\/]*$/.test(raw) || raw.includes('//') || raw.split('/').includes('..')) {
    return { valid: false, error: 'Use a path such as /jpti: letters, digits and - . _ ~ / only, starting with /.' };
  }
  return { valid: true, value: raw.replace(/\/+$/, '') };
}

export function detectNative({ capacitor, location } = {}) {
  try { if (capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform()) return true; } catch { /* fall through */ }
  try {
    const platform = capacitor && typeof capacitor.getPlatform === 'function' ? capacitor.getPlatform() : '';
    if (platform === 'android' || platform === 'ios') return true;
  } catch { /* fall through */ }
  const protocol = location && location.protocol;
  return protocol === 'capacitor:' || protocol === 'ionic:' || protocol === 'file:';
}

// Cloudflare Pages hosts both the static app and its Functions on one origin.
// GitHub Pages is static-only and is no longer a supported deployment target.
const isStaticHost = (location) => String(location?.hostname || '').toLowerCase().endsWith('.github.io');

const originOf = (location) => {
  if (!location) return '';
  const { protocol, origin } = location;
  if ((protocol === 'https:' || protocol === 'http:') && origin && origin !== 'null') return String(origin).replace(/\/$/, '');
  return '';
};

/**
 * @param {object} input
 * @param {string} [input.saved]            user override origin
 * @param {string} [input.savedPrefix]      user override path prefix
 * @param {string} [input.deployment]       VITE_API_BASE_URL
 * @param {string} [input.deploymentPrefix] VITE_API_PATH_PREFIX
 * @param {object} [input.location]         window.location (protocol, origin, hostname)
 * @param {object} [input.capacitor]        window.Capacitor
 * @param {boolean} [input.native]          force native detection (tests)
 */
export function resolveApiEndpoint({ saved = '', savedPrefix = '', deployment = '', deploymentPrefix = '', location, capacitor, native } = {}) {
  const warnings = [];
  const isNative = typeof native === 'boolean' ? native : detectNative({ capacitor, location });
  const user = validateOrigin(saved);
  const deployed = validateOrigin(deployment);
  const browserOrigin = isNative || isStaticHost(location) ? '' : originOf(location);

  const userPrefix = normalizePathPrefix(savedPrefix);
  const deployPrefix = normalizePathPrefix(deploymentPrefix);
  if (!userPrefix.valid) warnings.push({ code: 'invalid-prefix', message: 'Saved path prefix ignored: ' + userPrefix.error });
  if (!deployPrefix.valid) warnings.push({ code: 'invalid-prefix', message: 'Deployment path prefix ignored: ' + deployPrefix.error });
  const pathPrefix = (userPrefix.valid && userPrefix.value) || (deployPrefix.valid && deployPrefix.value) || '';

  let baseUrl = '';
  let source = 'none';
  if (user.valid && user.value) { baseUrl = user.value; source = 'user'; }
  else if (!user.valid) warnings.push({ code: 'saved-invalid', message: 'The saved API address was ignored: ' + user.error });

  if (source === 'none') {
    if (deployed.valid && deployed.value) { baseUrl = deployed.value; source = 'deployment'; }
    else if (!deployed.valid) warnings.push({ code: 'deployment-invalid', message: 'The deployment-provided API address was ignored: ' + deployed.error });
  }
  if (source === 'none' && browserOrigin) { baseUrl = browserOrigin; source = 'browser-origin'; }

  // A saved override that no longer matches the deployment must be visible, never silent.
  if (source === 'user' && deployed.valid && deployed.value && deployed.value !== baseUrl) {
    warnings.push({ code: 'override-differs-from-deployment', message: 'A saved API address (' + baseUrl + ') overrides this deployment\'s API (' + deployed.value + '). Reset to auto-detect if the saved address is stale.' });
  } else if (source === 'user' && !deployed.value && browserOrigin && browserOrigin !== baseUrl) {
    warnings.push({ code: 'override-differs-from-origin', message: 'A saved API address (' + baseUrl + ') overrides the address serving this app (' + browserOrigin + '). Reset to auto-detect if it is stale.' });
  }
  if (baseUrl.startsWith('http:') && location && location.protocol === 'https:' && !LOCAL_HOSTS.some((host) => baseUrl.includes('//' + host))) {
    warnings.push({ code: 'mixed-content', message: 'This page is HTTPS but the API is plain HTTP; browsers will block the requests.' });
  }

  const status = source === 'none' ? 'configuration-required' : 'ok';
  if (status === 'configuration-required' && isStaticHost(location)) {
    warnings.push({ code: 'static-host-needs-api', message: 'This GitHub Pages static origin cannot serve the JPTI API. Deploy JPTI on Cloudflare Pages.' });
  }
  if (status === 'configuration-required' && isNative) {
    warnings.push({ code: 'native-needs-api', message: 'The installed Android app runs from its own local WebView origin, which is not a JPTI server. Enter your reachable HTTPS API address once.' });
  }
  return Object.freeze({
    baseUrl, pathPrefix, source, native: isNative, status,
    warnings: Object.freeze(warnings),
    candidates: Object.freeze({ user: user.valid ? user.value : '', deployment: deployed.valid ? deployed.value : '', browserOrigin })
  });
}

export function buildApiUrl(resolution, path) {
  const text = String(path || '');
  if (/^https?:\/\//i.test(text)) return text;
  const normalized = text.startsWith('/') ? text : '/' + text;
  return (resolution.baseUrl || '') + (resolution.pathPrefix || '') + normalized;
}

// Derives the WebSocket address that belongs to the resolved API origin.
export function deriveWebSocketUrl(resolution, path = '/ws') {
  if (!resolution.baseUrl) return '';
  const url = new URL(resolution.baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const normalized = String(path).startsWith('/') ? path : '/' + path;
  return url.origin + (resolution.pathPrefix || '') + normalized;
}
