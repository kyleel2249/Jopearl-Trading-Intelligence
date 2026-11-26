import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateSma, confirmWilliamsFractal, evaluateMa44332Strategy,
  evaluateFirstWilliamsFractalBreakout, evaluateVideoStrategyRisk, qualifyVideoStrategy
} from './video-derived-strategies.js';

test('SMA returns null until a complete window exists', () => {
  assert.deepEqual(calculateSma([1, 2, 3, 4], 3), [null, null, 2, 3]);
});

test('MA44/332 engine abstains on insufficient bars and requires closed candles', () => {
  const result = evaluateMa44332Strategy({ bars: [], previousDayHigh: 110, previousDayLow: 90, allBarsClosed: true });
  assert.equal(result.status, 'abstain');
  assert.ok(result.reasons.includes('bars-invalid-or-not-strictly-ordered'));
});

test('MA44/332 produces a signal only on a newly confirmed crossover', () => {
  const bars = Array.from({ length: 333 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 300000).toISOString(),
    high: i === 332 ? 200 : 101, low: i === 332 ? 199 : 99, close: i === 332 ? 200 : 100
  }));
  const result = evaluateMa44332Strategy({ bars, previousDayHigh: 210, previousDayLow: 90, allBarsClosed: true });
  assert.equal(result.status, 'signal');
  assert.equal(result.signal.direction, 'long');
  assert.equal(result.signal.stopLoss, 90);
  assert.equal(result.signal.trigger, 'closed-candle-sma-crossover');
});

test('Williams fractal waits for two right-hand candles', () => {
  const bars = [
    { high: 2, low: 1 }, { high: 3, low: 1 }, { high: 8, low: 2 },
    { high: 4, low: 1 }, { high: 3, low: 1 }
  ];
  assert.deepEqual(confirmWilliamsFractal(bars, 2), {
    up: true, down: false, confirmed: true, centerIndex: 2, confirmationIndex: 4, levelUp: 8, levelDown: null
  });
  assert.equal(confirmWilliamsFractal(bars.slice(0, 4), 2).confirmed, false);
});

test('fractal engine waits for confirmation and triggers a later close breakout', () => {
  const start = Date.parse('2026-11-02T08:00:00Z'); // 03:00 New York, after DST ends
  const values = [
    [2, 1, 1.5], [3, 1, 2], [8, 2, 7], [4, 1, 3], [3, 1, 2],
    [9, 8, 9]
  ];
  const bars = values.map(([high, low, close], i) => ({
    timestamp: new Date(start + i * 300000).toISOString(), high, low, close
  }));
  const result = evaluateFirstWilliamsFractalBreakout({
    bars, dailyAtr: 4, dailyAtrSource: 'completed-daily-candle', allBarsClosed: true
  });
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].direction, 'long');
  assert.equal(result.signals[0].entry, 9);
  assert.equal(result.signals[0].stopLoss, 8);
  assert.equal(result.signals[0].takeProfit, 15);
});

test('fractal engine rejects incomplete daily ATR provenance', () => {
  const result = evaluateFirstWilliamsFractalBreakout({ bars: [], dailyAtr: 10, allBarsClosed: true });
  assert.ok(result.reasons.includes('daily-atr-must-use-completed-daily-candle'));
});

test('risk governor fails closed and sizes only paper-qualified trades', () => {
  const blocked = evaluateVideoStrategyRisk({ equityUsd: 1000, riskPct: 1, drawdownPct: 0, dailyLossLimitPassed: true, eventRiskCleared: true, executionCostsIncluded: true, strategyQualified: true, paperMode: true, stopDistancePct: 1 });
  assert.equal(blocked.allowedForPaper, false);
  const allowed = evaluateVideoStrategyRisk({ equityUsd: 1000, riskPct: 0.25, drawdownPct: 0, dailyLossLimitPassed: true, eventRiskCleared: true, executionCostsIncluded: true, strategyQualified: true, paperMode: true, stopDistancePct: 2 });
  assert.equal(allowed.allowedForPaper, true);
  assert.equal(allowed.riskUsd, 2.5);
  assert.equal(allowed.notionalCapUsd, 125);
  assert.equal(allowed.liveExecutionAuthorized, false);
});

test('strategy qualification requires full cost and robustness evidence', () => {
  const result = qualifyVideoStrategy({});
  assert.equal(result.qualified, false);
  assert.ok(result.reasons.includes('spreadIncluded-not-verified'));
  assert.equal(qualifyVideoStrategy({
    outOfSampleTrades: 150, netExpectancyR: 0.2, profitFactor: 1.4, maxDrawdownPct: 5,
    spreadIncluded: true, commissionIncluded: true, slippageIncluded: true, swapIncluded: true,
    walkForwardPassed: true, paperForwardPassed: true, dataIntegrity: 'verified',
    randomBaselineCompared: true, parameterSensitivityPassed: true
  }).qualified, true);
});

test('risk governor allocates zero notional when the stop distance is invalid', () => {
  const result = evaluateVideoStrategyRisk({
    equityUsd: 1000, riskPct: 0.25, drawdownPct: 0,
    dailyLossLimitPassed: true, eventRiskCleared: true,
    executionCostsIncluded: true, strategyQualified: true,
    paperMode: true, stopDistancePct: 0
  });
  assert.equal(result.allowedForPaper, false);
  assert.equal(result.riskUsd, 0);
  assert.equal(result.notionalCapUsd, 0);
  assert.ok(result.violations.includes('stop-distance-invalid'));
});
