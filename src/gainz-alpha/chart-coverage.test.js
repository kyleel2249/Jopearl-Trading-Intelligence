import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Coverage guard: every component that draws candlesticks (an <svg> with candle body <rect> elements built from
// OHLC rows) must subscribe to the shared GainzAlpha hook and mount the shared overlay layer.
const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d) => readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? (n === 'gainz-alpha' ? [] : walk(f)) : f.endsWith('.jsx') ? [f] : []; });
const drawsCandles = (src) => /<svg[\s>]/.test(src) && /<rect[\s>]/.test(src) && /c\[4\]\s*>=\s*c\[1\]|c\[1\]\s*,\s*c\[4\]|Math\.min\(c\[1\],\s*c\[4\]\)|Math\.max\(c\[1\],\s*c\[4\]\)/.test(src);

test('every candlestick chart component uses the shared GainzAlpha hook and overlay layer', () => {
  const charts = walk(root).filter((f) => drawsCandles(readFileSync(f, 'utf8')));
  assert.ok(charts.length >= 2, 'expected to detect the known candlestick components, found ' + charts.map((f) => relative(root, f)).join(', '));
  const missing = [];
  for (const f of charts) {
    const src = readFileSync(f, 'utf8');
    if (!/useGainzAlpha\s*\(/.test(src) || !/<GainzAlphaOverlays\b/.test(src)) missing.push(relative(root, f));
  }
  assert.deepEqual(missing, [], 'Candlestick components missing GainzAlpha integration: ' + missing.join(', '));
});

test('known chart components are detected by the guard', () => {
  const names = walk(root).filter((f) => drawsCandles(readFileSync(f, 'utf8'))).map((f) => relative(root, f).replaceAll('\\', '/'));
  assert.ok(names.includes('LiveCandlestickChart.jsx')); assert.ok(names.includes('TerminalChart.jsx'));
});

test('live chart price axis consumes provider instrument precision metadata', () => {
  const chart = readFileSync(join(root, 'LiveCandlestickChart.jsx'), 'utf8');
  assert.match(chart, /chart-intelligence\/precision\.js/);
  assert.match(chart, /setMarketPrecisionMetadata/);
  assert.match(chart, /marketPrecisionMetadata\[symbol\]/);
  // The pip axis is built from the provider's pip/tick metadata (chart-live.js), and axis tags use the instrument formatter.
  assert.match(chart, /resolvePipSize\(\{ symbol, price: liveClose, precision: resolvePrecision\(precisionMeta\) \}\)/);
  assert.match(chart, /buildScaleAxis\(\{ mode: scale\.mode, lo: range\.lo, hi: range\.hi, top, bottom, pip: pipInfo\.pip/);
  assert.match(chart, /formatInstrumentPrice\(lastRow\[4\], precisionMeta/);
});
