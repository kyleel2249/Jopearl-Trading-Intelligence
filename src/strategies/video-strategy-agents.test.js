import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_STRATEGY_AGENTS, evaluateVideoStrategyAgents } from './video-strategy-agents.js';

test('video strategy agents register separate baselines and an isolated variant', () => {
  assert.equal(VIDEO_STRATEGY_AGENTS.length, 3);
  assert.equal(VIDEO_STRATEGY_AGENTS[0].baseline, true);
  assert.equal(VIDEO_STRATEGY_AGENTS[1].baseline, true);
  assert.equal(VIDEO_STRATEGY_AGENTS[2].baseline, false);
});

test('agent orchestrator returns abstentions safely when evidence is absent', () => {
  const result = evaluateVideoStrategyAgents({ now: 1 });
  assert.equal(result.paperOnly, true);
  assert.equal(result.liveExecutionAuthorized, false);
  assert.equal(result.agents.every(agent => agent.canSubmitOrders === false), true);
  assert.equal(result.agents[2].status, 'no-confluence');
});
