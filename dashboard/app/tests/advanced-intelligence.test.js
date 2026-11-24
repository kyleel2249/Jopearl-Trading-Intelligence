import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMarketRegime, detectSignalCollisions, rankOpportunities } from '../engines/advanced-intelligence.js';

test('opposing signals on the same instrument are flagged as collisions', () => {
  const result = detectSignalCollisions([{ symbol: 'BTC/USDT', direction: 'long', score: 70, timeframe: '15m' }, { symbol: 'BTC/USDT', direction: 'short', score: 65, timeframe: '1h' }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'high');
});

test('regime classification reports insufficient data rather than guessing', () => {
  assert.equal(classifyMarketRegime([]).regime, 'insufficient-sample');
  assert.equal(classifyMarketRegime([{ change20Percent: 2, score: 70 }, { change20Percent: 1, score: 80 }]).regime, 'bullish-trend');
});

test('opportunity ranking discounts stale candidates', () => {
  const now = Date.now();
  const result = rankOpportunities([
    { symbol: 'BTC/USDT', status: 'developing', score: 80, timeframe: '5m', generatedAt: new Date(now - 900000).toISOString() },
    { symbol: 'ETH/USDT', status: 'developing', score: 70, timeframe: '5m', generatedAt: new Date(now).toISOString() }
  ], now);
  assert.equal(result[0].symbol, 'ETH/USDT');
  assert.equal(result.find((item) => item.symbol === 'BTC/USDT').stale, true);
});
