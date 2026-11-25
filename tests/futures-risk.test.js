import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFuturesRisk, liquidationPrice, safeMaxLeverage } from '../src/lib/futures-risk.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, a + ' != ' + b);
const base = { product: 'futures', side: 'long', entry: 100, stop: 95, equity: 10000, riskPercent: 1, leverage: 10, takerFeeBps: 0, maintenanceMarginRate: 0.005 };

test('linear long: hand-checked size, margin and liquidation', () => {
  const r = evaluateFuturesRisk(base);
  near(r.sizing.riskAmount, 100);
  near(r.sizing.quantity, 20);            // 100 / 5
  near(r.sizing.notional, 2000);
  near(r.sizing.initialMargin, 200);      // 2000 / 10
  near(r.liquidation.price, 90.5);        // 100 * (1 - 0.1 + 0.005)
  near(r.liquidation.bufferRatio, 1.9);   // 9.5 / 5
  assert.equal(r.decision, 'eligible');
});

test('fees widen the per-unit loss and shrink the size', () => {
  const r = evaluateFuturesRisk({ ...base, takerFeeBps: 10 });
  near(r.sizing.quantity, 100 / (5 + 0.001 * 195));
});

test('linear short mirrors the long', () => {
  const r = evaluateFuturesRisk({ ...base, side: 'short', stop: 105 });
  near(r.liquidation.price, 109.5);       // 100 * (1 + 0.1 - 0.005)
  near(r.liquidation.bufferRatio, 1.9);
  assert.equal(r.decision, 'eligible');
});

test('too much leverage is blocked by the liquidation-distance gate', () => {
  const r = evaluateFuturesRisk({ ...base, leverage: 20 });
  near(r.liquidation.price, 95.5);
  assert.equal(r.liquidation.bufferRatio < 1.5, true);
  assert.ok(r.failedChecks.includes('liquidation_buffer'));
  assert.equal(r.decision, 'blocked');
  near(r.liquidation.safeMaxLeverage, 12.5); // 1 / (0.005 + 1.5 * 0.05)
});

test('liquidation before the stop is called out explicitly', () => {
  const r = evaluateFuturesRisk({ ...base, leverage: 50, limits: { maxLeverage: 100 } });
  assert.equal(r.liquidation.beyondStop, false);
  assert.match(r.checks.find((c) => c.id === 'liquidation_buffer').detail, /before the stop/);
});

test('risk, leverage and margin-utilisation caps each block independently', () => {
  assert.ok(evaluateFuturesRisk({ ...base, riskPercent: 3 }).failedChecks.includes('risk_budget'));
  assert.ok(evaluateFuturesRisk({ ...base, leverage: 25 }).failedChecks.includes('leverage_cap'));
  const util = evaluateFuturesRisk({ ...base, stop: 99.5, leverage: 2, limits: { minLiquidationBufferRatio: 0 } });
  assert.ok(util.failedChecks.includes('margin_utilization'));
});

test('inverse (Coin-M) closed forms are hand-checked', () => {
  near(liquidationPrice({ kind: 'inverse', side: 'long', entry: 100, leverage: 10, mmr: 0.005 }), (100 * 1.005 * 10) / 11);
  near(liquidationPrice({ kind: 'inverse', side: 'short', entry: 100, leverage: 10, mmr: 0.005 }), (100 * 0.995 * 10) / 9);
  assert.equal(liquidationPrice({ kind: 'inverse', side: 'short', entry: 100, leverage: 1, mmr: 0.005 }), null);
  const r = evaluateFuturesRisk({ ...base, product: 'coin-futures', equity: 1, riskPercent: 1, leverage: 5 });
  near(r.sizing.quantity, 0.01 / (1 / 95 - 1 / 100));
  assert.equal(r.sizing.quantityUnit, 'USD contracts');
});

test('equity is exactly lost at the stop: sizing round-trips for linear and inverse', () => {
  const lin = evaluateFuturesRisk(base);
  near(lin.sizing.quantity * (100 - 95), lin.sizing.riskAmount);
  const inv = evaluateFuturesRisk({ ...base, product: 'coin-futures', equity: 2, riskPercent: 1 });
  near(inv.sizing.quantity * (1 / 95 - 1 / 100), inv.sizing.riskAmount);
});

test('spot is cash-checked, margin skips liquidation, CFD and bad input are refused', () => {
  const affordable = evaluateFuturesRisk({ ...base, product: 'spot', stop: 99, equity: 1000, riskPercent: 1 });
  near(affordable.sizing.notional, 1000);   // 10 units at 100 = exactly the cash available
  assert.equal(affordable.decision, 'eligible');
  const spot = evaluateFuturesRisk({ ...base, product: 'spot', stop: 99.5, equity: 1000, riskPercent: 1 });
  near(spot.sizing.notional, 2000);          // 20 units at 100, more than the cash available
  assert.equal(spot.liquidation, null);
  assert.ok(spot.failedChecks.includes('cash_available'));
  const margin = evaluateFuturesRisk({ ...base, product: 'margin' });
  assert.equal(margin.liquidation.price, null);
  assert.equal(evaluateFuturesRisk({ ...base, product: 'cfd' }).decision, 'unsupported');
  assert.equal(evaluateFuturesRisk({ ...base, stop: 101 }).decision, 'blocked');
  assert.equal(evaluateFuturesRisk({ ...base, entry: 'abc' }).decision, 'blocked');
  assert.equal(evaluateFuturesRisk({}).decision, 'blocked');
});

test('safeMaxLeverage is monotonic and respects the cap', () => {
  const args = { kind: 'linear', side: 'long', entry: 100, stop: 95, mmr: 0.005, minBuffer: 1.5 };
  assert.equal(safeMaxLeverage({ ...args, cap: 5 }), 5);
  near(safeMaxLeverage({ ...args, stop: 40, cap: 20 }), 1.1, 1e-9); // 1 / (0.005 + 1.5 * 0.6) = 1.1049, floored to 2 dp
  assert.equal(safeMaxLeverage({ ...args, stop: 99.99, cap: 20 }), 20, 'a very tight stop is limited only by the cap');
  assert.equal(safeMaxLeverage({ ...args, entry: 100, stop: 0.5, mmr: 0.9, cap: 20 }), null, 'no leverage satisfies the buffer when maintenance margin alone exceeds it');
});
