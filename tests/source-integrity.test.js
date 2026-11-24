import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const listFiles = (dir, pattern) => readdirSync(join(root, dir)).filter((name) => pattern.test(name)).map((name) => join(dir, name));

// A corrupted file (for example a literal backslash-n pasted into code) makes the whole
// file unparseable, which otherwise surfaces as one opaque failure. Name the file instead.
test('every test and script file parses as valid JavaScript', () => {
  const files = [
    ...listFiles('tests', /\.(test\.)?(js|mjs|cjs)$/),
    ...listFiles('scripts', /\.(js|mjs|cjs)$/)
  ];
  assert.ok(files.length > 0, 'expected test and script files to exist');
  const broken = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) broken.push(`${file}: ${(result.stderr || '').split('\n').find((line) => /Error/.test(line)) || 'syntax error'}`);
  }
  assert.deepEqual(broken, [], `unparseable files:\n${broken.join('\n')}`);
});
