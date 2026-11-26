/**
 * Synchronize GitHub Actions configuration into Cloudflare Pages runtime config.
 *
 * GitHub repository/environment Variables are supplied as JSON by toJSON(vars).
 * Sensitive values are supplied as one GitHub Actions secret containing a JSON
 * object (JPTI_CLOUDFLARE_SECRETS_JSON). Values are never logged.
 *
 * Sync is additive/update-only: existing Cloudflare bindings and unrelated
 * environment settings are preserved, and absent GitHub keys are not deleted.
 */
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const project = (process.env.CLOUDFLARE_PAGES_PROJECT || 'jpti').trim();
if (!accountId || !apiToken) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required.');
if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Invalid Cloudflare Pages project name.');

function parseObject(raw, label) {
  if (!raw?.trim()) return {};
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error(label + ' must contain valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a JSON object.');
  return value;
}
function normalizeMap(input, label) {
  const output = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(label + ' contains an invalid variable name: ' + key);
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw === 'object') throw new Error(label + ' values must be strings or numbers: ' + key);
    output[key] = String(raw);
  }
  return output;
}

const githubVars = parseObject(process.env.GITHUB_REPOSITORY_VARIABLES_JSON, 'GitHub Variables');
const customVars = parseObject(process.env.JPTI_CLOUDFLARE_VARS_JSON, 'JPTI_CLOUDFLARE_VARS_JSON');
const selectedVars = {};
for (const [key, value] of Object.entries(githubVars)) {
  // Only application configuration is copied. CI/CD control variables remain in GitHub.
  if (/^VITE_[A-Z0-9_]+$/.test(key) || /^JPTI_(?:ALERT_|CORS_|EVENT_RISK_|TRADING_MODE$|ENABLE_[A-Z0-9_]+$|CROSS_VENUE_[A-Z0-9_]+$|TRUST_PROXY$)/.test(key)) {
    selectedVars[key] = value;
  }
}
const variables = normalizeMap({ ...selectedVars, ...customVars }, 'Cloudflare variables');
const secrets = normalizeMap(parseObject(process.env.JPTI_CLOUDFLARE_SECRETS_JSON, 'JPTI_CLOUDFLARE_SECRETS_JSON'), 'Cloudflare secrets');
for (const key of Object.keys(secrets)) {
  if (key.startsWith('VITE_')) throw new Error('Refusing to sync secret ' + key + ': VITE_ values are public browser-build variables.');
  if (Object.hasOwn(variables, key)) throw new Error('Variable and secret maps contain the same key: ' + key);
}
if (!Object.keys(variables).length && !Object.keys(secrets).length) {
  console.log('No Cloudflare runtime variables or secrets were supplied; existing configuration was left unchanged.');
  process.exit(0);
}

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${project}`;
async function cfRequest(method, body) {
  const response = await fetch(endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + apiToken, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const messages = (payload.errors || []).map((item) => item.message).filter(Boolean).join('; ');
    throw new Error(`Cloudflare Pages API ${method} failed (${response.status}): ${messages || 'request rejected'}`);
  }
  return payload.result;
}

const current = await cfRequest('GET');
const deploymentConfigs = current?.deployment_configs || {};
const nextConfigs = {};
for (const environment of ['production', 'preview']) {
  const existing = deploymentConfigs[environment] || {};
  const envVars = { ...(existing.env_vars || {}) };
  for (const [key, value] of Object.entries(variables)) envVars[key] = { type: 'plain_text', value };
  for (const [key, value] of Object.entries(secrets)) envVars[key] = { type: 'secret_text', value };
  nextConfigs[environment] = { ...existing, env_vars: envVars };
}
await cfRequest('PATCH', { deployment_configs: nextConfigs });
console.log(`Cloudflare Pages config synchronized for production and preview: ${Object.keys(variables).length} variable(s), ${Object.keys(secrets).length} secret(s). Values were not logged.`);
