import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Electron application entry and packaged sources live under desktop/app', () => {
  assert.equal(pkg.main, 'desktop/app/main.cjs');
  assert.equal(existsSync(new URL('../desktop/app/main.cjs', import.meta.url)), true);
  assert.equal(existsSync(new URL('../desktop/main.cjs', import.meta.url)), false);
  assert.ok(pkg.build.files.includes('desktop/app/**/*'));
});

test('Windows desktop packaging produces installer and portable executables', () => {
  const targets = pkg.build.win.target.map((target) => target.target);
  assert.ok(targets.includes('nsis'));
  assert.ok(targets.includes('portable'));
  assert.equal(pkg.build.directories.output, 'release');
});
