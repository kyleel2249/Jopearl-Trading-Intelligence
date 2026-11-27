import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const productionOrigin = 'https://jopearl-trading-intelligence.pages.dev';
const project = 'jopearl-trading-intelligence';

test('Cloudflare deployment targets the established production Pages project', () => {
  const workflow = read('../.github/workflows/cloudflare-pages.yml');
  assert.match(workflow, new RegExp("CLOUDFLARE_PAGES_PROJECT: \\?\\$\\{\\{ vars\\.CLOUDFLARE_PAGES_PROJECT \\|\\| '" + project + "' \\}\\}"));
  assert.ok(workflow.includes("wrangler pages deploy dist --project-name \"\${{ vars.CLOUDFLARE_PAGES_PROJECT || '" + project + "' }}\""));
  assert.ok(workflow.includes('JPTI_DEPLOY_URL: https://\${{ vars.CLOUDFLARE_PAGES_PROJECT || \' + project + \' }}.pages.dev'));
  assert.ok(workflow.includes(productionOrigin));
  assert.ok(!workflow.includes('https://jpti.pages.dev'));
});

test('Android builds use the same production API origin as the web deployment', () => {
  for (const path of ['../.github/workflows/build-apps.yml', '../.github/workflows/mobile-android.yml']) {
    const workflow = read(path);
    assert.ok(workflow.includes(productionOrigin), path + ' must use the verified production Pages API origin');
    assert.ok(!workflow.includes('https://jpti.pages.dev'), path + ' must not retain the stale Pages fallback');
  }
});

test('Bitget live verification defaults to the established production site', () => {
  const script = read('../scripts/verify-bitget-live.mjs');
  assert.ok(script.includes("process.env.JPTI_PAGES_URL || '" + productionOrigin + "'"));
  assert.ok(!script.includes('https://jpti.pages.dev'));
});
