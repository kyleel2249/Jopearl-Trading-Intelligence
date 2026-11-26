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
