import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAlphaPromotionReadiness, evaluateAlphaSignal, evaluateHistoricalSessionMemory, evaluatePaperExit, normalizeAlphaCandles, runAlphaReplay } from './alpha-signal-engine.js';
const start=1700000000000,tf=3600000;
function candles(count=240,mode='up'){
 return Array.from({length:count},(_,i)=>{const trend=mode==='up'?i*.16:mode==='down'?-i*.16:Math.sin(i/5)*2;const close=100+trend+Math.sin(i/3)*.35;return{timestamp:start+i*tf,open:close-.08,high:close+.45,low:close-.45,close,volume:1000+(i%15)*80};});
}
const account={equity:10000,dailyPnl:0,exposures:[]};
const limits={maxDailyLoss:250,maxOrderNotional:2000,maxGrossExposure:5000,maxRiskPercent:1,maxSymbolConcentrationPercent:25,maxQuoteAgeMs:15000};
function input(mode='up'){const c=candles(240,mode),last=c.at(-1);return{symbol:'BTC/USDT',exchange:'binance',timeframe:'1h',candles:c,marketDataIdentity:{exchange:'binance',requestedExchange:'binance',symbol:'BTC/USDT',failedOver:false},account:{...account,currency:'USDT'},quote:{exchange:'binance',requestedExchange:'binance',symbol:'BTC/USDT',failedOver:false,last:last.close,timestamp:new Date(last.timestamp+tf).toISOString()},limits,config:{minimumConfidence:55,minimumAgreement:.4}};}
test('normalizes only completed, chronological candles and rejects malformed history',()=>{
 const c=candles();assert.equal(normalizeAlphaCandles(c,'1h',c.at(-1).timestamp+tf).length,c.length);
 assert.equal(normalizeAlphaCandles(c,'1h',c.at(-1).timestamp+tf-1).length,c.length-1);
 const bad=candles();bad[20].timestamp=bad[19].timestamp;assert.throws(()=>normalizeAlphaCandles(bad,'1h',Date.now()),/strictly chronological/);
 assert.throws(()=>normalizeAlphaCandles(c.slice(0,50),'1h',Date.now()),/80–5,000/);
});
test('produces a deterministic, explainable signal fingerprint for identical data and settings',()=>{
 const a=input(),x=evaluateAlphaSignal(a,start+240*tf+5000),y=evaluateAlphaSignal(a,start+240*tf+5000);
 assert.equal(x.signalId,y.signalId);assert.equal(x.evidence.marketDataSha256,y.evidence.marketDataSha256);
 assert.equal(x.evidence.models.length,5);assert.equal(x.evidence.usedOnlyCompletedCandles,true);assert.equal(x.market.quoteCurrency,'USDT');assert.equal(x.evidence.quoteSha256,y.evidence.quoteSha256);assert.equal(x.inputSnapshot.sha256,y.inputSnapshot.sha256);assert.equal(x.inputSnapshot.candles.length,240);
 assert.equal(x.confidenceType,'heuristic_consensus_not_probability');assert.equal(x.permissions.liveExecutionAuthorized,false);
});
test('blocks missing or stale quotes and does not mark them paper eligible',()=>{
 const a=input();a.quote.timestamp=new Date(start).toISOString();const r=evaluateAlphaSignal(a,start+241*tf);
 assert.equal(r.qualityChecks.find(x=>x.id==='quote_freshness').passed,false);assert.equal(r.permissions.paperIntentEligible,false);
});
test('fails closed when exposure inventory uses a different quote currency',()=>{const a=input();a.account.exposures=[{symbol:'ETH/USD',marketValue:250,currency:'USD'}];const r=evaluateAlphaSignal(a,start+240*tf+5000);assert.equal(r.qualityChecks.find(x=>x.id==='exposure_quote_currency').passed,false);assert.equal(r.permissions.paperIntentEligible,false);});
test('fails closed when account quote currency is missing or mismatched',()=>{const a=input();a.account.currency='USD';const r=evaluateAlphaSignal(a,start+240*tf+5000);assert.equal(r.qualityChecks.find(x=>x.id==='account_quote_currency').passed,false);assert.equal(r.permissions.paperIntentEligible,false);});
test('fails closed when account exposure inventory is omitted',()=>{
 const a=input();delete a.account.exposures;const r=evaluateAlphaSignal(a,start+240*tf+5000);
 assert.equal(r.riskChecks.find(x=>x.id==='account_exposures').passed,false);assert.equal(r.permissions.paperIntentEligible,false);
});
test('replay is reproducible and reports separate chronological out-of-sample metrics',()=>{
 const c=candles(260);const a={candles:c,timeframe:'1h',symbol:'BTC/USDT',exchange:'binance',config:{minimumConfidence:50,minimumAgreement:.3},feeBps:10,slippageBps:5};
 const x=runAlphaReplay(a,start+261*tf),y=runAlphaReplay(a,start+261*tf);
 assert.deepEqual(x.trades,y.trades);assert.equal(x.data.sha256,y.data.sha256);assert.equal(x.validation.split,'chronological 70/30 by entry candle');
 assert.equal(x.validation.outOfSampleUsedForParameterSelection,false);assert.equal(x.data.quoteCurrency,'USDT');assert.equal(x.inputSnapshot.candles.length,260);assert.ok(Number.isFinite(x.overall.endingCapital));
});
test('promotion gate requires measured paper sample, positive expectancy, controlled drawdown and OOS replay',()=>{const trades=Array.from({length:30},(_,i)=>({status:'closed',signalId:'alpha_'+String(i).padStart(32,'0'),signalFingerprint:'fingerprint-'+i,liveExecutionAuthorized:false,market:{quoteCurrency:'USDT'},close:{signalId:'alpha_'+String(i).padStart(32,'0'),closedAt:new Date(start+i*86400000).toISOString(),netPnl:i%5===0?-10:20,liveExecutionAuthorized:false}}));const replay={generatedAt:new Date(start+30*86400000).toISOString(),data:{quoteCurrency:'USDT'},outOfSample:{trades:12,netPnl:120,profitFactor:1.5}};const ready=evaluateAlphaPromotionReadiness({trades,replays:[replay],quoteCurrency:'USDT',now:start+31*86400000});assert.equal(ready.decision,'candidate_for_independent_governance_review');assert.equal(ready.permissions.liveExecutionAuthorized,false);const blocked=evaluateAlphaPromotionReadiness({trades:trades.slice(0,10),replays:[],quoteCurrency:'USDT',now:start+31*86400000});assert.equal(blocked.decision,'blocked');assert.ok(blocked.failedChecks.includes('paper_sample_size'));});
test('paper exit monitor closes only when stop or second target is crossed',()=>{const trade={direction:'buy',stopLoss:95,takeProfitTwo:110};assert.equal(evaluatePaperExit(trade,94),'stop_loss');assert.equal(evaluatePaperExit(trade,111),'take_profit_2');assert.equal(evaluatePaperExit(trade,100),null);const short={direction:'sell',stopLoss:105,takeProfitTwo:90};assert.equal(evaluatePaperExit(short,106),'stop_loss');assert.equal(evaluatePaperExit(short,89),'take_profit_2');});
test('rejects invalid replay assumptions and timeframe',()=>{
 assert.throws(()=>runAlphaReplay({candles:candles(),timeframe:'2m'},start+241*tf),/Unsupported replay timeframe/);
 assert.throws(()=>runAlphaReplay({candles:candles(),timeframe:'1h',initialCapital:-1},start+241*tf),/positive/);const zeroFee=runAlphaReplay({candles:candles(),timeframe:'1h',feeBps:0,slippageBps:0},start+241*tf);assert.equal(zeroFee.parameters.feeBps,0);
});

test('session intelligence is included in Alpha and probability estimate is labeled heuristic',()=>{
 const result=evaluateAlphaSignal(input('up'),start+240*tf+5000);
 assert.ok(result.sessionIntelligence);assert.ok(result.sessionIntelligence.gainzAlpha);assert.ok(Array.isArray(result.sessionIntelligence.gainzAlpha.components));
 assert.ok(result.sessionIntelligence.forecast);
 assert.ok(Array.isArray(result.sessionIntelligence.liquiditySweeps.events));
 assert.ok(result.sessionAdjustedProbabilityEstimate>=0&&result.sessionAdjustedProbabilityEstimate<=100);
 assert.equal(result.probabilityEstimateType,'uncalibrated_heuristic');
 assert.ok(Number.isFinite(result.baseConfidence));
});

test('historical session memory only adjusts after minimum sample and matches session/pair',()=>{
 const records=Array.from({length:10},(_,i)=>({session:'London',symbol:'BTC/USDT',outcome:i<7?'win':'loss',returnR:i<7?1.2:-.7}));
 const result=evaluateHistoricalSessionMemory(records,{symbol:'BTC/USDT',activeSessions:['London']});
 assert.equal(result.status,'ready');assert.equal(result.sampleCount,10);assert.ok(result.adjustment>0);
 const sparse=evaluateHistoricalSessionMemory(records.slice(0,4),{symbol:'BTC/USDT',activeSessions:['London']});
 assert.equal(sparse.adjustment,0);assert.equal(sparse.status,'insufficient');
 const mismatch=evaluateHistoricalSessionMemory(records,{symbol:'ETH/USDT',activeSessions:['London']});assert.equal(mismatch.sampleCount,0);
});

test('historical session adjustment ignores missing return-R observations',()=>{const rows=Array.from({length:10},(_,i)=>({session:'London',symbol:'BTC/USDT',outcome:i<8?'win':'loss',returnR:i<4?1:null}));const result=evaluateHistoricalSessionMemory(rows,{symbol:'BTC/USDT',activeSessions:['London']});assert.equal(result.status,'insufficient');assert.equal(result.averageR,1);assert.equal(result.adjustment,0);});

test('rejects null and empty OHLCV fields instead of silently coercing volume to zero', () => {
 const nullVolume=candles();nullVolume[12].volume=null;
 const emptyVolume=candles();emptyVolume[12].volume='';
 assert.throws(()=>normalizeAlphaCandles(nullVolume,'1h',start+300*tf),/missing, null or empty/);
 assert.throws(()=>normalizeAlphaCandles(emptyVolume,'1h',start+300*tf),/missing, null or empty/);
});

test('replay drawdown is measured against the configured initial capital, not a fixed 10,000 baseline', () => {
 const c=candles(260),common={candles:c,timeframe:'1h',symbol:'BTC/USDT',exchange:'binance',config:{minimumConfidence:50,minimumAgreement:.3},feeBps:10,slippageBps:5};
 const small=runAlphaReplay({...common,initialCapital:1000},start+261*tf);
 const large=runAlphaReplay({...common,initialCapital:10000},start+261*tf);
 assert.ok(small.trades.length>0);
 assert.equal(small.overall.maxDrawdownPercent,large.overall.maxDrawdownPercent);
 assert.equal(small.inSample.maxDrawdownPercent,large.inSample.maxDrawdownPercent);
 assert.equal(small.outOfSample.maxDrawdownPercent,large.outOfSample.maxDrawdownPercent);
 assert.ok(Math.abs(small.overall.endingCapital*10-large.overall.endingCapital)<0.01);
});

test('blocks quote or candle history from a different venue or market symbol', () => {
 const wrongQuoteVenue=input();wrongQuoteVenue.quote.exchange='okx';
 const quoteVenueResult=evaluateAlphaSignal(wrongQuoteVenue,start+240*tf+5000);
 assert.equal(quoteVenueResult.qualityChecks.find(x=>x.id==='quote_source_identity').passed,false);
 assert.equal(quoteVenueResult.permissions.paperIntentEligible,false);
 const wrongQuoteSymbol=input();wrongQuoteSymbol.quote.symbol='ETH/USDT';
 const quoteSymbolResult=evaluateAlphaSignal(wrongQuoteSymbol,start+240*tf+5000);
 assert.equal(quoteSymbolResult.qualityChecks.find(x=>x.id==='quote_source_identity').passed,false);
 const wrongCandleVenue=input();wrongCandleVenue.marketDataIdentity.exchange='bybit';
 const candleVenueResult=evaluateAlphaSignal(wrongCandleVenue,start+240*tf+5000);
 assert.equal(candleVenueResult.qualityChecks.find(x=>x.id==='candle_source_identity').passed,false);
 assert.equal(candleVenueResult.permissions.paperIntentEligible,false);
});
