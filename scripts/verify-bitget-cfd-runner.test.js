import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRunnerCfdAccess } from './verify-bitget-cfd-runner.mjs';

function logger() {
  const rows = [];
  return { rows, log(value) { rows.push(JSON.parse(value)); }, warn(value) { rows.push(JSON.parse(value)); } };
}

test('runner CFD probe reports read-only UTA access without exposing account identity or IP addresses', async () => {
  const output = logger();
  const report = await verifyRunnerCfdAccess({
    secrets: {},
    provider: { async request() { return { status: 200, body: {
      authenticated: true, permissionType: 'read-only', permissions: ['uta_trade'],
      utaTradeReadOnly: true, ipWhitelistConfigured: true, ipWhitelistCount: 2,
      userId: 'must-not-leak', ips: '192.0.2.1,192.0.2.2'
    } }; } },
    logger: output
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.utaTradeReadOnly, true);
  assert.equal(report.ipWhitelistCount, 2);
  assert.equal(JSON.stringify(output.rows).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(output.rows).includes('192.0.2.1'), false);
});

test('runner CFD probe distinguishes a Cloudflare-only 403 from a general Bitget access block', async () => {
  const output = logger();
  const report = await verifyRunnerCfdAccess({
    provider: { async request() { throw Object.assign(new Error('Bitget CFD request returned HTTP 403.'), {
      status: 403, code: 'BITGET_CFD_UPSTREAM_ERROR', upstreamStatus: 403,
      upstreamCode: null, upstreamMessage: null, upstreamContentType: 'application/json',
      upstreamPreview: '{"error":"IP allowlist denied"}', upstreamServer: 'cloudflare', upstreamRay: 'ray-id'
    }); } },
    logger: output
  });
  assert.equal(report.status, 'runner-access-blocked');
  assert.equal(report.upstream.status, 403);
  assert.match(report.upstream.preview, /IP allowlist denied/);
  assert.equal(report.upstream.ray, 'ray-id');
});

test('runner CFD probe identifies invalid credentials or signatures separately from 403', async () => {
  const report = await verifyRunnerCfdAccess({
    provider: { async request() { throw Object.assign(new Error('HTTP 401'), { status: 403, upstreamStatus: 401, upstreamCode: '40006' }); } },
    logger: { log() {}, warn() {} }
  });
  assert.equal(report.status, 'invalid-credentials-or-signature');
  assert.equal(report.upstream.code, '40006');
});

test('runner CFD probe reports missing credentials without failing deployment', async () => {
  const report = await verifyRunnerCfdAccess({
    provider: { async request() { throw Object.assign(new Error('credentials required'), { status: 503, code: 'BITGET_CFD_CREDENTIALS_REQUIRED' }); } },
    logger: { log() {}, warn() {} }
  });
  assert.equal(report.status, 'not-configured');
});


test('runner CFD probe flags a non-read-only key without recommending write permission', async () => {
  const report = await verifyRunnerCfdAccess({
    provider: { async request() { return { status: 200, body: {
      authenticated: true, permissionType: 'read-and-write', permissions: ['uta_trade','withdraw'],
      utaTradeReadOnly: false, ipWhitelistConfigured: false, ipWhitelistCount: 0
    } }; } },
    logger: { log() {}, warn() {} }
  });
  assert.equal(report.status, 'permission-mismatch');
  assert.match(report.warning, /Do not enable write access/);
});
