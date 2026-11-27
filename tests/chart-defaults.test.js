import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHART_EXCHANGE, DEFAULT_CHART_SYMBOL, resolveSavedChartMarket } from '../src/chart-defaults.js';

test('new chart sessions default to Bitget BTC/USDT', () => {
  assert.deepEqual(resolveSavedChartMarket(null, null), {
    exchange: DEFAULT_CHART_EXCHANGE,
    symbol: DEFAULT_CHART_SYMBOL,
    migrated: true
  });
});

test('migrates the old invalid Binance EUR/USDT starter market', () => {
  assert.deepEqual(resolveSavedChartMarket('binance', 'EUR/USDT'), {
    exchange: 'bitget',
    symbol: 'BTC/USDT',
    migrated: true
  });
});

test('preserves explicit saved market selections', () => {
  assert.deepEqual(resolveSavedChartMarket('okx', 'ETH/USDT'), {
    exchange: 'okx',
    symbol: 'ETH/USDT',
    migrated: false
  });
  assert.deepEqual(resolveSavedChartMarket('binance', 'BTC/USDT'), {
    exchange: 'binance',
    symbol: 'BTC/USDT',
    migrated: false
  });
});
