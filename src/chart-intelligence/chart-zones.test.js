import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiquidityZones, buildTargetZones } from './chart-zones.js';

test('liquidity zones create bounded ATR bands around verified price levels', () => {
  const zones = buildLiquidityZones([{ id: 'eqh-1', price: 100, direction: 'buy-side' }, { id: 'bad', price: null }], 2);
  assert.equal(zones.length, 1);
  assert.equal(zones[0].top, 100.14);
  assert.equal(zones[0].bottom, 99.86);
  assert.equal(buildLiquidityZones([{ price: 100 }], 0).length, 0);
});

test('target zones expose distinct TP1, TP2 and TP3 bands only', () => {
  const plan = { entry: 100, stopLoss: 98, targets: [
    { name: 'TP1', price: 103, rr: 1.5 },
    { name: 'TP2', price: 106, rr: 3 },
    { name: 'TP3', price: 108, rr: 4 },
    { name: 'TP4', price: 110, rr: 5 }
  ] };
  const zones = buildTargetZones(plan, 1);
  assert.deepEqual(zones.map(zone => zone.name), ['TP1', 'TP2', 'TP3']);
  assert.ok(zones.every(zone => zone.top > zone.price && zone.bottom < zone.price));
  assert.ok(zones[2].rr > zones[1].rr);
  assert.equal(buildTargetZones(null, 1).length, 0);
  assert.equal(buildTargetZones({ entry: 100, stopLoss: 100, targets: [{ price: 101 }] }, 1).length, 0);
});
