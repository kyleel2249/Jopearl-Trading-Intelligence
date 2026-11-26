import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMultiExchangeTrader,rankMultiExchangeTraders,MULTI_EXCHANGE_AGENTS,EXCHANGE_SOURCE_REGISTRY} from '../src/multi-exchange-elite-engine.js';
const now=Date.parse('2026-11-26T12:00:00.000Z');
const candidate=(exchange='bitget',overrides={})=>({
 exchange,marketType:'usdt_perpetual',traderId:exchange+'-lead-001',displayName:'Provider lead profile',source:'official-profile-export',sourceAttested:true,retrievedAt:new Date(now).toISOString(),totalTrades:600,historyDays:300,averageHoldingHours:5,maxLeverage:3,averageSlippageBps:4,
 windows:{
  '7d':{roiPct:3,winRatePct:70,maxDrawdownPct:3,sharpe:3,sortino:3,profitFactor:3},
  '30d':{roiPct:12,winRatePct:72,maxDrawdownPct:4,sharpe:3.5,sortino:3.5,profitFactor:3.5},
  '90d':{roiPct:32,winRatePct:71,maxDrawdownPct:5,sharpe:4,sortino:4,profitFactor:4},
  '180d':{roiPct:48,winRatePct:70,maxDrawdownPct:6,sharpe:4,sortino:4,profitFactor:4}
 },...overrides
});
test('cross-exchange roster retains all three venue teams and cross-exchange agents',()=>{
 assert.equal(MULTI_EXCHANGE_AGENTS.length,24);
 assert.equal(new Set(MULTI_EXCHANGE_AGENTS.map(x=>x.id)).size,24);
 assert.ok(MULTI_EXCHANGE_AGENTS.some(x=>x.id==='MX-12'));
 assert.deepEqual(Object.keys(EXCHANGE_SOURCE_REGISTRY).sort(),['binance','bitget','bybit']);
});
test('same evidence policy can assess Bitget, Bybit and Binance records',()=>{
 for(const exchange of ['bitget','bybit','binance']){
  const result=assessMultiExchangeTrader(candidate(exchange),now);
  assert.equal(result.exchange,exchange);
  assert.equal(result.eligible,true,exchange+' should pass the shared quality gates');
  assert.equal(result.provenance.independentlyReconciled,false);
 }
});
test('copier PnL is optional and does not penalise venues that do not publish it',()=>{
 const record=candidate('bybit');
 for(const window of Object.values(record.windows))delete window.copierPnlUsd;
 const result=assessMultiExchangeTrader(record,now);
 assert.equal(result.eligible,true);
 assert.equal(result.metrics.copierPnlUsd,null);
});
test('market types not supported by a venue are rejected',()=>{
 const result=assessMultiExchangeTrader(candidate('bybit',{marketType:'coin_perpetual'}),now);
 assert.equal(result.eligible,false);
 assert.ok(result.failedGates.includes('source_or_exchange_integrity_failed'));
});
test('stale or unattested data never enters the eligible set',()=>{
 const stale=assessMultiExchangeTrader(candidate('binance',{retrievedAt:'2020-01-01T00:00:00Z'}),now);
 const unattested=assessMultiExchangeTrader(candidate('bybit',{sourceAttested:false}),now);
 assert.equal(stale.eligible,false);assert.equal(unattested.eligible,false);
});
test('four-window coverage is based on real per-window records and missing windows are not inferred',()=>{
 const sparse=candidate('binance',{windows:{'90d':{roiPct:32,winRatePct:71,maxDrawdownPct:5,sharpe:4,sortino:4,profitFactor:4}}});
 const result=assessMultiExchangeTrader(sparse,now);
 assert.equal(result.windowCoverage,1);assert.equal(result.eligible,false);
 assert.ok(result.failedGates.includes('insufficient_window_coverage'));
});
test('impossible statistics are rejected before ranking',()=>{
 const result=assessMultiExchangeTrader(candidate('bitget',{windows:{'7d':{roiPct:3,winRatePct:70,maxDrawdownPct:3},'30d':{roiPct:12,winRatePct:72,maxDrawdownPct:4},'90d':{roiPct:32,winRatePct:140,maxDrawdownPct:-5},'180d':{roiPct:48,winRatePct:70,maxDrawdownPct:6}}}),now);
 assert.equal(result.eligible,false);assert.ok(result.failedGates.includes('invalid_metric_ranges'));
});
test('ranker creates independent exchange/market boards and removes duplicate trader identities',()=>{
 const records=[candidate('bitget'),candidate('bybit'),candidate('binance'),candidate('binance')];
 const result=rankMultiExchangeTraders(records,now);
 assert.equal(result.candidateCount,3);assert.equal(result.audit.duplicateCandidatesRemoved,1);
 assert.ok(result.boards['bitget:usdt_perpetual']);assert.ok(result.boards['bybit:usdt_perpetual']);assert.ok(result.boards['binance:usdt_perpetual']);
 assert.equal(result.execution.liveExecutionAuthorized,false);assert.equal(result.execution.ordersCreated,0);
});
test('cross-venue position collision detector flags same and opposing directions',()=>{
 const a=candidate('bitget',{positions:[{symbol:'BTC/USDT',side:'long',notionalUsd:1000}]});
 const b=candidate('bybit',{positions:[{symbol:'BTC/USDT',side:'long',notionalUsd:800}]});
 const c=candidate('binance',{positions:[{symbol:'BTC/USDT',side:'short',notionalUsd:700}]});
 const result=rankMultiExchangeTraders([a,b,c],now);
 assert.ok(result.crossExchangeCollisions.some(x=>x.classification==='duplicated-cross-venue-exposure'));
 assert.ok(result.crossExchangeCollisions.some(x=>x.classification==='cross-venue-direction-conflict'));
});
test('strategy DNA fingerprints and downstream intelligence event envelopes are emitted',()=>{
 const result=rankMultiExchangeTraders([candidate('bitget'),candidate('bybit')],now);
 assert.ok(result.strategyClusters.length>0);
 assert.ok(result.intelligenceEvents.some(x=>x.kind==='multi-exchange-elite-ranking'));
 assert.ok(result.intelligenceEvents.some(x=>x.kind==='cross-exchange-exposure-collision'));
});
