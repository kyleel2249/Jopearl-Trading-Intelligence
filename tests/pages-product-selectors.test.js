import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildSync } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));

// Drives the real pages in a DOM against a mocked Bitget API: product selectors must keep what the
// user picks on every page, and the Workbench, Alerts, Backtest Compare and Health pages must work.
test('product selectors hold on every page and the advanced workspaces behave', () => {
  const dir = join(root, 'node_modules', '.cache', 'jpti-tests');
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, 'pages-harness.mjs');
  buildSync({ entryPoints: [join(root, 'tests/fixtures/pages-harness.jsx')], outfile: bundle, bundle: true, format: 'esm', platform: 'node', packages: 'external', loader: { '.css': 'empty', '.jsx': 'jsx' }, jsx: 'automatic', logLevel: 'error' });
  const run = spawnSync(process.execPath, [join(root, 'tests/fixtures/product-sync-runner.mjs'), bundle], { cwd: root, encoding: 'utf8', timeout: 120000 });
  rmSync(bundle, { force: true });
  assert.equal(run.status, 0, 'harness failed or hung: ' + (run.stderr || '').slice(0, 500) + (run.error ? String(run.error) : ''));
  const { checks, loops } = JSON.parse(run.stdout.split('RESULT:')[1]);
  assert.ok(checks.length >= 30, 'expected the full scenario set, got ' + checks.length);
  const failed = checks.filter((c) => !c.pass).map((c) => c.name + (c.detail ? ' -> ' + c.detail : ''));
  assert.deepEqual(failed, [], 'failed checks:\n' + failed.join('\n'));
  assert.deepEqual(loops, [], 'render loop detected');
});
