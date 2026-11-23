import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateForecast, analyzeOrderBook, buildEvidenceCouncil, backtestEmaStrategy, monteCarloReturns } from './advanced-intelligence.js';

const candles = Array.from({ length: 180 }, (_, i) => {
  const close = 100 + i * 0.12 + Math.sin(i / 5) * 1.8;
  return [1700000000000 + i * 3600000, close - .2, close + 1, close - 1, close, 1000 + i * 2];
});

test('forecast produces ordered high/low scenarios from closed OHLCV history', () => {
  const result = calculateForecast(candles);
  assert.equal(result.forecasts.length, 4);
  for (const f of result.forecasts) {
    assert.ok(f.forecastHigh > f.referencePrice);
    assert.ok(f.forecastLow < f.referencePrice);
    assert.ok(f.forecastHigh > f.forecastLow);
  }
  assert.throws(() => calculateForecast(candles.slice(0, 20)), /30/);
  assert.equal(calculateForecast(candles, [24], 15).forecasts[0].horizonBars, 96);
  assert.equal(calculateForecast(candles, [24], 240).forecasts[0].horizonBars, 6);
});

test('order book reports depth imbalance and avoids claiming spoofing', () => {
  const result = analyzeOrderBook({ bids: [[100, 10], [99, 1]], asks: [[101, 2], [102, 1]] });
  assert.ok(result.depthImbalance > 0);
  assert.match(result.spoofingAssessment, /NOT_DETERMINED/);
});

test('evidence council preserves disagreement and low-confidence states', () => {
  const result = buildEvidenceCouncil({ priceChangePct: 2, depthImbalance: -0.4, volumeChangePct: 30 });
  assert.equal(result.consensus, 'no-directional-consensus');
  assert.ok(result.dissent);
  assert.equal(result.confidence, 'low');
});

test('EMA backtest and seeded Monte Carlo are deterministic', () => {
  const result = backtestEmaStrategy(candles);
  assert.ok(Number.isFinite(result.returnPercent));
  const a = monteCarloReturns([-.01, .01, .02], 100, 20, 42);
  const b = monteCarloReturns([-.01, .01, .02], 100, 20, 42);
  assert.deepEqual(a.finalEquityQuantiles, b.finalEquityQuantiles);
});
