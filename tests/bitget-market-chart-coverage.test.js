import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Bitget product types are selectable across the shared chart and terminal', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  const terminal = read('../src/TerminalDashboard.jsx');
  for (const product of ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd']) {
    assert.match(chart, new RegExp('value="' + product + '"'), 'shared chart missing ' + product);
    assert.match(terminal, new RegExp('value="' + product + '"'), 'terminal missing ' + product);
  }
});

test('Bitget futures selection is not reset to Spot when browser-direct mode activates', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  assert.match(chart, /setMarketType\(\(current\) => mode === 'direct' && exchange !== 'bitget' \? 'spot' : current\)/);
  assert.match(chart, /if \(\(directMode && exchange !== 'bitget' && marketType !== 'spot'\) \|\| \(exchange !== 'bitget' && marketType === 'cfd'\)\) setMarketType\('spot'\)/);
  assert.doesNotMatch(chart, /if \(mode === 'direct'\) setMarketType\('spot'\)/);
  assert.doesNotMatch(chart, /if \(directMode\) setMarketType\('spot'\)/);
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


test('Futures workspace initializes the shared chart with Futures instead of Spot', () => {
  const app = read('../src/App.jsx');
  const connectivity = read('../src/ExchangeConnectivity.jsx');
  assert.match(app, /initialExchange=\{page === 'Futures' \? 'bitget' : 'binance'\}/);
  assert.match(app, /initialMarketType=\{page === 'Futures' \? 'futures' : 'spot'\}/);
  assert.match(connectivity, /initialExchange = 'binance'/);
  assert.match(connectivity, /initialMarketType = 'spot'/);
  assert.match(connectivity, /useState\(initialExchange \|\| 'binance'\)/);
  assert.match(connectivity, /useState\(initialMarketType \|\| 'spot'\)/);
});

test('API-source listener refreshes its exchange capture when the selected exchange changes', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  assert.match(chart, /setMarketType\(\(current\) => mode === 'direct' && exchange !== 'bitget' \? 'spot' : current\)/);
  assert.match(chart, /return subscribeApiSource\(syncSource\);\n  \}, \[exchange\]\);/);
});
