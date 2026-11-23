import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreSharedMarketContext } from './tbots-integration.js';

test('shared market regime is bounded and conservative on negative BTC context', () => {
  const riskOff = scoreSharedMarketContext({ momentumPct: -8, imbalance: -0.8, fundingRate: 0.001 });
  assert.equal(riskOff.regime, 'risk_off');
  assert.ok(riskOff.riskScore >= 0 && riskOff.riskScore <= 100);
  const neutral = scoreSharedMarketContext({});
  assert.deepEqual(neutral, { riskScore: 50, regime: 'neutral' });
  const riskOn = scoreSharedMarketContext({ momentumPct: 8, imbalance: 0.8, fundingRate: -0.001 });
  assert.equal(riskOn.regime, 'risk_on');
});
