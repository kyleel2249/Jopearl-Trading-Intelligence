#!/usr/bin/env node
// Fails on references to names that are never declared. `node --check` and the bundler both accept
// them, so they otherwise surface only as a ReferenceError when that code path runs in production.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const UNDEFINED_NAME = new Set([2304, 2552, 18004]);
const NODE_GLOBALS = /'(process|Buffer|require|module|exports|__dirname|__filename|global|setImmediate|NodeJS)'/;
const EXCLUDED = /^integrations\/t-bots-adapter\/(baselines|overlays)\/|\.test\.|^tests\//;

export function findUndefinedNames(files) {
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: true, noEmit: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], types: []
  });
  return program.getSourceFiles()
    .filter((source) => !source.isDeclarationFile && files.some((file) => resolve(file) === resolve(source.fileName)))
    .flatMap((source) => program.getSemanticDiagnostics(source))
    .filter((diagnostic) => UNDEFINED_NAME.has(diagnostic.code))
    .map((diagnostic) => {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return { file: diagnostic.file.fileName, line: line + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') };
    })
    .filter((problem) => !NODE_GLOBALS.test(problem.message));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(fileURLToPath(new URL('..', import.meta.url)));
  const files = execFileSync('git', ['ls-files', '*.js', '*.jsx', '*.mjs', '*.cjs'], { encoding: 'utf8' })
    .split('\n').filter((file) => file && !EXCLUDED.test(file));
  const problems = findUndefinedNames(files);
  for (const problem of problems) console.error('FAIL ' + problem.file + ':' + problem.line + ' ' + problem.message);
  if (problems.length) process.exit(1);
  console.log('Undefined-reference check passed: ' + files.length + ' file(s).');
}
