import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStrategyDefinition,evaluateStrategyPromotion } from './strategy-registry.js';
const definition=()=>({strategyId:'btc_trend',version:'1.0.0',name:'BTC Trend',assetClasses:['crypto_spot'],timeframes:['1h','4h'],rules:{emaFast:20,emaSlow:50},riskPolicy:{maxRiskPct:1,maxDrawdownPct:10}});
test('validates and hashes immutable versioned strategy definitions',()=>{
 const a=validateStrategyDefinition(definition()),b=validateStrategyDefinition(definition());
 assert.equal(a.checksum,b.checksum);assert.equal(a.immutable,true);assert.equal(a.executionMode,'paper_review_only');
});
test('rejects invalid semantic versions and incomplete definitions',()=>{
 const d=definition();d.version='latest';assert.throws(()=>validateStrategyDefinition(d),/semantic/);
 const e=definition();delete e.riskPolicy;assert.throws(()=>validateStrategyDefinition(e),/riskPolicy/);
});
test('promotion review requires every paper, OOS, walk-forward and risk gate',()=>{
 const evidence={closedTrades:50,profitFactor:1.4,maxDrawdownPercent:8,outOfSampleReturnPercent:3,walkForwardPositiveWindows:4,walkForwardWindows:5,dataQuality:'verified',riskControlsPassed:true};
 const r=evaluateStrategyPromotion(evidence);assert.equal(r.reviewStatus,'paper_promotion_candidate');assert.equal(r.permissions.liveExecutionAuthorized,false);
 evidence.staleEvidence=true;assert.equal(evaluateStrategyPromotion(evidence).reviewStatus,'rejected_or_incomplete');
});
test('incomplete samples cannot become paper candidates',()=>{
 const r=evaluateStrategyPromotion({closedTrades:5,profitFactor:3,maxDrawdownPercent:1,outOfSampleReturnPercent:2,walkForwardPositiveWindows:3,walkForwardWindows:3,dataQuality:'verified',riskControlsPassed:true});
 assert.ok(r.failedChecks.includes('sample_size'));
});
