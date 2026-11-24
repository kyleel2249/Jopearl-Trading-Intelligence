import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSources, checkSyntax } from '../scripts/check-syntax.mjs';

const script = fileURLToPath(new URL('../scripts/check-syntax.mjs', import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'jpti-syntax-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, ...name.split('/'));
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test('syntax checker discovers nested js, mjs and cjs files and skips dependency and build folders', () => {
  const root = fixture({
    'a.js': 'export const a = 1;\n',
    'deep/nested/b.mjs': 'export const b = 2;\n',
    'deep/c.cjs': 'module.exports = 3;\n',
    'notes.md': '# not code\n',
    'node_modules/pkg/index.js': 'this is not valid javascript (((\n',
    'dist/bundle.js': 'also ((( broken\n'
  });
  try {
    const names = collectSources(root).map((file) => file.slice(root.length + 1).split(sep).join('/'));
    assert.deepEqual(names, ['a.js', 'deep/c.cjs', 'deep/nested/b.mjs']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syntax checker reports exactly the files that do not parse', () => {
  const root = fixture({ 'good.js': 'export const ok = true;\n', 'sub/bad.js': 'const = ;\n' });
  try {
    const result = checkSyntax(root);
    assert.equal(result.checked, 2);
    assert.deepEqual(result.failures.map((failure) => failure.file.split(sep).join('/')), ['sub/bad.js']);
    assert.match(result.failures[0].message, /SyntaxError/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('syntax checker command exits non-zero for a broken tree and zero for a clean one', () => {
  const broken = fixture({ 'bad.js': 'function (\n' });
  const clean = fixture({ 'fine.js': 'export default () => 1;\n' });
  try {
    const failed = spawnSync(process.execPath, [script, broken], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /FAIL bad\.js/);
    const passed = spawnSync(process.execPath, [script, clean], { encoding: 'utf8' });
    assert.equal(passed.status, 0);
    assert.match(passed.stdout, /Syntax check passed: 1 JavaScript file/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});
