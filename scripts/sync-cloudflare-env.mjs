/**
 * Prepare GitHub-managed configuration for a Cloudflare Pages deployment.
 * - GitHub Variables -> Pages [vars] config (production + preview).
 * - GitHub Secrets JSON -> Wrangler Pages secret bulk input.
 * - VITE_* variables -> .env.production.local for the Vite browser build.
 *
 * Existing wrangler.toml is copied intact, so all D1/KV/AI bindings remain.
 * Synchronization is additive/update-only; omitted keys are never deleted.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const project = (process.env.CLOUDFLARE_PAGES_PROJECT || 'jpti').trim();
if (!/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error('Invalid Cloudflare Pages project name.');
const sourceConfig = path.join(root, 'wrangler.toml');
if (!fs.existsSync(sourceConfig)) throw new Error('Root wrangler.toml was not found.');

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

const SYNCED_NAME = /^(?:VITE_[A-Z0-9_]+|JPTI_(?:ALERT_(?!WEBHOOK)[A-Z0-9_]+|CORS_[A-Z0-9_]+|EVENT_RISK_[A-Z0-9_]+|TRADING_MODE|ENABLE_[A-Z0-9_]+|CROSS_VENUE_[A-Z0-9_]+|TRUST_PROXY))$/;
// Variables arrive one by one from the workflow. Dumping every repository variable as JSON prints
// all of them in the (public) job log, so that map is accepted only for local or legacy use.
const githubVars = {
  ...parseObject(process.env.GITHUB_REPOSITORY_VARIABLES_JSON, 'GitHub Variables'),
  ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => SYNCED_NAME.test(key) && value))
};
const customVars = parseObject(process.env.JPTI_CLOUDFLARE_VARS_JSON, 'JPTI_CLOUDFLARE_VARS_JSON');
const selectedVars = {};
for (const [key, value] of Object.entries(githubVars)) {
  if (SYNCED_NAME.test(key)) {
    selectedVars[key] = value;
  }
}
const variables = normalizeMap({ ...selectedVars, ...customVars }, 'Cloudflare variables');
const secrets = normalizeMap(parseObject(process.env.JPTI_CLOUDFLARE_SECRETS_JSON, 'JPTI_CLOUDFLARE_SECRETS_JSON'), 'Cloudflare secrets');
for (const key of Object.keys(secrets)) {
  if (key.startsWith('VITE_')) throw new Error('Refusing to expose secret ' + key + ': VITE_ variables are public browser-build values.');
  if (Object.hasOwn(variables, key)) throw new Error('Variable and secret maps contain the same key: ' + key);
}

const config = fs.readFileSync(sourceConfig, 'utf8');
if (/^\s*\[vars\]\s*$/m.test(config) || /^\s*\[env\.(?:production|preview)\.vars\]\s*$/m.test(config)) {
  throw new Error('wrangler.toml already defines a vars table. Merge the configuration explicitly rather than generating a duplicate table.');
}
const toml = Object.entries(variables).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
const generatedConfig = config.trimEnd() + (toml ? `\n\n# Generated from GitHub Actions Variables during CI. Do not edit this generated file.\n[vars]\n${toml}\n` : '\n');
fs.writeFileSync(path.join(root, '.wrangler-ci.toml'), generatedConfig, { mode: 0o600 });

const publicBuildVars = Object.fromEntries(Object.entries(variables).filter(([key]) => key.startsWith('VITE_')));
const dotenv = Object.entries(publicBuildVars).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n');
if (dotenv) fs.writeFileSync(path.join(root, '.env.production.local'), dotenv + '\n', { mode: 0o600 });

const secretsPath = path.join(root, '.jpti-pages-secrets.json');
if (Object.keys(secrets).length) fs.writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
else if (fs.existsSync(secretsPath)) fs.unlinkSync(secretsPath);

console.log(`Prepared Cloudflare Pages sync for ${project}: ${Object.keys(variables).length} runtime variable(s), ${publicBuildVars ? Object.keys(publicBuildVars).length : 0} public build variable(s), ${Object.keys(secrets).length} encrypted secret(s).`);
console.log('Generated files are temporary and git-ignored; configuration values are never printed.');
