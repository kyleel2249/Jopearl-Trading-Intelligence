// Verifies a built dist/ folder is safe to publish on Cloudflare Pages.
// Usage: node scripts/verify-pages-build.mjs [distDir]
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
const MAX_FILE_BYTES = 25 * 1024 * 1024; // Cloudflare Pages per-file limit
const MAX_FILES = 20000; // Cloudflare Pages free-plan file limit
const errors = [];
const warnings = [];
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pagesFunction = path.join(projectRoot, 'functions', 'api', '[[path]].js');
const wranglerConfig = path.join(projectRoot, 'wrangler.toml');
if (!fs.existsSync(pagesFunction)) errors.push('Cloudflare Pages API function is missing: functions/api/[[path]].js');
if (!fs.existsSync(wranglerConfig)) errors.push('Cloudflare Pages configuration is missing: wrangler.toml');
else {
  const config = fs.readFileSync(wranglerConfig, 'utf8');
  if (!/pages_build_output_dir\s*=\s*["']\.\/dist["']/.test(config)) {
    errors.push('wrangler.toml must set pages_build_output_dir = "./dist".');
  }
}

if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('ERROR: ' + path.join(dist, 'index.html') + ' not found. Run npm run build first.');
  process.exit(1);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  }
})(dist);

if (files.length > MAX_FILES) errors.push('Build has ' + files.length + ' files; Cloudflare Pages allows ' + MAX_FILES + '.');
for (const file of files) {
  const size = fs.statSync(file).size;
  if (size > MAX_FILE_BYTES) errors.push(path.relative(dist, file) + ' is ' + (size / 1048576).toFixed(1) + ' MiB; the Pages limit is 25 MiB per file.');
}

const base = String(process.env.JPTI_BASE_PATH || '/').trim() || '/';
if (process.env.CF_PAGES && base !== '/') {
  errors.push('JPTI_BASE_PATH=' + base + ' is set on a Cloudflare Pages build. Pages serves from the domain root; remove the variable.');
}

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const referenced = [...html.matchAll(/(?:src|href)="([^"#?]+)"/g)].map((match) => match[1]);
for (const ref of referenced) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue; // external, data:, mailto:
  const relative = ref.startsWith(base) ? ref.slice(base.length) : ref.replace(/^\//, '');
  if (!relative) continue;
  if (!fs.existsSync(path.join(dist, relative))) errors.push('index.html references ' + ref + ' but ' + relative + ' is missing from dist.');
}

for (const required of ['manifest.webmanifest', 'sw.js', 'jpti-icon.svg']) {
  if (!fs.existsSync(path.join(dist, required))) warnings.push(required + ' is missing from dist; PWA features will be degraded.');
}
if (!fs.existsSync(path.join(dist, '_headers'))) warnings.push('_headers is missing from dist; security and cache headers will not be applied.');
if (fs.existsSync(path.join(dist, '404.html'))) warnings.push('dist/404.html disables the automatic single-page-app fallback on Cloudflare Pages; remove it.');

console.log('JPTI Pages build check: ' + files.length + ' file(s) inspected in ' + dist + '.');
warnings.forEach((line) => console.warn('WARN:', line));
errors.forEach((line) => console.error('ERROR:', line));
if (errors.length) process.exit(1);
console.log('Cloudflare Pages build verification passed.');
