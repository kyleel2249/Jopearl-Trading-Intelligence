import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, serializeEnv, inspectUpload, isSensitiveKey, redactText, diffVariables, maskSecret } from './env-parser.js';

test('parses plain, export-prefixed, quoted and commented entries', () => {
  const { values, issues } = parseEnv([
    '# comment', '', 'A=1', 'export B=two', 'C="quoted value"', "D='single # not a comment'",
    'E=plain # trailing comment', 'F=', 'G=a=b=c', '  H = spaced  '
  ].join('\n'));
  assert.deepEqual(values, { A: '1', B: 'two', C: 'quoted value', D: 'single # not a comment', E: 'plain', F: '', G: 'a=b=c', H: 'spaced' });
  assert.deepEqual(issues, []);
});

test('handles special characters, escapes, CRLF and a BOM', () => {
  const { values } = parseEnv('\uFEFFURL=postgres://u:p%40ss@h:5432/db?sslmode=require\r\nMSG="line1\\nline2 \\"q\\""\r\nHASH=abc#def\r\n');
  assert.equal(values.URL, 'postgres://u:p%40ss@h:5432/db?sslmode=require');
  assert.equal(values.MSG, 'line1\nline2 "q"');
  assert.equal(values.HASH, 'abc#def'); // # without leading whitespace is part of the value
});

test('supports multiline quoted values such as private keys', () => {
  const { values, entries } = parseEnv('KEY="-----BEGIN-----\nabc\ndef\n-----END-----"\nNEXT=1\n');
  assert.equal(values.KEY, '-----BEGIN-----\nabc\ndef\n-----END-----');
  assert.equal(values.NEXT, '1');
  assert.equal(entries.find((e) => e.key === 'NEXT').line, 5);
});

test('reports duplicates (last wins), invalid names, unterminated quotes and junk lines', () => {
  const result = parseEnv('A=1\nA=2\n1BAD=x\nnot a pair\nB="never closed\nstill B');
  assert.equal(result.values.A, '2');
  assert.deepEqual(result.duplicates, { A: [1, 2] });
  const codes = result.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['invalid-name', 'unparseable', 'unterminated-quote']);
});

test('serialises and round-trips awkward values', () => {
  const original = { PLAIN: 'abc', EMPTY: '', SPACE: ' a b ', QUOTE: 'say "hi"', MULTI: 'a\nb', HASH: 'x #y', SLASH: 'c:\\path' };
  assert.deepEqual(parseEnv(serializeEnv(original)).values, original);
});

test('upload inspection rejects oversized and binary content', () => {
  assert.equal(inspectUpload({ name: 'a.env', size: 10, text: 'A=1' }).ok, true);
  assert.equal(inspectUpload({ name: 'a.env', size: 2 * 1024 * 1024, text: '' }).ok, false);
  assert.equal(inspectUpload({ name: 'a.bin', size: 10, text: 'A\u0000B' }).ok, false);
});

test('classifies and redacts secrets', () => {
  for (const name of ['JPTI_API_TOKEN', 'JPTI_BINANCE_API_SECRET', 'DATABASE_URL', 'JPTI_FRED_API_KEY', 'JPTI_BYBIT_PASSWORD']) assert.equal(isSensitiveKey(name), true, name);
  for (const name of ['JPTI_API_PORT', 'VITE_API_BASE_URL', 'JPTI_FINNHUB_MIN_INTERVAL_MS']) assert.equal(isSensitiveKey(name), false, name);
  assert.equal(maskSecret('abc'), '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022');
  assert.equal(maskSecret(''), '');
  const text = redactText('GET https://x.test/q?apikey=ABC123XYZ&token=zzz failed for hunter2hunter2', ['hunter2hunter2']);
  assert.doesNotMatch(text, /ABC123XYZ|hunter2|zzz/);
});

test('diffVariables reports names only', () => {
  assert.deepEqual(diffVariables({ A: '1', B: '2', C: '3' }, { A: '1', B: 'x', D: '4' }), { added: ['D'], removed: ['C'], changed: ['B'] });
});
