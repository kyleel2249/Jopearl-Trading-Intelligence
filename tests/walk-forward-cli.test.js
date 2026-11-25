import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArguments, runCli } from '../scripts/walk-forward.mjs';

const script = fileURLToPath(new URL('../scripts/walk-forward.mjs', import.meta.url));
const base = Date.UTC(2026, 0, 1);
function candles(n, seed = 7) {
  let s = seed, p = 100; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647, rows = [];
  for (let i = 0; i < n; i++) { const o = p, cl = Math.max(1, o + (rnd() - 0.5) * 1.4 + Math.sin(i / 17) * 0.15); rows.push([base + i * 3600e3, o, Math.max(o, cl) + rnd() * 0.5, Math.min(o, cl) - rnd() * 0.5, cl, 100 + rnd() * 50]); p = cl; }
  return rows;
}
const FAST = ['--symbol', 'SYN', '--train', '200', '--test', '100', '--window', '150', '--min-train-trades', '5', '--grid', 'balanced,alpha'];

test('argument parsing maps flags to options and rejects bad input', () => {
  const parsed = parseArguments(['data.json', '--symbol', 'ETH/USDT', '--timeframe', '4h', '--train', '300', '--fee', '0.001', '--grid', 'alpha, swing', '--risk', '0.5', '--runs', '500', '--trades']);
  assert.equal(parsed.file, 'data.json');
  assert.equal(parsed.includeTrades, true);
  assert.deepEqual(parsed.options.grid, [{ id: 'alpha', preset: 'alpha' }, { id: 'swing', preset: 'swing' }]);
  assert.equal(parsed.options.trainBars, 300);
  assert.equal(parsed.options.feePct, 0.001);
  assert.deepEqual(parsed.options.monteCarlo, { riskPerTradePct: 0.5, runs: 500 });
  assert.throws(() => parseArguments([]), /candle file is required/);
  assert.throws(() => parseArguments(['a.json', 'b.json']), /Unexpected argument/);
  assert.throws(() => parseArguments(['a.json', '--train']), /Missing value/);
  assert.throws(() => parseArguments(['a.json', '--train', 'lots']), /needs a number/);
  assert.throws(() => parseArguments(['a.json', '--bogus', '1']), /Unknown option/);
});

test('runCli reports unreadable files and malformed candle data with exit code 1', () => {
  assert.equal(runCli(['missing.json'], { read: () => { throw new Error('ENOENT'); } }).code, 1);
  assert.equal(runCli(['x.json'], { read: () => 'not json' }).code, 1);
  assert.match(runCli(['x.json'], { read: () => '{"a":1}' }).error, /JSON array/);
  assert.match(runCli(['x.json'], { read: () => '[[1,2]]' }).error, /JSON array/);
  assert.equal(runCli(['x.json', '--timeframe', 'bogus'], { read: () => JSON.stringify(candles(500)) }).code, 1);
});

test('runCli returns exit code 2 when there is not enough history', () => {
  const result = runCli(['x.json', ...FAST], { read: () => JSON.stringify(candles(100)) });
  assert.equal(result.code, 2);
  assert.equal(result.report.status, 'insufficient');
});

test('the command line tool prints a JSON report, summarising trades unless asked for them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jpti-wf-'));
  try {
    const file = join(dir, 'candles.json');
    writeFileSync(file, JSON.stringify(candles(800)));
    const brief = spawnSync(process.execPath, [script, file, ...FAST], { encoding: 'utf8' });
    assert.equal(brief.status, 0, brief.stderr);
    const report = JSON.parse(brief.stdout);
    assert.equal(report.status, 'ok');
    assert.equal(report.windows.length, 5);
    assert.match(report.oos.trades, /trades \(use --trades/);
    const full = JSON.parse(spawnSync(process.execPath, [script, file, ...FAST, '--trades'], { encoding: 'utf8' }).stdout);
    assert.ok(Array.isArray(full.oos.trades));
    assert.equal(full.oos.summary.n, full.oos.trades.length);
    const bad = spawnSync(process.execPath, [script, file, '--train', 'x'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Usage:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
