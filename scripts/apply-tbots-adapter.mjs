import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const appRoot = resolve(root, 'integrations/t-bots');
const adapterRoot = resolve(root, 'integrations/t-bots-adapter');

const guardedFiles = [
  'public/index.html',
  'public/js/main.js',
  'public/js/core/orchestrator.js',
  'public/js/agents/scanner.js',
  'public/js/agents/rug-check.js',
  'public/js/config.js',
  'public/js/prompt-template.js',
  'public/js/prompt-parser.js',
  'public/js/prompt-manager.js',
  'tests/engine.test.mjs',
  'public/js/market/live-feed.js'
];

async function applyGuardedOverlay(relative) {
  const target = resolve(appRoot, relative);
  const baseline = await readFile(resolve(adapterRoot, 'baselines', relative + '.base'), 'utf8');
  const overlayRelative = relative === 'tests/engine.test.mjs' ? relative + '.overlay' : relative;
  const overlay = await readFile(resolve(adapterRoot, 'overlays', overlayRelative), 'utf8');
  const current = await readFile(target, 'utf8');
  if (current !== baseline && current !== overlay) {
    throw new Error('T-Bots upstream changed an adapter-owned file: ' + relative + '. Reconcile the upstream change with the JPTI overlay before syncing; no overwrite was applied.');
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, overlay, 'utf8');
}

async function copyOverlay(source, destination) {
  const target = resolve(appRoot, destination);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(adapterRoot, source), target);
}

for (const relative of guardedFiles) await applyGuardedOverlay(relative);

await copyOverlay('jpti-bridge.js', 'public/js/services/jpti-bridge.js');
await copyOverlay('universal-feed.js', 'public/js/market/universal-feed.js');

const tests = [
  ['overlays/public/js/market/live-feed.multi-chain.test.js.overlay', 'public/js/market/live-feed.multi-chain.test.js'],
  ['overlays/public/js/market/universal-feed.test.js.overlay', 'public/js/market/universal-feed.test.js'],
  ['overlays/public/js/agents/universal-scanner.test.js.overlay', 'public/js/agents/universal-scanner.test.js']
];
for (const [source, destination] of tests) await copyOverlay(source, destination);

console.log('T-Bots universal JPTI adapter overlays applied. Adapter-owned upstream changes are guarded and require manual reconciliation.');
