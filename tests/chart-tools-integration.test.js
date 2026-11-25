import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const CHARTS = [['LiveCandlestickChart', '../src/LiveCandlestickChart.jsx'], ['TerminalChart', '../src/TerminalChart.jsx']];

// Source-level contract: every candle chart in the app (the dashboards all render one of these two) must wire the same
// shared tool set. Runtime behaviour of the rules is covered by the pure-module tests next to each src/chart-*.js file.
test('both live charts use the shared tools hook, toolbar and SVG overlay', () => {
  for (const [name, file] of CHARTS) {
    const source = read(file);
    assert.match(source, /useChartTools\(/, name + ' must call useChartTools');
    assert.match(source, /<ChartToolsBar /, name + ' must render the toolbar');
    assert.match(source, /<ChartToolsSvg /, name + ' must render the overlay inside the SVG');
    assert.match(source, /pointFromEvent\(/, name + ' must map pointer events through pointFromEvent');
    assert.match(source, /tools\.handlePointer\('click'/, name + ' must route clicks to the active tool');
    assert.match(source, /tools\.broadcastCrosshair\(/, name + ' must publish the linked crosshair');
  }
});

test('both charts honour scale mode, range lock, replay and the live stream price', () => {
  for (const [name, file] of CHARTS) {
    const source = read(file);
    assert.match(source, /makeScale\(\{ mode: tools\.prefs\.scaleMode/, name + ' price scale mode');
    assert.match(source, /buildScaleAxis\(/, name + ' scale-aware axis');
    assert.match(source, /resolveRange\(/, name + ' range lock');
    assert.match(source, /tools\.lockedRange/, name + ' locked range dependency');
    assert.match(source, /tools\.replaying/, name + ' replay mode');
    assert.match(source, /tools\.applyReplay\(/, name + ' replay slicing');
    assert.match(source, /tools\.streamFresh/, name + ' stream price');
    assert.match(source, /priceAt/, name + ' inverse price mapping for the crosshair/tools');
    assert.doesNotMatch(source, /buildPriceAxis\(/, name + ' must not bypass the scale-aware axis');
  }
});

test('the old non-persistent drawing mode was replaced, not dropped: S/R lines and trend lines live in the shared tools', () => {
  const live = read('../src/LiveCandlestickChart.jsx');
  assert.doesNotMatch(live, /setDrawMode|drawMode/);
  assert.match(live, /tools\.clearAll/, 'Clear drawings still present');
  const tools = read('../src/ChartTools.jsx');
  assert.match(tools, /\['hline'/);
  assert.match(tools, /\['trend'/);
  assert.match(tools, /\['fib'/);
  assert.match(tools, /\['measure'/);
  assert.match(tools, /\['long'/);
  assert.match(tools, /\['short'/);
  assert.match(tools, /\['alert'/);
});

test('the toolbar exposes every shared capability and says plainly when a data source is unavailable', () => {
  const ui = read('../src/ChartTools.jsx');
  for (const label of ['Profile', 'Depth', 'Link', 'Replay', 'Lock range', 'Alerts']) assert.match(ui, new RegExp(label), label);
  assert.match(ui, /not provided by venue/, 'liquidations are never implied when the venue gives none');
  const hook = read('../src/useChartTools.js');
  assert.match(hook, /Order-book depth needs the full JPTI API/);
  assert.match(hook, /Funding and open interest need the full JPTI API/);
});

test('API: order-book route returns the ladder the chart draws; derivatives route asks for liquidations when the venue can', () => {
  const api = read('../api/advanced-intelligence.js');
  assert.match(api, /bids: ladder\('bids'\), asks: ladder\('asks'\)/);
  assert.match(api, /ex\.has\?\.fetchLiquidations/);
});
