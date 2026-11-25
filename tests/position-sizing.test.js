import test from 'node:test';
import assert from 'node:assert/strict';
import { floorToStep, atrStop, fixedRiskSize, volatilitySize, kellyFraction, kellyRiskPercent } from '../src/lib/position-sizing.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fixed risk long: 1% of 10000 over a 5 stop is 20 units', () => {
  const r = fixedRiskSize({ equity: 10000, riskPercent: 1, entry: 100, stop: 95 });
  assert.equal(r.valid, true);
  near(r.quantity, 20); near(r.notional, 2000); near(r.riskAmount, 100); near(r.riskPercent, 1);
});

test('fixed risk short mirrors long and rejects a stop on the wrong side', () => {
  near(fixedRiskSize({ side: 'short', equity: 10000, riskPercent: 1, entry: 100, stop: 105 }).quantity, 20);
  assert.equal(fixedRiskSize({ side: 'short', equity: 10000, riskPercent: 1, entry: 100, stop: 95 }).valid, false);
  assert.equal(fixedRiskSize({ side: 'long', equity: 10000, riskPercent: 1, entry: 100, stop: 105 }).valid, false);
});

test('round-trip fees shrink size so realised stop-out loss stays within budget', () => {
  const r = fixedRiskSize({ equity: 10000, riskPercent: 1, entry: 100, stop: 95, feeBps: 10, lotStep: 0.01 });
  near(r.perUnitRisk, 5.195); near(r.quantity, 19.24);
  assert.ok(r.riskAmount <= 100 && r.riskAmount > 99.9);
});

test('notional and position caps bind and are reported', () => {
  const a = fixedRiskSize({ equity: 10000, riskPercent: 1, entry: 100, stop: 95, maxNotional: 1000 });
  near(a.quantity, 10); assert.deepEqual(a.capped, ['maxNotional']);
  const b = fixedRiskSize({ equity: 10000, riskPercent: 1, entry: 100, stop: 95, maxPositionPercent: 5 });
  near(b.quantity, 5); assert.deepEqual(b.capped, ['maxPositionPercent']);
});

test('too small for the minimum order is refused, never rounded up', () => {
  const r = fixedRiskSize({ equity: 100, riskPercent: 0.1, entry: 100, stop: 50, minQuantity: 0.01 });
  assert.equal(r.valid, false); assert.equal(r.quantity, 0);
});

test('invalid inputs return a reason instead of NaN', () => {
  for (const input of [{}, { equity: -1, riskPercent: 1, entry: 1, stop: 0.5 }, { equity: 1, riskPercent: 101, entry: 1, stop: 0.5 }, { equity: 1, riskPercent: 1, entry: 'x', stop: 1 }]) {
    const r = fixedRiskSize(input);
    assert.equal(r.valid, false); assert.ok(r.reason); assert.equal(r.quantity, 0);
  }
});

test('floorToStep avoids float drift and never rounds up', () => {
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(1.239, 0.01), 1.23);
  assert.equal(floorToStep(5, undefined), 5);
});

test('ATR stop and volatility sizing', () => {
  assert.equal(atrStop({ side: 'long', entry: 100, atr: 2, multiple: 2 }), 96);
  assert.equal(atrStop({ side: 'short', entry: 100, atr: 2, multiple: 2 }), 104);
  assert.equal(atrStop({ side: 'long', entry: 1, atr: 1, multiple: 2 }), null);
  const r = volatilitySize({ equity: 10000, riskPercent: 1, entry: 100, atr: 2 });
  near(r.stop, 96); near(r.quantity, 25);
  assert.equal(volatilitySize({ equity: 10000, riskPercent: 1, entry: 100, atr: 0 }).valid, false);
});

test('Kelly: hand-checked fraction, no edge, thin sample and cap', () => {
  near(kellyFraction({ winRate: 0.5, payoffRatio: 2 }), 0.25);
  near(kellyFraction({ winRate: 0.4, payoffRatio: 1 }), -0.2);
  assert.equal(kellyFraction({ winRate: 1.2, payoffRatio: 2 }), null);
  assert.equal(kellyRiskPercent({ winRate: 0.4, payoffRatio: 1, trades: 100 }).riskPercent, 0);
  assert.equal(kellyRiskPercent({ winRate: 0.5, payoffRatio: 2, trades: 10 }).riskPercent, 0);
  near(kellyRiskPercent({ winRate: 0.5, payoffRatio: 2, trades: 100 }).riskPercent, 2); // 6.25% capped to 2
  near(kellyRiskPercent({ winRate: 0.5, payoffRatio: 2, trades: 100, maxRiskPercent: 10 }).riskPercent, 6.25);
});
