import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

// Regression: selecting a product (Futures, Coin-M, USDC-M, Margin, CFD) on the shared chart used to
// snap back to Spot or loop forever, because the chart re-applied its parent's prop on every local
// change while also reporting the change to that parent. This runs the real components in a DOM.
test('the product selector keeps what the user picks (no snap-back to Spot, no render loop)', () => {
  const dir = join(root, 'node_modules', '.cache', 'jpti-tests');
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, 'product-sync-harness.mjs');
  buildSync({
    entryPoints: [join(root, 'tests/fixtures/product-sync-harness.jsx')],
    outfile: bundle, bundle: true, format: 'esm', platform: 'node', packages: 'external',
    loader: { '.css': 'empty', '.jsx': 'jsx' }, jsx: 'automatic', logLevel: 'error'
  });
  const run = spawnSync(process.execPath, [join(root, 'tests/fixtures/product-sync-runner.mjs'), bundle], { cwd: root, encoding: 'utf8', timeout: 60000 });
  rmSync(bundle, { force: true });
  assert.equal(run.status, 0, 'harness failed or hung (render loop?): ' + (run.stderr || '').slice(0, 400) + (run.error ? String(run.error) : ''));
  const { results, notices } = JSON.parse(run.stdout.split('RESULT:')[1]);
  assert.equal(results.length, 3);
  for (const scenario of results) {
    assert.equal(scenario.start, 'futures', scenario.name + ' should start on Futures');
    for (const [picked, shown] of scenario.picks) assert.equal(shown, picked, scenario.name + ': picked ' + picked + ' but the selector shows ' + shown);
  }
  assert.deepEqual(notices.filter((message) => /Maximum update depth/.test(message)), [], 'render loop detected');
});
