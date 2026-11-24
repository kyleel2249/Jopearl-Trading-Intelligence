import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCT_OPTIONS, coerceProductForExchange, productSupport } from '../src/product-support.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Bitget product types are selectable across the shared chart and terminal', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  const terminal = read('../src/TerminalDashboard.jsx');
  const alpha = read('../src/AlphaSignalEngine.jsx');
  assert.deepEqual(PRODUCT_OPTIONS.map((item) => item.value), ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd']);
  for (const [name, source] of [['shared chart', chart], ['terminal', terminal], ['alpha engine', alpha]]) {
    assert.match(source, /PRODUCT_OPTIONS/, name + ' must render the shared product list');
    assert.match(source, /selectProduct/, name + ' must route product changes through selectProduct');
  }
  // Products are never greyed out just because the venue is not Bitget: choosing one moves to the venue that serves it.
  assert.doesNotMatch(chart, /disabled=\{directMode && exchange !== 'bitget'\}/);
  assert.doesNotMatch(terminal, /disabled=\{exchange !== 'bitget'\}/);
  assert.doesNotMatch(alpha, /disabled=\{exchange!=='bitget'\}/);
  for (const mode of ['api', 'direct', 'cloudflare-edge']) {
    const table = productSupport({ exchange: 'binance', mode });
    for (const product of ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures']) assert.equal(table[product].available, true, mode + ' ' + product);
  }
});

test('Bitget futures selection is not reset to Spot when browser-direct mode activates', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  // Only a venue that cannot serve the product falls back to Spot, and visibly (coerceProductForExchange); Bitget keeps it.
  assert.match(chart, /coerceProductForExchange\(\{ exchange, marketType, mode: apiMode, cfdReady: cloudflareMode \}\)/);
  assert.doesNotMatch(chart, /setMarketType\(\(current\) => mode === 'direct' && exchange !== 'bitget'/);
  assert.doesNotMatch(chart, /if \(mode === 'direct'\) setMarketType\('spot'\)/);
  assert.doesNotMatch(chart, /if \(directMode\) setMarketType\('spot'\)/);
  for (const mode of ['direct', 'cloudflare-edge', 'api']) {
    for (const product of ['margin', 'futures', 'coin-futures', 'usdc-futures']) {
      assert.deepEqual(coerceProductForExchange({ exchange: 'bitget', marketType: product, mode }), { marketType: product, notice: '' }, mode + ' ' + product);
    }
  }
});

test('product select is not bounced back to Spot by the parent-prop sync', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  // Root cause of the Futures-reverts-to-Spot glitch: the prop sync listed the local value as a dependency and fought the select.
  assert.match(chart, /appliedInitialMarketType/);
  assert.doesNotMatch(chart, /\[initialMarketType, marketType\]/);
  assert.match(chart, /\}, \[initialMarketType\]\);/);
});

test('exact Bitget instrument IDs and CFD side selection reach every candle consumer', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  const terminal = read('../src/TerminalDashboard.jsx');
  const imi = read('../src/InstitutionalMarketIntelligence.jsx');
  const forecast = read('../src/RangeForecastEngine.jsx');
  assert.match(chart, /marketInstrumentQuery/);
  assert.match(chart, /marketSideQuery/);
  assert.match(chart, /instrumentId={marketInstrumentId}/);
  assert.match(terminal, /instrumentQuery/);
  assert.match(terminal, /sideQuery/);
  assert.match(imi, /marketCatalog\.find/);
  assert.match(imi, /onMarketSideChange/);
  assert.match(forecast, /instrumentId/);
  assert.match(forecast, /marketSide/);
});

test('CFD trade flow does not invent CVD or taker pressure from unavailable data', () => {
  const flow = read('../src/LiveOrderFlowPanel.jsx');
  assert.match(flow, /marketType === 'cfd'/);
  assert.match(flow, /instrumentId = ''/);
  assert.match(flow, /instId: String\(instrumentId \|\| pair\(symbol\)\)/);
  assert.match(flow, /CVD and taker pressure are intentionally unavailable/);
});

test('Cloudflare Pages has a dedicated signed Bitget CFD market route', () => {
  const pages = read('../functions/api/[[path]].js');
  const provider = read('../functions/bitget-cfd.js');
  assert.match(pages, /createBitgetCfdProvider/);
  assert.match(pages, /requestedType === 'cfd'/);
  assert.match(pages, /cfd\/diagnostics/);
  assert.match(provider, /ACCESS-SIGN/);
  assert.match(provider, /history-candlestick/);
  assert.match(provider, /volumeAvailable: false/);
});


test('Spot and Futures workspaces initialize the multi-chart terminal with the correct market mode', () => {
  const app = read('../src/App.jsx');
  const workstation = read('../src/MultiChartWorkstation.jsx');
  assert.match(app, /<MultiChartWorkstation mode=\{page === 'Futures' \? 'futures' : 'spot'\}/);
  assert.match(workstation, /mode === 'futures' \? 'futures' : 'spot'/);
  assert.match(workstation, /index === 0 && mode === 'spot' \? 'binance' : 'bitget'/);
  assert.match(workstation, /initialMarketType=\{tile\.marketType\}/);
});

test('API-source listener refreshes its exchange capture when the selected exchange changes', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  assert.doesNotMatch(chart, /setMarketType\(\(current\) => mode === 'direct' && exchange !== 'bitget'/, 'the source listener must not force Spot on its own');
  assert.match(chart, /return subscribeApiSource\(syncSource\);\n  \}, \[exchange\]\);/);
});
