import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { analyzeChartIntelligence, createMemoryLedger } from './engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const H = 3600e3;
function walk(n, seed) { let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; const rows = []; let p = 100; for (let i = 0; i < n; i++) { const o = p, c = Math.max(1, o + (rnd() - 0.5) * 2), h = Math.max(o, c) + rnd() * 0.6, l = Math.min(o, c) - rnd() * 0.6; rows.push([Date.UTC(2026, 0, 1) + i * H, o, h, l, c, 80 + rnd() * 120]); p = c; } return rows; }

async function loadComponents() {
  const { build } = require('esbuild');
  const cacheDir = path.join(here, '..', '..', 'node_modules', '.cache'); fs.mkdirSync(cacheDir, { recursive: true }); const out = fs.mkdtempSync(path.join(cacheDir, 'jpti-ci-'));
  const result = {};
  for (const name of ['ChartIntelligenceOverlays', 'ChartIntelligenceLegend']) {
    const file = path.join(out, name + '.mjs');
    await build({ entryPoints: [path.join(here, name + '.jsx')], outfile: file, bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' }, logLevel: 'silent' });
    result[name] = (await import(pathToFileURL(file).href)).default;
  }
  return result;
}
function geometryFor(rows, ci) {
  const count = Math.min(rows.length, 120), vis = rows.slice(-count), prices = [...vis.flatMap((c) => [c[2], c[3]]), ...(ci.plan ? [ci.plan.entry, ci.plan.stopLoss, ...ci.plan.targets.filter((t) => Math.abs(t.price - ci.plan.entry) <= ci.atr * 8).slice(0, 3).map((t) => t.price)] : [])];
  const lo = Math.min(...prices), hi = Math.max(...prices), pad = (hi - lo) * 0.09, min = lo - pad, max = hi + pad, left = 12, right = 920, top = 18, priceBottom = 280;
  return { rows: vis, count, min, max, left, right, top, priceBottom, volumeBottom: 378, x: (i) => left + (i + 0.5) * ((right - left) / count), y: (p) => top + ((max - p) / (max - min)) * (priceBottom - top) };
}

test('overlay and legend components render real engine output without NaN, with plan, labels and tooltips', async () => {
  const React = require('react'), { renderToStaticMarkup } = require('react-dom/server'), { ChartIntelligenceOverlays, ChartIntelligenceLegend } = (({ ChartIntelligenceOverlays, ChartIntelligenceLegend }) => ({ ChartIntelligenceOverlays, ChartIntelligenceLegend }))(await loadComponents());
  let found = 0;
  for (const seed of [31, 77, 123, 5]) {
    const rows = walk(420, seed), ci = analyzeChartIntelligence(rows, { exchange: 'x', symbol: 'BTC/USDT', timeframe: '1h', now: rows[419][0] + H + 1000, ledger: createMemoryLedger() });
    const settings = { enabled: true, density: 'auto', alerts: { notify: false }, historyBars: 60, layers: { signals: true, plan: true, liquidation: true, profile: true, sr: true, orderflow: true, structure: true, orderBlocks: true, fvg: true, liquidity: true, sweeps: true, smc: true, vwap: true } };
    const g = geometryFor(rows, ci);
    for (const compact of [false, true]) {
      const svg = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ChartIntelligenceOverlays, { ci, settings, geometry: g, compact })));
      assert.ok(svg.includes('data-ci-overlays="ready"'));
      assert.ok(!/NaN|undefined|Infinity/.test(svg), 'bad numeric/text in SVG: ' + (svg.match(/.{20}(NaN|undefined|Infinity).{20}/) || [''])[0]);
      assert.ok(svg.includes('<title>'), 'tooltips present');
      if (ci.plan) { found++; assert.equal((svg.match(/<text[^>]*>ENTRY /g) || []).length, 1, 'exactly one ENTRY label'); assert.equal((svg.match(/<line[^>]*stroke="#dbe7f5"[^>]*stroke-width="1.4"/g) || []).length, 1, 'exactly one ENTRY line'); assert.ok(/<text[^>]*>SL /.test(svg)); assert.ok(/<text[^>]*>TP1 /.test(svg)); }
    }
    const off = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ChartIntelligenceOverlays, { ci, settings: { ...settings, layers: Object.fromEntries(Object.keys(settings.layers).map((k) => [k, false])) }, geometry: g })));
    assert.ok(!off.includes('<title>'), 'all layers off draws nothing');
    const hook = { settings, update() {}, reset() {}, alerts: [], clearAlerts() {}, requestNotifications() {} };
    const legend = renderToStaticMarkup(React.createElement(ChartIntelligenceLegend, { ci, hook }));
    assert.ok(legend.includes('data-ci-legend="ready"') && legend.includes('Regime') && legend.includes('aria-pressed'));
    assert.ok(!/NaN|undefined/.test(legend));
  }
  assert.ok(found >= 1, 'at least one series produced a live plan to render');
  const empty = renderToStaticMarkup(React.createElement('svg', null, React.createElement(ChartIntelligenceOverlays, { ci: { status: 'insufficient' }, settings: { enabled: true, layers: {} }, geometry: null })));
  assert.ok(empty.includes('data-ci-overlays="empty"'));
});
