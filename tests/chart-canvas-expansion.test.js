import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getExpandedCanvasWidth } from '../src/chart-canvas.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('expanded canvas preserves candle spacing as visible history grows', () => {
  assert.equal(getExpandedCanvasWidth(1000, 96, 96), 1000);
  assert.equal(getExpandedCanvasWidth(1000, 192, 96), 2000);
  assert.equal(getExpandedCanvasWidth(1000, 480, 96), 5000);
  assert.equal(getExpandedCanvasWidth(1000, 48, 96), 1000);
});

test('expanded canvas handles invalid dimensions and candle counts safely', () => {
  assert.equal(getExpandedCanvasWidth(0, 10, 0), 10);
  assert.equal(getExpandedCanvasWidth(Number.NaN, -5, 20), 1);
  assert.equal(getExpandedCanvasWidth(800, 0, 10), 800);
});

test('shared live chart expands its SVG and scrolls the viewport on zoom changes', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  const styles = read('../src/styles.css');
  assert.match(chart, /getExpandedCanvasWidth\(plotSize\.w, count, baseCount\)/);
  assert.match(chart, /width=\{geometry\.width\}/);
  assert.match(chart, /wrapEl\.scrollLeft = wrapEl\.scrollWidth/);
  assert.match(chart, /wrapEl\.scrollLeft \+?\s*\w*\.scrollLeft/);
  assert.match(styles, /candlestick-svg-wrap\{overflow-x:auto/);
  assert.match(styles, /width:auto!important;max-width:none;height:100%/);
});

test('terminal dashboard expands its SVG and exposes horizontal range controls', () => {
  const chart = read('../src/TerminalChart.jsx');
  const styles = read('../src/TerminalDashboard.css');
  assert.match(chart, /getExpandedCanvasWidth\(size\.w, rows\.length, baseVisible\)/);
  assert.match(chart, /width=\{geo\.width\}/);
  assert.match(chart, /setCount\(Math\.min\(96, valid\.length\)\)/);
  assert.match(chart, /Scroll horizontally for history/);
  assert.match(styles, /\.tc-wrap\{position:absolute;inset:0;overflow-x:auto/);
  assert.match(styles, /\.tc-wrap svg\{display:block;width:auto!important/);
});
