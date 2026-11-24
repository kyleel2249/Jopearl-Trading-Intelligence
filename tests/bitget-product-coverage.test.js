import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCT_OPTIONS, productSupport } from '../src/product-support.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const PRODUCTS = ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd'];

test('every chart workspace exposes the full Bitget product set', () => {
  for (const file of ['../src/LiveCandlestickChart.jsx', '../src/TerminalDashboard.jsx', '../src/CalendarSessions.jsx']) {
    const source = read(file);
    // Chart and terminal render the shared PRODUCT_OPTIONS list; Calendar & Sessions keeps literal options.
    if (/PRODUCT_OPTIONS/.test(source)) continue;
    for (const product of PRODUCTS) assert.match(source, new RegExp('value="' + product + '"'), file + ' is missing the ' + product + ' product');
  }
});

test('the shared product list carries the full Bitget product set', () => {
  assert.deepEqual(PRODUCT_OPTIONS.map((item) => item.value), PRODUCTS);
  for (const file of ['../src/LiveCandlestickChart.jsx', '../src/TerminalDashboard.jsx']) assert.match(read(file), /PRODUCT_OPTIONS/, file);
});

test('Calendar & Sessions requests candles for the selected Bitget product, with the CFD side', () => {
  const calendar = read('../src/CalendarSessions.jsx');
  assert.match(calendar, /&type=' \+ encodeURIComponent\(marketType\)/);
  assert.match(calendar, /marketType === 'cfd' \? '&side='/);
  assert.match(calendar, /BTC\/USDT:USDT/, 'contract symbols (BASE/QUOTE:SETTLE) must be accepted');
  assert.match(calendar, /CFD_PATTERN/, 'slash-less CFD instruments must be accepted');
});

test('the exchange selector never hides the active venue when the gateway is offline', () => {
  const connectivity = read('../src/ExchangeConnectivity.jsx');
  assert.match(connectivity, /FALLBACK_EXCHANGES = \[[^\]]*'bitget'/);
  assert.match(connectivity, /exchangeOptions\.map/);
});

test('the chart keeps CFD to Bitget and syncs the product one way', () => {
  const chart = read('../src/LiveCandlestickChart.jsx');
  // CFD is only served by Bitget: coerceProductForExchange drops it elsewhere and productSupport routes it to Bitget.
  assert.match(chart, /coerceProductForExchange\(\{ exchange, marketType/);
  assert.equal(productSupport({ exchange: 'binance', mode: 'cloudflare-edge', cfdReady: true }).cfd.switchTo, 'bitget');
  assert.match(chart, /appliedInitialMarketType/);
  assert.doesNotMatch(chart, /\}, \[initialMarketType, marketType\]\);/, 'the prop must not be re-applied on every local product change');
});
