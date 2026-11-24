#!/usr/bin/env node
// Syntax-checks every JavaScript source file in the repository with `node --check`.
// Files are discovered by walking the tree, so a newly added module can never be skipped
// the way it could be when each path had to be listed by hand in package.json.
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'release', 'coverage', 'build', '.git', '.wrangler']);
const SOURCE_FILE = /\.(?:js|mjs|cjs)$/;

export function collectSources(root) {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(join(directory, entry.name));
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
        found.push(join(directory, entry.name));
      }
    }
  };
  visit(root);
  return found.sort();
}

export function checkSyntax(root) {
  const files = collectSources(root);
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
      const detail = (result.stderr || '').split('\n').find((line) => /Error/.test(line)) || 'syntax error';
      failures.push({ file: relative(root, file), message: detail.trim() });
    }
  }
  return { checked: files.length, failures };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = resolve(process.argv[2] || fileURLToPath(new URL('..', import.meta.url)));
  const { checked, failures } = checkSyntax(root);
  if (failures.length) {
    for (const failure of failures) console.error('FAIL ' + failure.file + ': ' + failure.message);
    console.error('Syntax check failed: ' + failures.length + ' of ' + checked + ' file(s) are not valid JavaScript.');
    process.exit(1);
  }
  console.log('Syntax check passed: ' + checked + ' JavaScript file(s) parsed.');
}
