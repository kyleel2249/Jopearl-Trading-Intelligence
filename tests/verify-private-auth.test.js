import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPrivateAuth } from '../scripts/verify-private-auth.mjs';

const reply = (status, body = {}) => new Response(JSON.stringify(body), { status });

test('reports split addresses, missing secrets and rejected tokens without echoing the token', async () => {
  const report = await verifyPrivateAuth({
    deployUrl: 'https://a.pages.dev', pagesUrl: 'https://b.pages.dev/', token: 'top-secret',
    fetchImpl: async (url) => url.endsWith('/api/health')
      ? reply(200, { capabilities: { journalAuthConfigured: url.startsWith('https://a.') } })
      : reply(401)
  });
  assert.deepEqual(report.sites.map((site) => [site.secretConfigured, site.token]), [[true, 'rejected'], [false, 'not-checked']]);
  assert.equal(report.warnings.length, 3);
  assert.doesNotMatch(JSON.stringify(report), /top-secret/);
});

test('never sends the token to a non-HTTPS address', async () => {
  const report = await verifyPrivateAuth({ deployUrl: 'http://a.pages.dev', pagesUrl: '', token: 't', fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(report, { sites: [], warnings: [] });
});
