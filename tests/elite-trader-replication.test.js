import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEliteTrader, rankEliteTraders, ETRD_AGENTS } from '../src/elite-trader-replication-engine.js';

const now=Date.parse('2026-11-26T12:00:00.000Z');
const candidate=(overrides={})=>({
  traderId:'bitget-trader-001',displayName:'Sample Trader',source:'manual-provider-export',sourceAttested:true,
  retrievedAt:new Date(now).toISOString(),totalTrades:500,historyDays:240,
  averageHoldingHours:8,maxLeverage:5,
  windows:{
    '7d':{roiPct:2,winRatePct:62,maxDrawdownPct:4,copierPnlUsd:120},
    '30d':{roiPct:8,winRatePct:64,maxDrawdownPct:7,copierPnlUsd:550},
    '90d':{roiPct:18,winRatePct:63,maxDrawdownPct:9,copierPnlUsd:1800,sharpe:1.8,sortino:2.1,calmar:1.6},
    '180d':{roiPct:28,winRatePct:62,maxDrawdownPct:10,copierPnlUsd:3200}
  },...overrides
});

test('ETRD roster contains 15 separately identified agents',()=>{
  assert.equal(ETRD_AGENTS.length,15);
  assert.equal(new Set(ETRD_AGENTS.map(a=>a.id)).size,15);
});
test('candidate with robust history and positive copier outcomes qualifies',()=>{
  const result=assessEliteTrader(candidate(),now);
  assert.equal(result.eligible,true);
  assert.equal(result.style,'day-trading');
  assert.ok(result.score>=80);
});
test('missing or stale source timestamp blocks selection',()=>{
  assert.equal(assessEliteTrader(candidate({retrievedAt:'2020-01-01T00:00:00Z'}),now).eligible,false);
  assert.ok(assessEliteTrader(candidate({retrievedAt:'2020-01-01T00:00:00Z'}),now).failedGates.includes('source_integrity_failed'));
});
test('high drawdown and negative copier PnL fail hard gates',()=>{
  const bad=candidate({windows:{'7d':{roiPct:2},'30d':{roiPct:4},'90d':{roiPct:-5,winRatePct:54,maxDrawdownPct:38,copierPnlUsd:-20},'180d':{roiPct:7}}});
  const result=assessEliteTrader(bad,now);
  assert.equal(result.eligible,false);
  assert.ok(result.failedGates.includes('drawdown_limit_exceeded'));
  assert.ok(result.failedGates.includes('copier_profitability_not_positive'));
});
test('ranker never authorizes live execution and selects only eligible candidates',()=>{
  const result=rankEliteTraders([candidate(),candidate({traderId:'weak',windows:{'7d':{roiPct:-4},'30d':{roiPct:-8},'90d':{roiPct:-10,winRatePct:40,maxDrawdownPct:42,copierPnlUsd:-100},'180d':{roiPct:-20}}})],now);
  assert.equal(result.selected.length,1);
  assert.equal(result.execution.mode,'paper-only');
  assert.equal(result.execution.liveExecutionAuthorized,false);
  assert.equal(result.execution.ordersCreated,0);
});

test('rolling-window coverage cannot be fabricated from a top-level ROI fallback',()=>{
  const sparse=candidate({roiPct:99,windows:{'90d':{roiPct:18,winRatePct:63,maxDrawdownPct:9,copierPnlUsd:1800,sharpe:1.8,sortino:2.1,calmar:1.6}}});
  const result=assessEliteTrader(sparse,now);
  assert.equal(result.windowCoverage,1);
  assert.equal(result.eligible,false);
  assert.ok(result.failedGates.includes('insufficient_window_coverage'));
});

test('impossible performance metric ranges are rejected instead of rewarded',()=>{
  const result=assessEliteTrader(candidate({windows:{'7d':{roiPct:2},'30d':{roiPct:8},'90d':{roiPct:18,winRatePct:145,maxDrawdownPct:-4,copierPnlUsd:1800,sharpe:1.8,sortino:2.1,calmar:1.6},'180d':{roiPct:28}}}),now);
  assert.equal(result.eligible,false);
  assert.ok(result.invalidMetrics.includes('winRatePct'));
  assert.ok(result.invalidMetrics.includes('maxDrawdownPct'));
  assert.ok(result.failedGates.includes('invalid_metric_ranges'));
});
