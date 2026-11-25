import test from 'node:test';
import assert from 'node:assert/strict';
import {PAPER_AGENTS,PAPER_POLICY,assessAgentKpis,calculatePaperMetrics,derivePaperSignal,simulatePaperFill,settlePaperTrade} from './paper-trading-engine.js';
const qualifyingMetrics=()=>({winRatePct:98,closedTrades:240,observationDays:100,profitFactor:2,expectancyR:.2,netPnlUsd:.5,maxDrawdownPct:2,sharpe:1,maxConsecutiveLosses:2,riskBreaches:0,regimes:[{regime:'trend',trades:50},{regime:'range',trades:50},{regime:'high-volatility',trades:50}]});
test('every seeded specialist has a name, role, responsibility and paper-only permissions',()=>{
 assert.equal(PAPER_AGENTS.length,10);
 for(const a of PAPER_AGENTS){assert.ok(a.name);assert.ok(a.role);assert.ok(a.responsibility);assert.equal(a.permissions.live,false);}
 assert.equal(PAPER_POLICY.initialEquityUsd,1);
 assert.equal(PAPER_POLICY.maxFleetOpenPositions,10);
 assert.equal(PAPER_POLICY.maxOpenPerSymbol,2);
 assert.equal(PAPER_POLICY.maxSameDirectionOpenPositions,6);
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
 const malformed=Array.from({length:40},(_,i)=>[i,100,NaN,99,100,10]);
 const guarded=derivePaperSignal(candles,ticker,'trend',{timeframes:{'5m':malformed}});
 assert.ok(Object.values(guarded.features.timeframeBias).every(Number.isFinite));
});
test('paper fill and exit settlement charge entry and exit spread, slippage and fees',()=>{
 const fill=simulatePaperFill({direction:'LONG',price:100,quantity:2,feeRate:.001,slippageBps:5,spreadBps:4});
 assert.ok(fill.entryPrice>100);assert.ok(fill.entryFeeUsd>0);
 const withSpread=settlePaperTrade({...fill,direction:'LONG',riskUsd:10},101,.001,5,4);
 const withoutSpread=settlePaperTrade({...fill,direction:'LONG',riskUsd:10},101,.001,5,0);
 assert.ok(withSpread.exitPrice<withoutSpread.exitPrice);
 assert.ok(withSpread.netPnlUsd<withoutSpread.netPnlUsd);
 assert.ok(Number.isFinite(withSpread.rMultiple));
 assert.equal(withSpread.exitSpreadBps,4);
});
test('paper metrics expose payoff, fee, holding-time and recovery analytics',()=>{
 const trades=[
  {status:'closed',netPnlUsd:.12,grossPnlUsd:.14,rMultiple:.6,entryFeeUsd:.01,exitFeeUsd:.01,openedAt:'2026-01-01T00:00:00Z',closedAt:'2026-01-01T01:00:00Z',regime:'trend'},
  {status:'closed',netPnlUsd:-.04,grossPnlUsd:-.02,rMultiple:-.2,entryFeeUsd:.01,exitFeeUsd:.01,openedAt:'2026-01-02T00:00:00Z',closedAt:'2026-01-02T00:30:00Z',regime:'range'}
 ];
 const m=calculatePaperMetrics(trades,1,Date.parse('2026-04-01T00:00:00Z'));
 assert.equal(m.closedTrades,2);
 assert.ok(m.averageWinUsd>0);
 assert.ok(m.averageLossUsd>0);
 assert.ok(m.payoffRatio>0);
 assert.equal(m.totalFeesUsd,.04);
 assert.equal(m.averageHoldMinutes,45);
 assert.equal(m.bestTradeUsd,.12);
 assert.equal(m.worstTradeUsd,-.04);
 assert.ok(Number.isFinite(m.recoveryFactor));
});
test('one-dollar starting equity is used for an empty agent ledger',()=>{
 const m=calculatePaperMetrics([],PAPER_POLICY.initialEquityUsd);
 assert.equal(m.closedTrades,0);assert.equal(m.winRatePct,0);assert.equal(m.equityUsd,1);
 assert.equal(m.totalFeesUsd,0);assert.equal(m.averageHoldMinutes,0);
});
