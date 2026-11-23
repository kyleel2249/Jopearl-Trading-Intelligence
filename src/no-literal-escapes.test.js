import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard: automated edits have twice left a literal backslash-n
// (an escaped newline) on its own line in source files. In JSX this renders
// as visible "\n" text; in import blocks it breaks the module.
const root = fileURLToPath(new URL('.', import.meta.url));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(jsx?|mjs|cjs)$/.test(name) && !name.endsWith('.test.js') ? [full] : [];
  });
}

test('source files contain no stray literal "\\n" lines', () => {
  const offenders = [];
  for (const file of walk(root)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\\n)+\s*$/.test(line)) offenders.push(`${relative(root, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `Literal "\\n" lines found: ${offenders.join(', ')}`);
});
