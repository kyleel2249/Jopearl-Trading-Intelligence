import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORT_TERM_SQUADS, evaluateShortTermAgents, evaluateShortTermRisk, scoreShortTermStrategy } from './scalping-daytrading-engine.js';

test('registers independent scalping and day-trading specialist squads', () => {
  assert.equal(SHORT_TERM_SQUADS.length, 2);
  assert.equal(SHORT_TERM_SQUADS[0].agents.length, 8);
  assert.equal(SHORT_TERM_SQUADS[1].agents.length, 8);
});

test('agents abstain on stale or incomplete evidence and never receive execution permission', () => {
  const result = evaluateShortTermAgents({ style: 'both', evidence: { timestamp: new Date(Date.now() - 600000).toISOString() } });
  assert.equal(result.stale, true);
  assert.ok(result.agents.every(agent => agent.status === 'abstain' && agent.executionPermission === 'none'));
  assert.equal(result.liveExecutionAuthorized, false);
});

test('scalping squad requires fresh book, net edge after costs and independent votes', () => {
  const now = Date.now();
  const evidence = { timestamp: new Date(now).toISOString(), bookAgeMs: 100, spreadBps: 1, slippageBps: 1, feeBps: 2, expectedMoveBps: 20, orderBookImbalance: .8, tradeFlowImbalance: .7, liquiditySweep: true, sweepReclaimed: true, relativeVolume: 2, marketStructure: 'bullish', fvg: true, displacementPct: 1, premiumDiscount: 'discount', momentumPct: 1, volatilityPct: 1, absorptionDetected: true, priceResponsePct: .4, breakoutConfirmed: true, retestConfirmed: true, breakoutDirection: 'long', vwapDeviationPct: 1, rsi: 80, equityUsd: 10000, riskPct: .25, stopDistancePct: .4, drawdownPct: 1, sessionOpen: true, venueCalendarVerified: true, highImpactEvent: false, strategyQualified: true, forwardValidationPassed: true };
  const result = evaluateShortTermAgents({ style: 'scalping', evidence }, { now, minimumVotes: 2 });
  assert.equal(result.squads[0].estimatedRoundTripCostBps, 6);
  assert.equal(result.squads[0].eligibleForPaper, true);
  assert.equal(result.squads[0].executionPermission, 'none');
});

test('day trading refuses an unverified exchange session and imminent event', () => {
  const evidence = { timestamp: new Date().toISOString(), sessionOpen: true, venueCalendarVerified: false, highImpactEvent: true, minutesToEvent: 2, equityUsd: 10000, riskPct: .25, stopDistancePct: .5, drawdownPct: 1, session: 'London', openingRangeHigh: 101, openingRangeLow: 99, price: 102, marketStructure: 'bullish', timeframeAlignment: .8, higherTimeframeBias: 'bullish', vwap: 100, emaFast: 101, emaSlow: 99, adx: 25, momentumPct: 1, reversalConfirmed: false, rsi: 60, volatilityPct: 1, strategyQualified: true, forwardValidationPassed: true, marketRegime: 'trending', strategyRegimeFit: .8, crossAssetBias: .5, correlationQuality: .8, crossAssetTimestamp: new Date().toISOString(), highImpactEvent: true, eventSourceVerified: true };
  const result = evaluateShortTermAgents({ style: 'day-trading', evidence });
  assert.equal(result.squads[0].eligibleForPaper, false);
  assert.ok(result.squads[0].veto.includes('day-trading-venue-session-gate'));
  assert.ok(result.squads[0].veto.includes('event-risk-buffer'));
});

test('risk engine blocks missing data, drawdown, daily loss and loss-streak breaches', () => {
  assert.equal(evaluateShortTermRisk({}).allowed, false);
  const result = evaluateShortTermRisk({ equityUsd: 10000, drawdownPct: 9, dailyLossPct: 1, lossStreak: 1, dataFresh: true, venueCalendarVerified: true });
  assert.ok(result.violations.includes('drawdown-limit'));
});

test('strategy qualification requires out-of-sample, paper-forward and execution-cost evidence', () => {
  const weak = scoreShortTermStrategy({ closedTrades: 100, expectancyR: .3, profitFactor: 1.4, maxDrawdownPct: 3, feesAndSlippageIncluded: false, walkForwardPassed: true, paperForwardPassed: true, dataIntegrity: 'verified' });
  assert.equal(weak.qualified, false);
  const strong = scoreShortTermStrategy({ closedTrades: 120, expectancyR: .3, profitFactor: 1.4, maxDrawdownPct: 3, feesAndSlippageIncluded: true, walkForwardPassed: true, paperForwardPassed: true, dataIntegrity: 'verified' });
  assert.equal(strong.qualified, true);
});
