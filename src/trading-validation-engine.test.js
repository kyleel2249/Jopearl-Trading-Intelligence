import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTradingValidation, agentExecutionGate } from './trading-validation-engine.js';

const complete = {
 backtest:{closedTrades:150,profitFactor:1.6,maxDrawdownPct:4,netPnl:250},
 outOfSample:{closedTrades:45,netPnl:30},
 walkForward:{windows:5,positiveWindows:4},
 replay:{chronological:true,lookaheadBias:false,dataQuality:'verified'},
 forward:{closedPaperTrades:60,observationDays:30,profitFactor:1.4,maxDrawdownPct:2,riskBreaches:0},
 risk:{preTradePassed:true,dailyLossGuard:true,drawdownGuard:true,killSwitchTested:true}
};
test('complete evidence qualifies only for human-reviewed paper candidate',()=>{
 const result=evaluateTradingValidation(complete);
 assert.equal(result.status,'paper_qualification_candidate');
 assert.equal(result.permissions.liveTrading,false);
 assert.equal(result.permissions.liveOrders,false);
 assert.equal(agentExecutionGate(result,{requestedMode:'paper'}).allowed,true);
 assert.equal(agentExecutionGate(result,{requestedMode:'live'}).allowed,false);
});
test('missing evidence fails closed instead of treating missing metrics as zero-success',()=>{
 const result=evaluateTradingValidation({});
 assert.equal(result.status,'research_only');
 assert.ok(result.failedChecks.length>=15);
 assert.equal(agentExecutionGate(result,{requestedMode:'paper'}).allowed,false);
});
test('lookahead, unverified data and risk breaches block qualification',()=>{
 const evidence=structuredClone(complete);
 evidence.replay.lookaheadBias=true;
 evidence.replay.dataQuality='unverified';
 evidence.forward.riskBreaches=1;
 const result=evaluateTradingValidation(evidence);
 assert.ok(result.failedChecks.includes('replay_no_lookahead'));
 assert.ok(result.failedChecks.includes('replay_data_quality'));
 assert.ok(result.failedChecks.includes('forward_risk_breaches'));
});
test('live mode remains prohibited even with complete qualification evidence',()=>{
 const result=evaluateTradingValidation(complete);
 assert.deepEqual(agentExecutionGate(result,{requestedMode:'live'}),{
  allowed:false,mode:'blocked',reason:'Autonomous live execution is disabled by policy.',liveOrders:false
 });
});

test('historical validation can authorize only a forward paper trial before forward evidence exists',()=>{
 const evidence=structuredClone(complete);
 delete evidence.forward;
 const result=evaluateTradingValidation(evidence);
 assert.equal(result.status,'forward_paper_trial_required');
 assert.equal(result.paperTrialEligible,true);
 assert.equal(agentExecutionGate(result,{requestedMode:'paper'}).allowed,true);
 assert.equal(agentExecutionGate(result,{requestedMode:'live'}).allowed,false);
});
