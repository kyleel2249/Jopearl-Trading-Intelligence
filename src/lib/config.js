const env = import.meta.env || {};

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
};

// Validation never throws. A bad VITE_API_BASE_URL on the hosting dashboard (for
// example a trailing /api path) used to throw while this module was imported,
// which stopped the whole bundle before React mounted and left a blank page.
// It is now reported as a visible diagnostic and the API resolver falls back to
// the saved Settings override or configuration-required mode.
const checkOrigin = (value, name) => {
  const raw = String(value || '').trim();
  if (!raw) return { value: '', raw: '', error: '' };
  let url;
  try { url = new URL(raw); } catch { return { value: '', raw, error: name + ' must be a valid URL.' }; }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    return { value: '', raw, error: name + ' must be an origin without path, credentials, query, or fragment.' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { value: '', raw, error: name + ' must use HTTPS (HTTP is allowed only on localhost).' };
  }
  return { value: url.origin, raw, error: '' };
};

const apiOrigin = checkOrigin(env.VITE_API_BASE_URL, 'VITE_API_BASE_URL');

export const JPTI_CONFIG = Object.freeze({
  appName: String(env.VITE_APP_NAME || 'JPTI'),
  environment: String(env.VITE_APP_ENV || (env.DEV ? 'development' : 'production')),
  // Normalised origin when valid. When invalid the raw text is kept so the API
  // resolver can show its own "deployment address ignored" warning in Settings.
  apiBaseUrl: apiOrigin.error ? apiOrigin.raw : apiOrigin.value,
  apiBaseUrlError: apiOrigin.error,
  // Optional reverse-proxy prefix placed before /api. Validated by the API resolver,
  // which reports an invalid value as a visible warning instead of crashing start-up.
  apiPathPrefix: String(env.VITE_API_PATH_PREFIX || '').trim(),
  websocketUrl: String(env.VITE_WS_URL || '').trim(),
  features: Object.freeze({
    analytics: bool(env.VITE_ENABLE_ANALYTICS, true),
    crashReporting: bool(env.VITE_ENABLE_CRASH_REPORTING, true),
    performanceMonitoring: bool(env.VITE_ENABLE_PERFORMANCE_MONITORING, true),
    configDiagnostics: bool(env.VITE_ENABLE_CONFIG_DIAGNOSTICS, true)
  })
});

export function getConfigDiagnostics() {
  const warnings = [];
  if (JPTI_CONFIG.apiBaseUrlError) warnings.push(JPTI_CONFIG.apiBaseUrlError + ' The value was ignored.');
  else if (!JPTI_CONFIG.apiBaseUrl) warnings.push('API origin is not configured; API calls use same-origin or the saved Settings override.');
  if (JPTI_CONFIG.websocketUrl && !/^wss:\/\//i.test(JPTI_CONFIG.websocketUrl) && !/^ws:\/\/localhost(?::|$)/i.test(JPTI_CONFIG.websocketUrl)) {
    warnings.push('WebSocket URL should use WSS, except local development.');
  }
  return Object.freeze({
    appName: JPTI_CONFIG.appName,
    environment: JPTI_CONFIG.environment,
    apiConfigured: Boolean(JPTI_CONFIG.apiBaseUrl) && !JPTI_CONFIG.apiBaseUrlError,
    apiPathPrefix: JPTI_CONFIG.apiPathPrefix,
    websocketConfigured: Boolean(JPTI_CONFIG.websocketUrl),
    features: JPTI_CONFIG.features,
    warnings
  });
}

export default JPTI_CONFIG;
