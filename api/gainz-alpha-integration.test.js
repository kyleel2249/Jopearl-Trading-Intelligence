import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlphaSignal, ALPHA_ENGINE_VERSION } from './alpha-signal-engine.js';

const tf = 3600000, start = 1700000000000;
function setupCandles() {
  const rows = []; let p = 100;
  for (let i = 0; i < 90; i++) { const o = p, c = 100 + Math.sin(i / 3) * 0.6; rows.push({ timestamp: start + i * tf, open: o, high: Math.max(o, c) + 0.25, low: Math.min(o, c) - 0.25, close: c, volume: 1000 + (i % 4) * 50 }); p = c; }
  const hi = Math.max(...rows.slice(-25).map((r) => r.high)), prev = rows.at(-1).close;
  rows.push({ timestamp: start + 90 * tf, open: prev, high: hi + 0.5, low: prev - 0.1, close: hi - 0.3, volume: 2500 });
  rows.push({ timestamp: start + 91 * tf, open: hi - 0.3, high: hi - 0.25, low: hi - 2.4, close: hi - 2.3, volume: 3500 });
  return rows;
}
const account = { equity: 10000, dailyPnl: 0, exposures: [], currency: 'USDT' };
const limits = { maxDailyLoss: 250, maxOrderNotional: 2000, maxGrossExposure: 5000, maxRiskPercent: 1, maxSymbolConcentrationPercent: 25, maxQuoteAgeMs: 15000 };
function input(extra = {}) {
  const c = setupCandles(), last = c.at(-1);
  return { symbol: 'BTC/USDT', exchange: 'binance', timeframe: '1h', candles: c, account, quote: { last: last.close, timestamp: new Date(last.timestamp + tf).toISOString() }, limits, config: { minimumConfidence: 55, minimumAgreement: 0.4 }, ...extra };
}
const NOW = start + 92 * tf + 5000;

test('Alpha API exposes versioned GainzAlpha core evidence, collision result and gate', () => {
  assert.equal(ALPHA_ENGINE_VERSION, '1.2.0');
  const r = evaluateAlphaSignal(input(), NOW), g = r.sessionIntelligence.gainzAlphaCore;
  assert.equal(g.result.status, 'ready'); assert.equal(g.result.signal, 'SELL'); assert.equal(g.evidence.available, true);
  assert.ok(['NONE', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'].includes(g.collision.worst));
  assert.ok(r.qualityChecks.some((x) => x.id === 'gainz_alpha_conflict'));
  assert.equal(r.permissions.liveExecutionAuthorized, false); assert.equal(r.permissions.exchangeOrdersCreated, 0);
});

test('Alpha integration is deterministic and the fingerprint reflects GainzAlpha state', () => {
  const a = evaluateAlphaSignal(input(), NOW), b = evaluateAlphaSignal(input(), NOW);
  assert.equal(a.signalId, b.signalId); assert.equal(a.inputSnapshot.sha256, b.inputSnapshot.sha256);
  const other = evaluateAlphaSignal(input({ gainzPreset: 'precision' }), NOW);
  assert.notEqual(other.evidence.signalFingerprint === a.evidence.signalFingerprint && other.sessionIntelligence.gainzAlphaCore.result.preset === a.sessionIntelligence.gainzAlphaCore.result.preset, true);
});

test('reliably negative historical expectancy suppresses the setup and blocks paper eligibility', () => {
  const bad = Array.from({ length: 70 }, () => ({ symbol: 'BTC/USDT', timeframe: '1h', preset: 'balanced', setupType: 'sweep-reclaim-displacement', direction: 'bearish', outcome: 'loss', returnR: -1, confidence: 70 }));
  const r = evaluateAlphaSignal(input({ gainzOutcomes: bad }), NOW), g = r.sessionIntelligence.gainzAlphaCore;
  assert.equal(g.evidence.suppress, true); assert.equal(g.appliedWeight, 0);
  const check = r.qualityChecks.find((x) => x.id === 'gainz_alpha_conflict');
  assert.equal(check.passed, false); assert.equal(r.permissions.paperIntentEligible, false);
  const good = evaluateAlphaSignal(input(), NOW).qualityChecks.find((x) => x.id === 'gainz_alpha_conflict');
  assert.equal(good.passed, true);
});

test('outcomes for another symbol or timeframe never influence this context', () => {
  const other = Array.from({ length: 70 }, () => ({ symbol: 'ETH/USDT', timeframe: '1h', preset: 'balanced', setupType: 'sweep-reclaim-displacement', direction: 'bearish', outcome: 'loss', returnR: -1 }));
  const r = evaluateAlphaSignal(input({ gainzOutcomes: other }), NOW);
  assert.equal(r.sessionIntelligence.gainzAlphaCore.evidence.suppress, false);
  assert.equal(r.sessionIntelligence.gainzAlphaCore.evidence.sampleSize, 0);
});

test('a GainzAlpha failure is isolated and never breaks the Alpha evaluation', () => {
  const r = evaluateAlphaSignal(input({ gainzOutcomes: 'not-an-array', higherTimeframes: [{ timeframe: '1h', candles: 'garbage' }], gainzModel: { weights: null } }), NOW);
  assert.ok(r.signalId); assert.ok(['ready', 'error'].includes(r.sessionIntelligence.gainzAlphaCore.result.status));
});
