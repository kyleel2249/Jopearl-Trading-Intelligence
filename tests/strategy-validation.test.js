import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateStrategyEvidence} from '../src/strategy-validation-engine.js';
const passing={backtest:{closedTrades:160,profitFactor:1.8,expectancyR:.22,maxDrawdownPct:7},outOfSample:{closedTrades:45,profitFactor:1.3,expectancyR:.1},monteCarlo:{p95DrawdownPct:12,ruinProbabilityPct:0},forward:{closedTrades:42,observationDays:20,profitFactor:1.35,maxDrawdownPct:3,riskBreaches:0,expectancyR:.18},risk:{riskBreaches:0},decayRatio:.82,decayDetected:false,evidenceAgeHours:2};
test('all validation gates passing yields LIVE_READY but never live authorization',()=>{const v=evaluateStrategyEvidence(passing);assert.equal(v.status,'LIVE_READY');assert.equal(v.liveExecutionAuthorized,false);assert.equal(v.humanApprovalRequired,true);});
test('forged or missing evidence cannot pass required risk and freshness gates',()=>{const v=evaluateStrategyEvidence({...passing,risk:{riskBreaches:1},evidenceAgeHours:30});assert.equal(v.status,'RESEARCH_ONLY');assert.ok(v.failedChecks.includes('risk_breaches'));assert.ok(v.failedChecks.includes('fresh_evidence'));assert.equal(v.liveExecutionAuthorized,false);});
test('performance decay blocks promotion',()=>{const v=evaluateStrategyEvidence({...passing,decayRatio:.2,decayDetected:true});assert.ok(v.failedChecks.includes('forward_decay'));});
