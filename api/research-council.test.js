import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateResearchCouncil } from './research-council.js';

const base=()=>({symbol:'BTC/USDT',assetClass:'crypto_spot',evidence:{timestamp:new Date(1700000000000).toISOString(),sources:[{id:'venue-a',status:'ok'}],momentumPct:2,timeframeAlignment:.8,relativeVolume:2,depthImbalance:.4,fundingRate:.0001,liquidityUsd:100000,volatilityPct:2}});
test('runs independent specialists and produces explainable research consensus',()=>{
 const now=1700000000000,r=evaluateResearchCouncil(base(),now);
 assert.equal(r.agents.length,6);assert.equal(r.consensus.stance,'research_bullish_lean');assert.equal(r.permissions.paperEntryEligible,false);assert.equal(r.permissions.liveExecutionAuthorized,false);
});
test('blocks stale or missing timestamps',()=>{
 const input=base();input.evidence.timestamp=new Date(1699990000000).toISOString();
 const r=evaluateResearchCouncil(input,1700000000000);
 assert.equal(r.consensus.stance,'insufficient_evidence');assert.equal(r.risk.staleEvidence,true);
});
test('requires a minimum set of directional specialist evidence',()=>{
 const input=base();delete input.evidence.depthImbalance;delete input.evidence.fundingRate;delete input.evidence.momentumPct;
 const r=evaluateResearchCouncil(input,1700000000000);
 assert.equal(r.consensus.stance,'insufficient_evidence');
});
test('keeps macro and liquidity risk votes distinct from directional count',()=>{
 const input=base();input.evidence.macroBias='risk-off';input.evidence.liquidityUsd=1000;
 const r=evaluateResearchCouncil(input,1700000000000);
 assert.ok(r.agents.find(a=>a.id==='risk').score<0);assert.equal(r.permissions.ordersCreated,0);
});
