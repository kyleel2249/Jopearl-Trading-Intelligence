import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const productionOrigin = 'https://jopearl-trading-intelligence.pages.dev';
const project = 'jopearl-trading-intelligence';

test('Cloudflare deployment is pinned to the canonical production Pages project', () => {
  const workflow = read('../.github/workflows/cloudflare-pages.yml');
  assert.ok(workflow.includes('CLOUDFLARE_PAGES_PROJECT: ' + project));
  assert.ok(workflow.includes('wrangler pages deploy dist --project-name "' + project + '" --branch main'));
  assert.ok(workflow.includes('JPTI_DEPLOY_URL: ' + productionOrigin));
  assert.ok(workflow.includes('JPTI_PAGES_URL: ' + productionOrigin));
  assert.ok(!workflow.includes('vars.CLOUDFLARE_PAGES_PROJECT'));
  assert.ok(!workflow.includes('vars.CLOUDFLARE_PAGES_URL'));
  assert.ok(!workflow.includes('https://jpti.pages.dev'));
});
test('scheduled replication uses the canonical production API endpoint', () => {
  const workflow = read('../.github/workflows/market-data-replication.yml');
  assert.ok(workflow.includes('REPLICATION_URL: ' + productionOrigin + '/api/replication'));
  assert.ok(workflow.includes("new Set(['jopearl-trading-intelligence.pages.dev'])"));
  assert.ok(!workflow.includes('vars.JPTI_REPLICATION_URL'));
});

test('Android builds use the same production API origin as the web deployment', () => {
  for (const path of ['../.github/workflows/build-apps.yml', '../.github/workflows/mobile-android.yml']) {
    const workflow = read(path);
    assert.ok(workflow.includes('VITE_API_BASE_URL: ' + productionOrigin), path + ' must use the verified production Pages API origin');
    assert.ok(!workflow.includes('https://jpti.pages.dev'), path + ' must not retain the stale Pages fallback');
    assert.ok(!workflow.includes('vars.CLOUDFLARE_PAGES_URL'), path + ' must not be overridden by a stale Pages URL variable');
  }
});

test('Bitget live verification defaults to the established production site', () => {
  const script = read('../scripts/verify-bitget-live.mjs');
  assert.ok(script.includes("process.env.JPTI_PAGES_URL || '" + productionOrigin + "'"));
  assert.ok(!script.includes('https://jpti.pages.dev'));
});
