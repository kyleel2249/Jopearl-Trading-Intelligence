import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('index.html declares the required document structure', () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="UTF-8"/i);
  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.equal((html.match(/id="root"/g) || []).length, 1, 'exactly one #root mount element');
  assert.equal((html.match(/type="module" src="\/src\/main\.jsx"/g) || []).length, 1, 'exactly one module entry');
});

test('index.html uses %BASE_URL% for public assets so every deployment target resolves them', () => {
  for (const asset of ['manifest.webmanifest', 'jpti-icon.svg']) {
    assert.ok(html.includes('%BASE_URL%' + asset), asset + ' must be base-aware');
  }
  assert.doesNotMatch(html, /href="\/(?:manifest|jpti-icon)/, 'no hard-coded root-relative public assets');
});

test('startup recovery screen is wired: retry button, watchdog, same-origin-only resource failures', () => {
  assert.match(html, /id="startup-retry"/);
  assert.match(html, /WATCHDOG_MS/);
  const slow = Number(/SLOW_MS = (\d+)/.exec(html)?.[1]);
  const hard = Number(/WATCHDOG_MS = (\d+)/.exec(html)?.[1]);
  assert.ok(slow >= 15000 && hard >= 60000 && hard > slow, 'slow devices must get a soft notice first and at least 60s before a hard failure');
  assert.match(html, /sameOrigin/);
  assert.match(html, /<noscript>/);
});

test('vite base path is explicit and never inferred from GITHUB_ACTIONS', () => {
  const config = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /process\.env\.GITHUB_ACTIONS/);
  assert.match(config, /JPTI_BASE_PATH/);
});

test('Cloudflare Pages is the only web deployment workflow', () => {
  const pages = readFileSync(new URL('../.github/workflows/cloudflare-pages.yml', import.meta.url), 'utf8');
  assert.match(pages, /npx --no-install wrangler d1 migrations apply JPTI_DB --remote/);
  assert.match(pages, /npx --no-install wrangler pages deploy dist --project-name/);\n  assert.match(pages, /CLOUDFLARE_PAGES_PROJECT/);
  assert.doesNotMatch(pages, /cloudflare\/wrangler-action/);
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.match(packageJson, /"wrangler": "4\.167\.0"/);
  assert.doesNotMatch(pages, /onrender|render\.com|JPTI_API_ORIGIN/i);
  assert.doesNotMatch(pages, /JPTI_BASE_PATH:\s*\/JPTI\//);
});

test('the vite config validates explicit base paths before building', () => {
  const config = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(config, /JPTI_BASE_PATH must be an absolute path/);
  assert.match(config, /resolveBase\(process\.env\.JPTI_BASE_PATH\)/);
});
test('analytics adapter has no third-party SDK dependency', () => {
  const source = readFileSync(new URL('../src/lib/cloudflare-analytics.js', import.meta.url), 'utf8');
  assert.match(source, /Cloudflare Web Analytics/);
  assert.doesNotMatch(source, /googleapis|gstatic|firebase/i);
});

test('workspaces are lazy-loaded and isolated so a failed chunk cannot blank the shell', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /lazy\(\(\) => import\('\.\/AlphaSignalEngine\.jsx'\)\)/);
  assert.match(app, /<WorkspaceBoundary key=\{page\}><Suspense/);
});
