import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAgentKpis, calculatePaperMetrics, simulatePaperFill, settlePaperTrade } from './paper-trading-engine.js';
test('KPI promotion requires every independent gate including 98% win rate',()=>{
 const policy={targetWinRatePct:98,minimumClosedTrades:200,minimumObservationDays:90,minimumProfitFactor:1.5,minimumExpectancyR:.15,maxDrawdownPct:5,minimumSharpe:.8,minimumOutOfSampleTrades:50,minimumRegimeTrades:30};
 const metrics={winRatePct:98,closedTrades:240,observationDays:100,profitFactor:2,expectancyR:.2,maxDrawdownPct:2,sharpe:1,regimes:[{trades:50},{trades:50},{trades:50}]};
 assert.equal(assessAgentKpis(metrics,policy,60).eligibleForPromotion,true);
 assert.equal(assessAgentKpis({...metrics,winRatePct:97.9},policy,60).eligibleForPromotion,false);
 assert.equal(assessAgentKpis({...metrics,maxDrawdownPct:6},policy,60).eligibleForPromotion,false);
});
test('paper fill charges spread/slippage and settlement includes both fees',()=>{
 const fill=simulatePaperFill({direction:'LONG',price:100,quantity:2,feeRate:.001,slippageBps:5,spreadBps:4});
 assert.ok(fill.entryPrice>100);assert.ok(fill.entryFeeUsd>0);
 const settled=settlePaperTrade({...fill,direction:'LONG',riskUsd:10},101,.001,5);
 assert.ok(settled.netPnlUsd<2);assert.ok(Number.isFinite(settled.rMultiple));
});
test('metrics do not promote an empty or under-sampled record',()=>{
 const m=calculatePaperMetrics([],10000);
 assert.equal(m.closedTrades,0);assert.equal(m.winRatePct,0);
});
