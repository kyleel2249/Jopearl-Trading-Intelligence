import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAgentPerformance, sampleQuality } from './agent-performance-engine.js';

const evaluation = (id, stance, scores, extra = {}) => ({ id, symbol: 'BTC/USDT', recommendedAction: 'REVIEW_SETUP', consensus: { stance }, risk: { blocked: false },
  agents: Object.entries(scores).map(([agentId, score]) => ({ id: agentId, kind: 'directional', status: 'evaluated', score })), ...extra });
const feedback = (evaluationId, outcome, realizedR = null, recordedAt = '2026-01-01T00:00:00Z') => ({ evaluationId, outcome, realizedR, recordedAt });

test('summarizes outcomes, win rate, expectancy and profit factor from recorded feedback only', () => {
  const evals = [evaluation('a', 'bullish_research_lean', { trend: .6 }), evaluation('b', 'bullish_research_lean', { trend: .6 }), evaluation('c', 'bearish_research_lean', { trend: -.6 })];
  const report = summarizeAgentPerformance(evals, [feedback('a', 'win', 2), feedback('b', 'loss', -1), feedback('c', 'not_taken')]);
  assert.equal(report.mode, 'observational_only');
  assert.equal(report.evaluationsWithFeedback, 3);
  assert.equal(report.overall.takenTrades, 2);
  assert.equal(report.overall.winRate, .5);
  assert.equal(report.overall.expectancyR, .5);
  assert.equal(report.overall.profitFactor, 2);
  assert.equal(report.byStance.find(row => row.key === 'bullish_research_lean').feedbackCount, 2);
});

test('the latest feedback per evaluation wins and unknown evaluations are ignored', () => {
  const evals = [evaluation('a', 'bullish_research_lean', { trend: .6 })];
  const report = summarizeAgentPerformance(evals, [feedback('a', 'win', 2, '2026-01-01T00:00:00Z'), feedback('a', 'loss', -1, '2026-01-02T00:00:00Z'), feedback('ghost', 'win', 9)]);
  assert.equal(report.evaluationsWithFeedback, 1);
  assert.equal(report.overall.counts.loss, 1);
  assert.equal(report.overall.counts.win, 0);
});

test('specialist concordance credits agents that sided with the eventual winning direction', () => {
  // bullish consensus that WON: trend (+) was right, macro (-) was wrong. A bullish consensus that LOST: macro (-) was right.
  const evals = [evaluation('w', 'bullish_research_lean', { trend: .6, macro: -.5 }), evaluation('l', 'bullish_research_lean', { trend: .6, macro: -.5 })];
  const report = summarizeAgentPerformance(evals, [feedback('w', 'win', 1), feedback('l', 'loss', -1)]);
  const trend = report.specialistConcordance.find(row => row.id === 'trend'), macro = report.specialistConcordance.find(row => row.id === 'macro');
  assert.equal(trend.decidedVotes, 2); assert.equal(trend.concordance, .5);
  assert.equal(macro.concordance, .5);
});

test('risk votes, weak votes and neutral consensus never enter concordance, and small samples are labelled', () => {
  const evals = [evaluation('n', 'neutral_wait', { trend: .9 }), evaluation('r', 'bullish_research_lean', { trend: .05 }, { agents: [{ id: 'risk', kind: 'risk', status: 'evaluated', score: -.9 }, { id: 'trend', kind: 'directional', status: 'evaluated', score: .05 }] })];
  const report = summarizeAgentPerformance(evals, [feedback('n', 'win', 1), feedback('r', 'win', 1)]);
  assert.equal(report.specialistConcordance.length, 0);
  assert.equal(report.overall.sampleQuality, 'insufficient');
  assert.equal(sampleQuality(10), 'limited');
  assert.equal(sampleQuality(30), 'adequate');
  assert.ok(report.limitations.length >= 3);
});

test('empty or malformed input yields an empty, honest report instead of throwing', () => {
  const report = summarizeAgentPerformance(null, undefined);
  assert.equal(report.evaluations, 0);
  assert.equal(report.overall.winRate, null);
  assert.equal(report.overall.expectancyR, null);
});
