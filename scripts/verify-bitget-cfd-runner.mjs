import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBitgetCfdProvider } from '../functions/bitget-cfd.js';

function isMain() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function loadSecrets() {
  const file = path.resolve(process.cwd(), '.jpti-pages-secrets.json');
  let parsed = {};
  if (fs.existsSync(file)) {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cloudflare Pages secrets file must contain a JSON object.');
  }
  const envKeys = ['JPTI_BITGET_API_KEY','JPTI_BITGET_API_SECRET','JPTI_BITGET_API_PASSPHRASE','BITGET_API_KEY','BITGET_API_SECRET','BITGET_API_PASSPHRASE','JPTI_BITGET_PASSWORD'];
  for (const key of envKeys) if (process.env[key]) parsed[key] = process.env[key];
  return parsed;
}

function safeUpstream(error = {}) {
  return {
    status: Number(error.upstreamStatus || error.status) || null,
    code: error.upstreamCode == null ? null : String(error.upstreamCode),
    message: error.upstreamMessage == null ? null : String(error.upstreamMessage).slice(0, 180),
    contentType: error.upstreamContentType || null,
    preview: error.upstreamPreview || null,
    server: error.upstreamServer || null,
    ray: error.upstreamRay || null,
    date: error.upstreamDate || null
  };
}

export async function verifyRunnerCfdAccess({ secrets = {}, provider = createBitgetCfdProvider(), logger = console } = {}) {
  try {
    const result = await provider.request(secrets, { kind: 'diagnostics' });
    const body = result?.body || {};
    const report = {
      source: 'github-actions-runner',
      status: 'passed',
      authenticated: body.authenticated === true,
      permissionType: body.permissionType || null,
      permissions: Array.isArray(body.permissions) ? body.permissions : [],
      utaTradeReadOnly: body.utaTradeReadOnly === true,
      ipWhitelistConfigured: body.ipWhitelistConfigured === true,
      ipWhitelistCount: Number(body.ipWhitelistCount) || 0
    };
    logger.log?.(JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    const upstream = safeUpstream(error);
    let status = 'failed';
    let warning = String(error?.message || error);
    if (error?.code === 'BITGET_CFD_CREDENTIALS_REQUIRED') {
      status = 'not-configured';
      warning = 'The GitHub deployment secret map does not contain the Bitget CFD read-only credentials.';
    } else if (upstream.status === 401 || ['40006', '40009'].includes(upstream.code)) {
      status = 'invalid-credentials-or-signature';
      warning = 'Bitget rejected the signed GitHub-runner request with HTTP 401. Check the API key, passphrase, secret and signature configuration.';
    } else if (upstream.status === 403) {
      status = 'runner-access-blocked';
      warning = 'Bitget also returned HTTP 403 from the GitHub runner. This points to API-key IP restrictions, UTA/account access, or an upstream access policy rather than Cloudflare-only egress.';
    } else if (upstream.status === 429) {
      status = 'rate-limited';
      warning = 'Bitget rate-limited the signed GitHub-runner diagnostic. Retry after the rate-limit window.';
    }
    const report = { source: 'github-actions-runner', status, warning, upstream };
    logger.warn?.(JSON.stringify(report, null, 2));
    return report;
  }
}

if (isMain()) {
  try {
    const secrets = loadSecrets();
    await verifyRunnerCfdAccess({ secrets });
  } catch (error) {
    console.error('CFD runner diagnostic could not execute:', String(error?.message || error));
    process.exitCode = 1;
  }
}
