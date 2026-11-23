import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMarketContext } from './intelligence.js';

test('market context score is explainable and neutral with no evidence', () => {
  const result = scoreMarketContext({});
  assert.equal(result.score, 0);
  assert.equal(result.direction, 'mixed / neutral');
  assert.equal(result.confidence, 'low');
  assert.equal(result.evidence.length, 0);
});

test('market context score records contributions rather than hiding its inputs', () => {
  const result = scoreMarketContext({ priceChangePct: 6, volumeChangePct: 40, netExchangeFlow: -1, stablecoinSupplyChangePct: 2, macroBias: 'risk-on' });
  assert.equal(result.direction, 'bullish bias');
  assert.equal(result.evidence.length, 5);
  assert.ok(result.evidence.every((item) => Number.isFinite(item.contribution)));
  assert.match(result.caveat, /not a probability/);
});

test('market context score bounds extreme inputs', () => {
  const result = scoreMarketContext({ priceChangePct: 10000, volumeChangePct: 10000, stablecoinSupplyChangePct: 10000 });
  assert.ok(result.score <= 4.5);
});


test('market context score includes order book, funding and timeframe evidence', () => {
  const result = scoreMarketContext({ orderBookImbalancePct: 30, fundingRate: 0.0001, timeframeAlignment: 1 });
  assert.equal(result.evidence.length, 3);
  assert.ok(result.evidence.some((item) => item.factor === 'top-of-book depth imbalance' && item.contribution === 1));
  assert.ok(result.evidence.some((item) => item.factor === 'perpetual funding (contrarian)' && item.contribution === -1));
  assert.ok(result.evidence.some((item) => item.factor === 'multi-timeframe alignment' && item.contribution === 0.75));
});
