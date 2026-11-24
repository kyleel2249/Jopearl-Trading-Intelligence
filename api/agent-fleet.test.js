import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentFleet } from './agent-fleet.js';

const now = Date.now();
const complete = { symbol:'BTC/USDT', evidence:{ timestamp:new Date(now).toISOString(), momentumPct:1.8,
  timeframeAlignment:.8, relativeVolume:1.6, depthImbalance:.35, fundingRate:.0001,
  openInterestChangePct:4, volatilityPct:2.5, liquidityUsd:250000, correlationBias:.2,
  highImpactEvent:false, sources:[{id:'bitget',status:'ok'}] } };

test('agent fleet evaluates specialists with explainable consensus and no execution permission', () => {
  const result = runAgentFleet(complete, now);
  assert.equal(result.agents.length, 10);
  assert.equal(result.symbol, 'BTC/USDT');
  assert.ok(result.consensus.evaluatedAgents >= 8);
  assert.equal(result.permissions.liveExecutionAuthorized, false);
  assert.equal(result.permissions.ordersCreated, 0);
  assert.ok(result.agents.every(agent => agent.rationale));
});

test('stale evidence blocks consensus and trade review', () => {
  const result = runAgentFleet({ ...complete, evidence:{ ...complete.evidence, timestamp:new Date(now-120000).toISOString() } }, now);
  assert.equal(result.consensus.stance, 'insufficient_evidence_or_risk_block');
  assert.equal(result.recommendedAction, 'NO_TRADE');
  assert.equal(result.consensus.confidence, 0);
});

test('missing evidence is visible and cannot be silently inferred', () => {
  const result = runAgentFleet({ symbol:'ETH/USDT', evidence:{ timestamp:new Date(now).toISOString(), momentumPct:1 } }, now);
  assert.ok(result.agents.some(agent => agent.status === 'insufficient_evidence'));
  assert.equal(result.permissions.liveExecutionAuthorized, false);
});

test('high risk veto blocks an otherwise bullish setup', () => {
  const result = runAgentFleet({ ...complete, evidence:{ ...complete.evidence, liquidityUsd:1000, volatilityPct:18 } }, now);
  assert.equal(result.risk.blocked, true);
  assert.equal(result.recommendedAction, 'NO_TRADE');
});
