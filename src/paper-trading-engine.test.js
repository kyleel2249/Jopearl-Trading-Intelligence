import test from 'node:test';
import assert from 'node:assert/strict';
import {PAPER_AGENTS,PAPER_POLICY,assessAgentKpis,calculatePaperMetrics,derivePaperSignal,simulatePaperFill,settlePaperTrade} from './paper-trading-engine.js';
const qualifyingMetrics=()=>({winRatePct:98,closedTrades:240,observationDays:100,profitFactor:2,expectancyR:.2,netPnlUsd:.5,maxDrawdownPct:2,sharpe:1,maxConsecutiveLosses:2,riskBreaches:0,regimes:[{regime:'trend',trades:50},{regime:'range',trades:50},{regime:'high-volatility',trades:50}]});
test('every seeded specialist has a name, role, responsibility and paper-only permissions',()=>{
 assert.equal(PAPER_AGENTS.length,10);
 for(const a of PAPER_AGENTS){assert.ok(a.name);assert.ok(a.role);assert.ok(a.responsibility);assert.equal(a.permissions.live,false);}
 assert.equal(PAPER_POLICY.initialEquityUsd,1);
});
test('live-ready promotion requires every KPI, including 98% observed win rate',()=>{
 const m=qualifyingMetrics();
 assert.equal(assessAgentKpis(m,PAPER_POLICY,60).eligibleForPromotion,true);
 assert.equal(assessAgentKpis({...m,winRatePct:97.99},PAPER_POLICY,60).eligibleForPromotion,false);
 assert.equal(assessAgentKpis({...m,maxDrawdownPct:5.01},PAPER_POLICY,60).eligibleForPromotion,false);
 assert.equal(assessAgentKpis({...m,riskBreaches:1},PAPER_POLICY,60).eligibleForPromotion,false);
 assert.equal(assessAgentKpis(m,PAPER_POLICY,49).eligibleForPromotion,false);
 assert.equal(assessAgentKpis({...m,regimes:[{trades:30},{trades:29},{trades:30}]},PAPER_POLICY,60).eligibleForPromotion,false);
});
test('closed-candle signal engine evaluates all ten specialist roles without runtime errors',()=>{
 const candles=[];let p=100;
 for(let i=0;i<100;i++){const open=p;p*=1+(i%7===0?-.0005:.0008);candles.push([1700000000000+i*60000,open,p*1.002,open*.998,p,100+i]);}
 const ticker={last:p,bid:p-.01,ask:p+.01,timestamp:Date.now()};
 for(const a of PAPER_AGENTS){const result=derivePaperSignal(candles,ticker,a.strategyId);assert.ok(['WAIT','SIGNAL'].includes(result.action));}
});
test('paper fill charges spread/slippage and settlement includes both fees',()=>{
 const fill=simulatePaperFill({direction:'LONG',price:100,quantity:2,feeRate:.001,slippageBps:5,spreadBps:4});
 assert.ok(fill.entryPrice>100);assert.ok(fill.entryFeeUsd>0);
 const settled=settlePaperTrade({...fill,direction:'LONG',riskUsd:10},101,.001,5);
 assert.ok(settled.netPnlUsd<2);assert.ok(Number.isFinite(settled.rMultiple));
});
test('one-dollar starting equity is used for an empty agent ledger',()=>{
 const m=calculatePaperMetrics([],PAPER_POLICY.initialEquityUsd);
 assert.equal(m.closedTrades,0);assert.equal(m.winRatePct,0);assert.equal(m.equityUsd,1);
});
