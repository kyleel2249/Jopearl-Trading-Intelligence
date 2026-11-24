import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTimeframe, analyzeTradeRisk, buildTradingDevelopmentAssessment, ema, rsi } from './trading-development-engine.js';

function candles({ trend = 1, count = 100, start = 1, volume = 100 } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const close = start * (1 + trend * i * 0.001);
    return [1700000000000 + i * 900000, close * .999, close * 1.002, close * .998, close, volume + (i % 7)];
  });
}

test('EMA and RSI return finite values for sufficient input', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + i);
  assert.ok(ema(values, 20) > 0);
  assert.equal(rsi(values), 100);
});

test('timeframe analysis excludes the newest in-progress candle', () => {
  const rows = candles();
  const result = analyzeTimeframe(rows, '15m');
  assert.equal(result.status, 'available');
  assert.equal(result.candles, 99);
  assert.equal(result.bias, 'bullish');
  assert.ok(result.ema20 > 0);
});

test('timeframe analysis refuses insufficient or malformed data', () => {
  assert.equal(analyzeTimeframe(candles({ count: 40 }), '1h').status, 'insufficient-data');
  assert.equal(analyzeTimeframe([[1, 1, 0, 2, 1, -1]], '15m').status, 'insufficient-data');
});

test('risk analysis flags leverage, absent stop and anomalous liquidation distance', () => {
  const result = analyzeTradeRisk({ entryPrice: .000815, quantity: 689973, margin: 28.7, leverage: 20, liquidationPrice: .000226, direction: 'long', marketBias: 'bearish' });
  assert.ok(Math.abs(result.notional - 562.328995) < 1e-8);
  assert.ok(Math.abs(result.impliedMargin - 28.11644975) < 1e-8);
  assert.ok(Math.abs(result.liquidationDistancePct - 72.26993865) < .01);
  assert.equal(result.classification, 'high');
  assert.equal(result.warnings.length, 4);
});

test('development assessment refuses to claim a complete setup with missing evidence', () => {
  const result = buildTradingDevelopmentAssessment({ direction: 'long', timeframes: { '15m': analyzeTimeframe(candles(), '15m') }, trade: { entryPrice: .000815, quantity: 689973, margin: 28.7, leverage: 20, direction: 'long', marketBias: 'bearish' } });
  assert.equal(result.status, 'partial-analysis');
  assert.equal(result.process.status, 'incomplete');
  assert.equal(result.decision.status, 'caution');
  assert.ok(result.process.missing.length >= 3);
});

test('reflective report preserves the opening statement and labels evidence limits', async () => {
  const { buildReflectiveReport } = await import('./trading-development-engine.js');
  const report = buildReflectiveReport({ symbol: 'SOPH/USDT', openingNarrative: 'Today I have decided to start anew in my trading journey.', entryPrice: 0.000815, quantity: 689973, researchSnapshot: { projectFundamentals: { finding: 'Chain transition announced.' }, projectSource: { source: 'Official', url: 'https://sophon.com' } } }, null);
  assert.match(report, /Today I have decided to start anew/);
  assert.match(report, /SOPH\/USDT/);
  assert.match(report, /not a calibrated probability/);
});
