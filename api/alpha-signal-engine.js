import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { evaluatePretradeRisk } from './pretrade-risk.js';
import { requirePrivateApiAuth } from './policy.js';
import { withExchange } from './exchanges.js';
import { assessExchangeEventRisk } from './institutional-intelligence.js';
import { sessionForecastAdjustment, detectSessionLiquiditySweeps } from '../src/session-trading-intelligence.js';
import { classifySessionSetups } from '../src/session-setup-classifier.js';
import { analyzeGainzAlphaInspired } from '../src/gainz-alpha-intelligence.js';
import { analyzeSMC } from '../src/smc-intelligence.js';
import { analyzeGainzAlpha, toAlphaEvidence } from '../src/gainz-alpha/engine.js';
import { detectCollisions } from '../src/gainz-alpha/collision.js';
import { loadGainzOutcomes, saveGainzOutcomes } from './gainz-alpha-memory.js';

export const alphaSignalRouter = express.Router();
export const ALPHA_ENGINE_VERSION = '1.2.0';
const TIMEFRAMES = { '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'12h':43200000,'1d':86400000,'1w':604800000 };
const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));
const finite = v => Number.isFinite(Number(v));
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const round = (v,n=8) => Number(Number(v).toFixed(n));
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
const stddev = values => { const m=mean(values); return values.length>1 ? Math.sqrt(mean(values.map(x=>(x-m)**2))) : 0; };
const ema = (values,period) => { const alpha=2/(period+1),out=[]; let v=values[0]; for(let i=0;i<values.length;i++){v=i===0?values[i]:values[i]*alpha+v*(1-alpha);out.push(v);} return out; };
const timeframeMs = value => TIMEFRAMES[String(value)] || null;

export function normalizeAlphaCandles(input, timeframe, now=Date.now()) {
  if (!Array.isArray(input) || input.length < 80 || input.length > 5000) throw new Error('Alpha analysis requires 80–5,000 OHLCV candles.');
  const tf = timeframeMs(timeframe);
  if (!tf) throw new Error('Unsupported timeframe. Use a supported interval from 1m through 1w.');
  const rows = input.map((c,i) => {
    const row = Array.isArray(c) ? { timestamp:c[0],open:c[1],high:c[2],low:c[3],close:c[4],volume:c[5] } : c;
    const values = ['timestamp','open','high','low','close','volume'].map(k=>Number(row?.[k]));
    if (!values.every(Number.isFinite)) throw new Error('Candle '+i+' contains a missing or non-finite OHLCV field.');
    const [timestamp,open,high,low,close,volume]=values;
    if (timestamp<=0 || Math.min(open,high,low,close)<=0 || volume<0 || high<Math.max(open,close,low) || low>Math.min(open,close,high)) throw new Error('Candle '+i+' violates positive-price or OHLC consistency rules.');
    if (i && timestamp<=Number((Array.isArray(input[i-1])?input[i-1][0]:input[i-1].timestamp))) throw new Error('Candles must be strictly chronological with unique timestamps.');
    return { timestamp,open,high,low,close,volume };
  });
  const completed = rows.filter(c=>c.timestamp+tf<=now);
  if (completed.length<80) throw new Error('At least 80 completed candles are required; the active candle is excluded.');
  return completed;
}

function rsi(values,period=14) {
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gains+=Math.max(0,d);losses+=Math.max(0,-d);}
  let avgGain=gains/period,avgLoss=losses/period,out=Array(values.length).fill(null);
  out[period]=avgLoss===0?100:100-100/(1+avgGain/avgLoss);
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgGain=(avgGain*(period-1)+Math.max(0,d))/period;avgLoss=(avgLoss*(period-1)+Math.max(0,-d))/period;out[i]=avgLoss===0?100:100-100/(1+avgGain/avgLoss);}
  return out;
}
function atr(candles,period=14) {
  const tr=candles.map((c,i)=>i===0?c.high-c.low:Math.max(c.high-c.low,Math.abs(c.high-candles[i-1].close),Math.abs(c.low-candles[i-1].close)));
  return mean(tr.slice(-period));
}
function buildEvidence(candles) {
  const closes=candles.map(c=>c.close),volumes=candles.map(c=>c.volume),last=closes.length-1;
  const fast=ema(closes,9),slow=ema(closes,21),ema12=ema(closes,12),ema26=ema(closes,26),macdLine=ema12.map((v,i)=>v-ema26[i]),macdSignal=ema(macdLine,9),rsiValues=rsi(closes,14);
  const recent=candles.slice(-21,-1),priorHigh=Math.max(...recent.map(c=>c.high)),priorLow=Math.min(...recent.map(c=>c.low));
  const volumeBase=mean(volumes.slice(-21,-1)),volumeRatio=volumeBase>0?volumes[last]/volumeBase:null;
  const closes20=closes.slice(-20),mean20=mean(closes20),sd20=stddev(closes20),zScore=sd20>0?(closes[last]-mean20)/sd20:0;
  const atr14=atr(candles,14),atrPct=atr14/closes[last]*100;
  const trendDirection=fast[last]>slow[last]&&fast[last]>fast[last-3]?1:fast[last]<slow[last]&&fast[last]<fast[last-3]?-1:0;
  const momentumDirection=macdLine[last]>macdSignal[last]&&rsiValues[last]>52?1:macdLine[last]<macdSignal[last]&&rsiValues[last]<48?-1:0;
  const breakoutDirection=closes[last]>priorHigh?1:closes[last]<priorLow?-1:0;
  const volumeDirection=volumeRatio!==null&&volumeRatio>=1.15?(closes[last]>closes[last-1]?1:closes[last]<closes[last-1]?-1:0):0;
  const reversionDirection=zScore<=-1.6?1:zScore>=1.6?-1:0;
  const models=[
    {id:'trend',label:'EMA trend structure',weight:.26,direction:trendDirection,evidence:trendDirection===1?'EMA 9 is above EMA 21 and rising':trendDirection===-1?'EMA 9 is below EMA 21 and falling':'EMA trend is mixed or flat'},
    {id:'momentum',label:'MACD and RSI momentum',weight:.24,direction:momentumDirection,evidence:momentumDirection===1?'MACD is above its signal and RSI confirms bullish momentum':momentumDirection===-1?'MACD is below its signal and RSI confirms bearish momentum':'MACD/RSI momentum confirmation is mixed'},
    {id:'breakout',label:'20-bar range breakout',weight:.20,direction:breakoutDirection,evidence:breakoutDirection===1?'Close broke above the prior 20-bar high':breakoutDirection===-1?'Close broke below the prior 20-bar low':'No confirmed 20-bar range break'},
    {id:'participation',label:'Volume participation',weight:.12,direction:volumeDirection,evidence:volumeDirection?'Volume expansion confirms the latest directional candle':'Volume expansion confirmation is absent'},
    {id:'mean_reversion',label:'Mean-reversion pressure',weight:.18,direction:reversionDirection,evidence:reversionDirection===1?'Price is statistically stretched below its 20-bar mean':reversionDirection===-1?'Price is statistically stretched above its 20-bar mean':'Price is not at the configured statistical extreme'}
  ];
  const score=models.reduce((s,m)=>s+m.direction*m.weight,0);
  const direction=score>=.18?'buy':score<=-.18?'sell':'neutral';
  const active=models.filter(m=>m.direction!==0),agreeing=active.filter(m=>m.direction===(direction==='buy'?1:direction==='sell'?-1:0)).length;
  const directionalAgreement=active.length?agreeing/active.length:0;
  const confidence=round(clamp(50+Math.abs(score)*48+(directionalAgreement-.5)*12,0,95),2);
  const atrPercent=atrPct;
  const regime=atrPercent>=3?'high_volatility':atrPercent<=.35?'low_volatility':'normal_volatility';
  return {direction,score:round(score,5),confidence,directionalAgreement:round(directionalAgreement,4),models:models.map(m=>({...m,weight:round(m.weight,2)})),
    indicators:{ema9:round(fast[last]),ema21:round(slow[last]),rsi14:round(rsiValues[last],2),macd:round(macdLine[last]),macdSignal:round(macdSignal[last]),volumeRatio:volumeRatio===null?null:round(volumeRatio,3),zScore20:round(zScore,3),atr14:round(atr14),atrPercent:round(atrPct,3),prior20High:round(priorHigh),prior20Low:round(priorLow)},
    marketRegime:regime,methodology:'Deterministic weighted ensemble of trend, momentum, breakout, volume participation and mean-reversion evidence. Confidence is a heuristic consensus score, not a calibrated probability.'};
}
function canonicalConfig(config={}) {
  return {minimumConfidence:clamp(Number(config.minimumConfidence)||66,50,95),minimumAgreement:clamp(Number(config.minimumAgreement)||.6,.2,1),
    atrStopMultiple:clamp(Number(config.atrStopMultiple)||1.5,.5,5),targetOneR:clamp(Number(config.targetOneR)||1,0.5,5),
    targetTwoR:clamp(Number(config.targetTwoR)||2,1,8),riskPercent:clamp(Number(config.riskPercent)||.5,.1,2)};
}
export function evaluateHistoricalSessionMemory(records=[],{symbol='unknown',activeSessions=[]}={}){
 const normalizedSymbol=String(symbol||'unknown').toUpperCase(),active=new Set(activeSessions.map(s=>String(s).toLowerCase()));
 const matching=(Array.isArray(records)?records:[]).filter(r=>String(r.symbol||'unknown').toUpperCase()===normalizedSymbol&&String(r.session||'').split('+').some(s=>active.has(s.trim().toLowerCase()))&&['win','loss','breakeven'].includes(r.outcome));
 const wins=matching.filter(r=>r.outcome==='win').length,losses=matching.filter(r=>r.outcome==='loss').length,breakevens=matching.filter(r=>r.outcome==='breakeven').length;
 const returns=matching.filter(r=>r.returnR!==null&&r.returnR!==undefined&&r.returnR!=='').map(r=>Number(r.returnR)).filter(Number.isFinite),averageR=returns.length?returns.reduce((sum,v)=>sum+v,0)/returns.length:null,winRate=matching.length?wins/matching.length*100:null;
 const enough=matching.length>=8&&returns.length>=5;
 const adjustment=enough?clamp((winRate-50)*.08+(averageR||0)*.8,-4,4):0;
 return {status:enough?'ready':'insufficient',sampleCount:matching.length,wins,losses,breakevens,winRate:winRate===null?null:round(winRate,2),averageR:averageR===null?null:round(averageR,3),adjustment:round(adjustment,2),minimumSample:8,minimumReturnSamples:5,matchingSessionNames:[...active]};
}

export function evaluateAlphaSignal(input={}, now=Date.now()) {
  const symbol=String(input.symbol||'').trim().toUpperCase(),exchange=String(input.exchange||'').trim().toLowerCase(),timeframe=String(input.timeframe||'');
  if(!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(symbol)) throw new Error('Use a normalized BASE/QUOTE symbol such as BTC/USDT.');
  if(!/^[a-z0-9_-]{2,30}$/.test(exchange)) throw new Error('A valid exchange identifier is required.');
  const tf=timeframeMs(timeframe);if(!tf)throw new Error('Unsupported timeframe.');
  const candles=normalizeAlphaCandles(input.candles,timeframe,now),last=candles.at(-1),config=canonicalConfig(input.config),account=input.account||{},limits=input.limits||{},quoteCurrency=symbol.split('/')[1],eventRisk=input.eventRisk||null;
  const marketHash=sha(candles),configHash=sha(config),riskHash=sha({account,limits}),evidence=buildEvidence(candles);
  const sessionForecast=sessionForecastAdjustment(candles,{symbol,timeframe,now,baseConfidence:50});
  const sessionSweeps=detectSessionLiquiditySweeps(candles,{now});
  const sessionSetups=classifySessionSetups(candles,{now,symbol,historicalOutcomes:input.sessionMemory});
  const gainzAlpha=analyzeGainzAlphaInspired(candles,{now,symbol,timeframe,historicalOutcomes:input.sessionMemory});
  const smcIntelligence=analyzeSMC(candles,{swingLength:3,rangeLookback:80});
  const setupWeight=sessionSetups.selected?.modelWeight||0;
  const alphaWeight=gainzAlpha.signal!=='WAIT'&&gainzAlpha.setup?.phase==='displacement-confirmed' ? .08 : 0;
  const smcWeight=smcIntelligence.status==='ready'&&smcIntelligence.setup ? .06 : 0;
  const totalAdaptiveWeight=clamp(setupWeight+alphaWeight+smcWeight,0,.24);
  if(totalAdaptiveWeight>0){
    evidence.models=evidence.models.map(model=>({...model,weight:round(model.weight*(1-totalAdaptiveWeight),4)}));
    if(setupWeight>0)evidence.models.push({id:'session_setup',label:'Session sweep-reclaim-displacement',weight:setupWeight,direction:sessionSetups.selected.direction==='bullish'?1:-1,evidence:'Confirmed session sweep-reclaim-displacement with session expectancy weighting.'});
    if(alphaWeight>0)evidence.models.push({id:'gainz_alpha_setup',label:'Adaptive sweep and confluence',weight:alphaWeight,direction:gainzAlpha.signal==='BUY'?1:-1,evidence:'Closed-candle sweep-reclaim-displacement plus trend, momentum, volume and FVG confluence.'});
    if(smcWeight>0)evidence.models.push({id:'smc_setup',label:'Smart Money Concepts confluence',weight:smcWeight,direction:smcIntelligence.setup.side==='BUY'?1:-1,evidence:'SMC liquidity sweep, market structure, range location and active FVG confluence.'});
    evidence.score=round(evidence.models.reduce((sum,model)=>sum+model.direction*model.weight,0),5);
    evidence.direction=evidence.score>=.18?'buy':evidence.score<=-.18?'sell':'neutral';
    const active=evidence.models.filter(model=>model.direction!==0),agreeing=active.filter(model=>model.direction===(evidence.direction==='buy'?1:evidence.direction==='sell'?-1:0)).length;
    evidence.directionalAgreement=active.length?agreeing/active.length:0;
    evidence.confidence=round(clamp(50+Math.abs(evidence.score)*48+(evidence.directionalAgreement-.5)*12,0,95),2);
  }
  // GainzAlpha core: structured evidence, collision detection against the existing ensemble, suppression and expectancy weighting.
  const gainzCore=(()=>{try{return analyzeGainzAlpha(candles,{symbol,exchange,timeframe,now,mode:'confirmed',preset:input.gainzPreset||'balanced',outcomes:Array.isArray(input.gainzOutcomes)?input.gainzOutcomes:[],model:input.gainzModel||null,higherTimeframes:Array.isArray(input.higherTimeframes)?input.higherTimeframes:[]});}catch(error){return {status:'error',reason:error.message,signal:'WAIT'};}})();
  const gainzEvidence=toAlphaEvidence(gainzCore);
  const ensembleSignal=evidence.direction==='buy'?'BUY':evidence.direction==='sell'?'SELL':'WAIT';
  const collision=gainzCore.status==='ready'?detectCollisions([{source:'jpti-alpha-ensemble',symbol,timeframe,direction:ensembleSignal,candleTs:last.timestamp,confirmed:true},{source:'gainz-alpha-core',symbol,timeframe,direction:gainzCore.signal,candleTs:last.timestamp,confirmed:true,setupDirection:gainzCore.setup&&['DISPLACEMENT_CONFIRMED','ENTRY_READY'].includes(gainzCore.setup.state)?gainzCore.setup.direction:0}]):{conflicts:[],worst:'NONE',resolution:'proceed-with-caution',blocksSignal:false};
  const gainzWeight=gainzEvidence.available&&!gainzEvidence.suppress&&!collision.blocksSignal&&gainzEvidence.direction!==0?clamp(gainzEvidence.suggestedWeight,0,.15):0;
  if(gainzWeight>0){
    evidence.models=evidence.models.map(model=>({...model,weight:round(model.weight*(1-gainzWeight),4)}));
    evidence.models.push({id:'gainz_alpha_core',label:'GainzAlpha confluence and setup intelligence',weight:round(gainzWeight,4),direction:gainzEvidence.direction,evidence:'Stage '+gainzEvidence.stage+', quality '+gainzEvidence.setupQuality+', confluence '+gainzEvidence.confluence+(gainzEvidence.expectancy==null?', expectancy sample too small':', expectancy '+gainzEvidence.expectancy+'R (n='+gainzEvidence.sampleSize+')')+'.'});
    evidence.score=round(evidence.models.reduce((sum,model)=>sum+model.direction*model.weight,0),5);
    evidence.direction=evidence.score>=.18?'buy':evidence.score<=-.18?'sell':'neutral';
    const activeModels=evidence.models.filter(model=>model.direction!==0),agreeingModels=activeModels.filter(model=>model.direction===(evidence.direction==='buy'?1:evidence.direction==='sell'?-1:0)).length;
    evidence.directionalAgreement=activeModels.length?agreeingModels/activeModels.length:0;
    evidence.confidence=round(clamp(50+Math.abs(evidence.score)*48+(evidence.directionalAgreement-.5)*12,0,95),2);
  }
  const sessionBaseAdjustment=sessionForecast.status==='ready'?clamp(Number(sessionForecast.adjustment)||0,-8,8):0;
  const historicalSessionMemory=evaluateHistoricalSessionMemory(input.sessionMemory,{symbol,activeSessions:sessionForecast.activeSessions||[]});
  const sessionAdjustment=clamp(sessionBaseAdjustment+historicalSessionMemory.adjustment,-10,10);
  const sessionAdjustedConfidence=round(clamp(evidence.confidence+sessionAdjustment,0,95),2);
  const baseDirectionalProbability=round(clamp(50+evidence.score*50,0,100),2);
  const sessionDirectionalProbability=round(clamp(baseDirectionalProbability+(evidence.direction==='buy'?sessionAdjustment:evidence.direction==='sell'?-sessionAdjustment:0),0,100),2);
  const quote=input.quote||{},quotePrice=Number(quote.last),quoteTime=Date.parse(String(quote.timestamp||''));
  const quoteAgeMs=Number.isFinite(quoteTime)?now-quoteTime:null,quoteValid=Number.isFinite(quotePrice)&&quotePrice>0&&quoteAgeMs!==null&&quoteAgeMs>=-5000&&quoteAgeMs<=15000;
  const candleAgeMs=now-(last.timestamp+tf);
  const entry=quoteValid?quotePrice:last.close,side=evidence.direction,stopDistance=evidence.indicators.atr14*config.atrStopMultiple;
  const stopPrice=side==='buy'?entry-stopDistance:side==='sell'?entry+stopDistance:null;
  const riskDistance=stopPrice===null?null:Math.abs(entry-stopPrice);
  const tp1=side==='buy'?entry+riskDistance*config.targetOneR:side==='sell'?entry-riskDistance*config.targetOneR:null;
  const tp2=side==='buy'?entry+riskDistance*config.targetTwoR:side==='sell'?entry-riskDistance*config.targetTwoR:null;
  const qualityChecks=[
    {id:'completed_history',passed:candles.length>=80,detail:'At least 80 completed candles were used; the active candle was excluded.'},
    {id:'candle_freshness',passed:candleAgeMs>=0&&candleAgeMs<=tf*2,detail:'The last completed OHLCV candle must be no more than two timeframe intervals old.'},
    {id:'account_quote_currency',passed:String(account.currency||'').trim().toUpperCase()===quoteCurrency,detail:'Account equity must use the instrument quote currency ('+quoteCurrency+').' },
    {id:'exposure_quote_currency',passed:Array.isArray(account.exposures)&&account.exposures.every(x=>String(x?.currency||'').trim().toUpperCase()===quoteCurrency),detail:'Every existing exposure must declare marketValue normalized to the same quote currency ('+quoteCurrency+').' },
    {id:'quote_freshness',passed:quoteValid,detail:'A positive exchange quote timestamped within 15 seconds is required.'},
    {id:'signal_direction',passed:evidence.direction!=='neutral',detail:'The ensemble must produce a directional BUY or SELL consensus.'},
    {id:'confidence_threshold',passed:sessionAdjustedConfidence>=config.minimumConfidence,detail:'Session-adjusted heuristic confidence must meet the configured minimum.'},
    {id:'model_agreement',passed:evidence.directionalAgreement>=config.minimumAgreement,detail:'Active specialist models must meet the minimum directional agreement.'},
    {id:'volatility_guard',passed:evidence.marketRegime!=='high_volatility',detail:'High-volatility regimes are blocked by the default safety policy.'},
    {id:'institutional_event_risk',passed:!eventRisk||(eventRisk.calendarAvailable!==false&&!eventRisk.policy?.blockNewEntries),detail:eventRisk?.calendarAvailable===false?'Economic calendar unavailable; event-risk preflight fails closed.':eventRisk?.policy?.blockNewEntries?'Institutional event/volatility policy blocks new paper entries.':'No institutional event-risk block detected.'},
    {id:'gainz_alpha_conflict',passed:!collision.blocksSignal&&!(gainzEvidence.available&&gainzEvidence.suppress),detail:collision.blocksSignal?'Critical conflict between the Alpha ensemble and GainzAlpha ('+collision.conflicts.map(c=>c.rule).join(', ')+'); standing aside rather than choosing the higher score.':gainzEvidence.available&&gainzEvidence.suppress?'GainzAlpha suppressed this setup (invalidated or reliably negative historical expectancy).':'No blocking GainzAlpha conflict or suppression.'},
    {id:'valid_stop_geometry',passed:stopPrice>0&&riskDistance>0&&tp1>0&&tp2>0,detail:'ATR-based stop and target levels must all be positive and geometrically valid.'}
  ];
  const equity=Number(account.equity),maxNotional=Number(limits.maxOrderNotional);
  const eventRiskMultiplier=eventRisk?.policy?.reduceNewRisk?0.5:1;
  const riskBudget=Number.isFinite(equity)&&equity>0?equity*config.riskPercent/100*eventRiskMultiplier:null;
  const rawQty=riskDistance>0&&riskBudget!==null?riskBudget/riskDistance:null;
  const quantity=rawQty!==null&&Number.isFinite(maxNotional)&&maxNotional>0?Math.min(rawQty,maxNotional/entry):null;
  let pretrade=null;
  if(side!=='neutral'&&quoteValid&&quantity>0&&stopPrice>0){
    pretrade=evaluatePretradeRisk({account,limits,order:{symbol,side,quantity,referencePrice:entry,stopPrice,quoteTimestamp:new Date(quoteTime).toISOString()}},now);
  }
  const riskChecks=pretrade?.checks||[{id:'risk_inputs',passed:false,detail:'A valid directional setup, fresh quote, account equity and positive order-notional cap are required before risk preflight.'}];
  const qualityPassed=qualityChecks.every(c=>c.passed),riskPassed=Boolean(pretrade?.permissions?.paperIntentEligible);
  const eligible=qualityPassed&&riskPassed;
  const quoteHash=sha({last:quotePrice,timestamp:quoteTime});
  const fingerprint=sha([ALPHA_ENGINE_VERSION,symbol,exchange,timeframe,last.timestamp,marketHash,quoteHash,configHash,riskHash,eventRisk?.state||'no-event-risk',eventRisk?.nextEvent?.id||'no-next-event',sessionAdjustment,historicalSessionMemory.adjustment,historicalSessionMemory.sampleCount,sessionSetups.selected?.id||'no-session-setup',sessionSetups.selected?.expectancy?.expectancy??'no-expectancy',gainzAlpha.signal,gainzAlpha.score,gainzAlpha.setup?.phase||'no-gainz-setup',gainzCore.signal,gainzCore.score??0,gainzCore.stage||'no-core-stage',collision.worst,sessionForecast.activeSessions?.join('+')||'no-session'].join('|'));
  const signalId='alpha_'+fingerprint.slice(0,32);
  return {signalId,engine:'JPTI Alpha Signal Engine',engineVersion:ALPHA_ENGINE_VERSION,generatedAt:new Date(now).toISOString(),
    market:{exchange,symbol,timeframe,quoteCurrency,lastCompletedCandleAt:new Date(last.timestamp).toISOString(),candleAgeMs,completedCandles:candles.length,referencePrice:round(entry),quoteAgeMs},
    direction:side,confidence:sessionAdjustedConfidence,baseConfidence:evidence.confidence,confidenceType:'heuristic_consensus_not_probability',sessionAdjustedProbabilityEstimate:sessionDirectionalProbability,probabilityEstimateType:'uncalibrated_heuristic',ensembleScore:evidence.score,modelAgreement:evidence.directionalAgreement,sessionIntelligence:{forecast:sessionForecast,historicalMemory:historicalSessionMemory,baseAdjustment:sessionBaseAdjustment,confidenceAdjustment:sessionAdjustment,liquiditySweeps:sessionSweeps,setupClassifier:sessionSetups,alphaSetupWeight:setupWeight,gainzAlpha,adaptiveSetupWeight:totalAdaptiveWeight,gainzAlphaCore:{result:gainzCore,evidence:gainzEvidence,collision,appliedWeight:round(gainzWeight,4)}},
    marketRegime:evidence.marketRegime,eventRisk,riskBudgetMultiplier:eventRiskMultiplier,levels:{entry:round(entry),stopLoss:stopPrice===null?null:round(stopPrice),takeProfitOne:tp1===null?null:round(tp1),takeProfitTwo:tp2===null?null:round(tp2),riskRewardOne:config.targetOneR,riskRewardTwo:config.targetTwoR,atrStopMultiple:config.atrStopMultiple},
    sizing:{riskPercent:config.riskPercent,riskBudget:riskBudget===null?null:round(riskBudget),quantity:quantity===null?null:round(quantity),notional:quantity===null?null:round(quantity*entry),method:'risk budget divided by ATR stop distance, capped by configured per-order notional'},
    evidence:{...evidence,marketDataSha256:marketHash,quoteSha256:quoteHash,configurationSha256:configHash,riskConfigurationSha256:riskHash,signalFingerprint:fingerprint,usedOnlyCompletedCandles:true,lookaheadBias:'none_in_signal_calculation'},
    inputSnapshot:{candles,quote:{last:Number.isFinite(quotePrice)?quotePrice:null,timestamp:quote.timestamp||null},config,account,limits,eventRisk,sessionAdjustment,sessionForecast,historicalSessionMemory,sessionSetups,gainzAlpha,smcIntelligence,gainzCore:{signal:gainzCore.signal,score:gainzCore.score??null,stage:gainzCore.stage||null,asOf:gainzCore.asOf||null},sha256:sha({candles,quote:{last:Number.isFinite(quotePrice)?quotePrice:null,timestamp:quote.timestamp||null},config,account,limits,eventRisk,sessionAdjustment,sessionForecast,historicalSessionMemory,sessionSetups,gainzAlpha,smcIntelligence})},
    qualityChecks,riskChecks,pretradeRisk:pretrade,decision:eligible?'paper_intent_eligible':'blocked',
    permissions:{paperIntentEligible:eligible,liveExecutionAuthorized:false,exchangeOrdersCreated:0},
    limitations:['Session-adjusted probability estimate is heuristic and requires historical calibration before predictive use.','Confidence is a deterministic consensus heuristic, not a statistically calibrated probability.','The five specialist models are deterministic technical rules, not autonomous LLM agents.','Signal evaluation uses completed OHLCV candles and a separately timestamped exchange quote.','Paper eligibility is not a live-order authorization or a profitability guarantee.']};
}
function tradeMetrics(trades) {
  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0),gp=wins.reduce((s,t)=>s+t.pnl,0),gl=Math.abs(losses.reduce((s,t)=>s+t.pnl,0)),net=trades.reduce((s,t)=>s+t.pnl,0);
  let equity=10000,peak=equity,maxDd=0;for(const t of trades){equity+=t.pnl;peak=Math.max(peak,equity);maxDd=Math.max(maxDd,(peak-equity)/peak);}
  return {trades:trades.length,wins:wins.length,losses:losses.length,winRatePercent:trades.length?round(wins.length/trades.length*100,2):null,profitFactor:gl?round(gp/gl,3):gp?null:0,netPnl:round(net,4),expectancy:trades.length?round(net/trades.length,4):null,maxDrawdownPercent:round(maxDd*100,3)};
}
export function runAlphaReplay(input={}, now=Date.now()) {
  const timeframe=input.timeframe||'1h',tf=timeframeMs(timeframe);if(!tf)throw new Error('Unsupported replay timeframe.');
  const symbol=String(input.symbol||'').trim().toUpperCase(),exchange=String(input.exchange||'').trim().toLowerCase();
  if(symbol&&(symbol.split('/').length!==2||symbol.split('/').some(part=>! /^[A-Z0-9._-]{2,20}$/.test(part))))throw new Error('Replay symbol must use BASE/QUOTE format.');
  const candles=normalizeAlphaCandles(input.candles,timeframe,now),config=canonicalConfig(input.config),feeBps=input.feeBps==null?10:Number(input.feeBps),slippageBps=input.slippageBps==null?5:Number(input.slippageBps),initialCapital=input.initialCapital==null?10000:Number(input.initialCapital);
  if(!Number.isFinite(feeBps)||feeBps<0||feeBps>100||!Number.isFinite(slippageBps)||slippageBps<0||slippageBps>100)throw new Error('Fee and slippage assumptions must be between 0 and 100 basis points.');
  if(!Number.isFinite(initialCapital)||initialCapital<=0)throw new Error('Initial capital must be positive.');
  const trades=[],split=Math.floor(candles.length*.7);let capital=initialCapital,activeUntil=0;
  for(let i=79;i<candles.length-1;i++){
    if(i<activeUntil)continue;
    const window=candles.slice(0,i+1),analysis=buildEvidence(window),last=candles[i];
    if(analysis.direction==='neutral'||analysis.confidence<config.minimumConfidence||analysis.directionalAgreement<config.minimumAgreement||analysis.marketRegime==='high_volatility')continue;
    const side=analysis.direction,entryBar=candles[i+1],entry=entryBar.open,stopDistance=analysis.indicators.atr14*config.atrStopMultiple;
    if(!(entry>0&&stopDistance>0&&stopDistance<entry))continue;
    const stop=side==='buy'?entry-stopDistance:entry+stopDistance,target=side==='buy'?entry+stopDistance*config.targetTwoR:entry-stopDistance*config.targetTwoR;
    const riskBudget=capital*config.riskPercent/100,qty=Math.min(riskBudget/stopDistance,capital*.95/entry);
    if(!(qty>0))continue;
    const entryFill=entry*(side==='buy'?1+slippageBps/10000:1-slippageBps/10000),entryFee=entryFill*qty*feeBps/10000;
    let exitPrice=null,exitIndex=null,exitReason='max_holding_period';
    const maxHold=Math.min(candles.length-1,i+49);
    for(let j=i+1;j<=maxHold;j++){
      const bar=candles[j],stopHit=side==='buy'?bar.low<=stop:bar.high>=stop,targetHit=side==='buy'?bar.high>=target:bar.low<=target;
      if(stopHit){exitPrice=stop;exitIndex=j;exitReason='stop_loss';break;}
      if(targetHit){exitPrice=target;exitIndex=j;exitReason='take_profit_2';break;}
    }
    if(exitPrice===null){exitIndex=maxHold;exitPrice=candles[maxHold].close;}
    const exitFill=exitPrice*(side==='buy'?1-slippageBps/10000:1+slippageBps/10000),gross=(exitFill-entryFill)*qty*(side==='buy'?1:-1),fees=entryFee+exitFill*qty*feeBps/10000,pnl=gross-fees;
    const trade={side,signalAt:new Date(last.timestamp).toISOString(),entryAt:new Date(entryBar.timestamp).toISOString(),exitAt:new Date(candles[exitIndex].timestamp).toISOString(),entry:round(entryFill),exit:round(exitFill),stop:round(stop),target:round(target),quantity:round(qty),fees:round(fees),pnl:round(pnl,4),returnPercent:round(pnl/(entryFill*qty)*100,4),exitReason,split:entryBar.timestamp<candles[split].timestamp?'in_sample':'out_of_sample'};
    trades.push(trade);capital+=pnl;activeUntil=exitIndex;
  }
  const inSample=trades.filter(t=>t.split==='in_sample'),outOfSample=trades.filter(t=>t.split==='out_of_sample');
  const inputSnapshot={candles,config,feeBps,slippageBps,initialCapital,symbol:symbol||null,exchange:exchange||null,timeframe,sha256:sha({candles,config,feeBps,slippageBps,initialCapital,symbol,exchange,timeframe})};
  return {engineVersion:ALPHA_ENGINE_VERSION,generatedAt:new Date(now).toISOString(),timeframe,market:{symbol:symbol||null,exchange:exchange||null,quoteCurrency:symbol?symbol.split('/')[1]:String(input.quoteCurrency||'').toUpperCase()||null},parameters:{...config,feeBps,slippageBps,initialCapital},inputSnapshot,data:{candles:candles.length,first:new Date(candles[0].timestamp).toISOString(),last:new Date(candles.at(-1).timestamp).toISOString(),sha256:sha(candles),quoteCurrency:symbol?symbol.split('/')[1]:String(input.quoteCurrency||'').toUpperCase()||null,chronological:true,completedCandlesOnly:true},
    overall:{...tradeMetrics(trades),endingCapital:round(initialCapital+trades.reduce((s,t)=>s+t.pnl,0),4)},inSample:tradeMetrics(inSample),outOfSample:tradeMetrics(outOfSample),
    trades:trades.slice(-500),validation:{split:'chronological 70/30 by entry candle',outOfSampleUsedForParameterSelection:false,fill:'next candle open',intrabarAmbiguity:'stop is assumed to execute first if stop and target are both touched in one candle',overlappingPositions:false},
    limitations:['Single instrument, long/short simulation with one open position at a time.','No exchange order-book queue, partial fills, market impact, funding, leverage or liquidation model.','Fixed fee and slippage assumptions; actual venue costs may differ.','OHLCV intrabar ordering is unknown; conservative stop-first handling is used.','Historical replay is not proof of future profitability or a production promotion certificate.']};
}
async function persistEvent(kind,source,eventType,externalId,payload,occurredAt=new Date().toISOString()){
 return appendStoredEvent({kind,source,eventType,externalId,occurredAt,payload});
}
export function evaluatePaperExit(intent,markPrice){
 const price=Number(markPrice);if(!Number.isFinite(price)||price<=0)throw new Error('Paper mark price must be positive.');
 if(intent.direction==='buy'){if(price<=intent.stopLoss)return 'stop_loss';if(price>=intent.takeProfitTwo)return 'take_profit_2';}
 else if(intent.direction==='sell'){if(price>=intent.stopLoss)return 'stop_loss';if(price<=intent.takeProfitTwo)return 'take_profit_2';}
 else throw new Error('Paper trade direction is invalid.');
 return null;
}
function protectedRoute(handler){return async(req,res)=>{try{requirePrivateApiAuth(req);await handler(req,res);}catch(error){res.status(error.status||400).json({error:error.message||'Alpha Signal Engine request failed.'});}};}
alphaSignalRouter.get('/gainz/outcomes',protectedRoute(async(req,res)=>{
 const records=await loadGainzOutcomes({symbol:req.query.symbol||null,timeframe:req.query.timeframe||null,limit:Number(req.query.limit)||5000});
 res.set('Cache-Control','no-store').json({records,count:records.length});
}));
alphaSignalRouter.post('/gainz/outcomes',protectedRoute(async(req,res)=>{
 const result=await saveGainzOutcomes((req.body||{}).records);
 res.status(result.saved?201:200).set('Cache-Control','no-store').json({ok:true,...result});
}));
alphaSignalRouter.post('/evaluate',protectedRoute(async(req,res)=>{
 const input=req.body||{};
 let eventRisk=null;
 if(input.exchange&&input.symbol){
  try{eventRisk=await withExchange(input.exchange,{privateAccess:false},client=>assessExchangeEventRisk(client,input.symbol,'5m'));}
  catch(error){eventRisk={state:'UNKNOWN',calendarAvailable:false,policy:{blockNewEntries:true,reduceNewRisk:true,closeExistingPositions:false},note:'Institutional risk service unavailable: '+error.message};}
 }
 const sessionEvents=await readStoredEvents(2000,'session-outcome'),sessionMemory=sessionEvents.map(e=>e.payload?.record||e.record||e).filter(r=>r&&['win','loss','breakeven'].includes(r.outcome));
 const result=evaluateAlphaSignal({...input,eventRisk,sessionMemory}),existing=await readStoredEvents(10000,'alpha-signal-evaluation');
 if(!existing.some(e=>e.payload?.signalId===result.signalId))await persistEvent('alpha-signal-evaluation','jpti-alpha-signal-engine','signal_evaluated',result.signalId,result,result.generatedAt);
 res.json({...result,persisted:true,duplicateEvaluation:existing.some(e=>e.payload?.signalId===result.signalId)});
}));
alphaSignalRouter.post('/replay',protectedRoute(async(req,res)=>{
 const result=runAlphaReplay(req.body||{}),id=sha([result.inputSnapshot.sha256,result.parameters,result.timeframe,result.market].join('|'));
 await persistEvent('alpha-signal-replay','jpti-alpha-signal-engine','replay_completed',id,{id,...result},result.generatedAt);
 res.json({id,...result,persisted:true});
}));
export function evaluateAlphaPromotionReadiness({trades=[],replays=[],quoteCurrency,now=Date.now()}={}){
 const currency=String(quoteCurrency||'').trim().toUpperCase();if(!/^[A-Z0-9]{2,10}$/.test(currency))throw new Error('A valid quoteCurrency is required for promotion assessment.');
 const closed=trades.filter(t=>t.status==='closed'&&t.close&&String(t.market?.quoteCurrency||t.market?.symbol?.split('/')?.[1]||'').toUpperCase()===currency).sort((a,b)=>Date.parse(a.close.closedAt)-Date.parse(b.close.closedAt));
 const wins=closed.filter(t=>Number(t.close.netPnl)>0),losses=closed.filter(t=>Number(t.close.netPnl)<0),grossProfit=wins.reduce((s,t)=>s+Number(t.close.netPnl),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+Number(t.close.netPnl),0)),net=closed.reduce((s,t)=>s+Number(t.close.netPnl),0);
 const profitFactor=grossLoss>0?grossProfit/grossLoss:null,expectancy=closed.length?net/closed.length:null;
 let equity=10000,peak=equity,maxDrawdown=0;for(const t of closed){equity+=Number(t.close.netPnl);peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);}
 const first=closed[0]?.close?.closedAt,last=closed.at(-1)?.close?.closedAt,sampleDays=first&&last?Math.max(0,(Date.parse(last)-Date.parse(first))/86400000):0;
 const traceable=closed.length>0&&closed.every(t=>Boolean(t.signalId&&t.signalFingerprint&&t.close.signalId===t.signalId&&t.liveExecutionAuthorized===false&&t.close.liveExecutionAuthorized===false));
 const eligibleReplays=replays.filter(r=>String(r.data?.quoteCurrency||r.market?.quoteCurrency||'').toUpperCase()===currency).sort((a,b)=>Date.parse(b.generatedAt)-Date.parse(a.generatedAt));
 const latestReplay=eligibleReplays[0]||null,oos=latestReplay?.outOfSample;
 const checks=[
  {id:'paper_sample_size',passed:closed.length>=30,actual:closed.length,required:30,detail:'At least 30 closed paper trades are required.'},
  {id:'paper_observation_period',passed:sampleDays>=14,actual:round(sampleDays,2),required:14,detail:'Closed paper results must span at least 14 calendar days.'},
  {id:'profit_factor',passed:profitFactor!==null&&profitFactor>=1.2,actual:profitFactor===null?null:round(profitFactor,3),required:1.2,detail:'Realized profit factor must be at least 1.20.'},
  {id:'positive_expectancy',passed:expectancy!==null&&expectancy>0,actual:expectancy===null?null:round(expectancy,4),required:'> 0',detail:'Average realized net PnL per closed trade must be positive.'},
  {id:'drawdown_control',passed:maxDrawdown*100<=10,actual:round(maxDrawdown*100,3),required:10,detail:'Sequential realized paper-equity drawdown must not exceed 10% of the 10,000 quote-currency reference book.'},
  {id:'trade_traceability',passed:traceable,actual:closed.length,required:'all trades fingerprinted',detail:'Every closed paper trade must trace to its evaluated signal fingerprint and remain paper-only.'},
  {id:'out_of_sample_replay',passed:Boolean(oos&&oos.trades>=10&&oos.netPnl>0&&oos.profitFactor!==null&&oos.profitFactor>=1.1),actual:oos?{trades:oos.trades,netPnl:oos.netPnl,profitFactor:oos.profitFactor}:null,required:'10+ OOS trades, positive PnL, PF >= 1.10',detail:'A same-quote-currency chronological out-of-sample replay must show at least 10 trades, positive PnL and PF >= 1.10.'}
 ];
 const failedChecks=checks.filter(c=>!c.passed).map(c=>c.id),eligible=failedChecks.length===0;
 return {generatedAt:new Date(now).toISOString(),quoteCurrency:currency,decision:eligible?'candidate_for_independent_governance_review':'blocked',metrics:{closedTrades:closed.length,wins:wins.length,losses:losses.length,winRatePercent:closed.length?round(wins.length/closed.length*100,2):null,grossProfit:round(grossProfit,4),grossLoss:round(grossLoss,4),netPnl:round(net,4),profitFactor:profitFactor===null?null:round(profitFactor,3),expectancy:expectancy===null?null:round(expectancy,4),maxDrawdownPercent:round(maxDrawdown*100,3),sampleDays:round(sampleDays,2)},checks,failedChecks,
  permissions:{eligibleForIndependentGovernanceReview:eligible,productionExecutionAuthorized:false,liveExecutionAuthorized:false,ordersCreated:0},
  note:'Passing this evidence gate only makes the strategy a candidate for separate human governance review. It does not certify profitability, authorize production or live trading, or bypass JPTI strategy-registry and institutional-governance controls.',
  limitations:['Metrics are calculated for one quote currency at a time; convert exposures and PnL before comparing currencies.','Drawdown uses a fixed 10,000 quote-currency reference book and realized closed-trade PnL; it is not account equity drawdown.','The replay must be independently representative and sufficiently broad; this gate does not guarantee future results.']};
}

alphaSignalRouter.get('/replays',protectedRoute(async(req,res)=>{
 const events=await readStoredEvents(100,'alpha-signal-replay'),includeSnapshot=String(req.query.includeSnapshot||'').toLowerCase()==='true';
 res.json({count:events.length,replays:events.map(e=>{const payload={...e.payload};if(!includeSnapshot)delete payload.inputSnapshot;return payload;}).reverse(),snapshotsIncluded:includeSnapshot,liveExecutionAuthorized:false});
}));
alphaSignalRouter.get('/history',protectedRoute(async(_req,res)=>{
 const events=await readStoredEvents(500,'alpha-signal-evaluation');
 const includeSnapshot=String(_req.query.includeSnapshot||'').toLowerCase()==='true';
 res.json({count:events.length,signals:events.map(e=>{const payload={...e.payload};if(!includeSnapshot)delete payload.inputSnapshot;return payload;}).reverse(),snapshotsIncluded:includeSnapshot,liveExecutionAuthorized:false});
}));
alphaSignalRouter.post('/paper/intent',protectedRoute(async(req,res)=>{
 const signalId=String(req.body?.signalId||'');if(!/^alpha_[a-f0-9]{32}$/.test(signalId))throw new Error('A valid evaluated Alpha signalId is required.');
 const signals=await readStoredEvents(10000,'alpha-signal-evaluation'),signal=signals.find(e=>e.payload?.signalId===signalId)?.payload;
 if(!signal)throw new Error('Signal not found in persisted evaluation history.');
 if(signal.decision!=='paper_intent_eligible'||!signal.permissions?.paperIntentEligible||signal.permissions?.liveExecutionAuthorized)throw new Error('Only a risk-approved paper-eligible signal can create a paper intent.');
 const intents=await readStoredEvents(10000,'alpha-paper-intent');
 const existing=intents.find(e=>e.payload?.signalId===signalId);
 if(existing){res.json({...existing.payload,duplicate:true,liveExecutionAuthorized:false});return;}
 if(Date.now()-Date.parse(signal.generatedAt)>60000)throw new Error('Signal has expired for paper entry. Generate a fresh assessment before creating a paper intent.');
 const intent={tradeId:randomUUID(),signalId,createdAt:new Date().toISOString(),status:'open',market:signal.market,direction:signal.direction,entry:signal.levels.entry,stopLoss:signal.levels.stopLoss,takeProfitOne:signal.levels.takeProfitOne,takeProfitTwo:signal.levels.takeProfitTwo,quantity:signal.sizing.quantity,notional:signal.sizing.notional,confidence:signal.confidence,engineVersion:signal.engineVersion,signalFingerprint:signal.evidence.signalFingerprint,liveExecutionAuthorized:false,exchangeOrdersCreated:0};
 await persistEvent('alpha-paper-intent','jpti-alpha-paper','paper_intent_opened',intent.tradeId,intent,intent.createdAt);
 res.status(201).json({...intent,persisted:true});
}));
alphaSignalRouter.post('/paper/mark',protectedRoute(async(req,res)=>{
 const tradeId=String(req.body?.tradeId||''),markPrice=Number(req.body?.markPrice),quoteTime=Date.parse(String(req.body?.quoteTimestamp||'')),now=Date.now(),quoteAgeMs=Number.isFinite(quoteTime)?now-quoteTime:null;
 if(!/^[0-9a-f-]{36}$/i.test(tradeId)||!Number.isFinite(markPrice)||markPrice<=0||quoteAgeMs===null||quoteAgeMs< -5000||quoteAgeMs>15000)throw new Error('Paper mark requires a valid trade, positive price and quote timestamp no older than 15 seconds.');
 const intents=await readStoredEvents(10000,'alpha-paper-intent'),intent=intents.find(e=>e.payload?.tradeId===tradeId)?.payload;
 if(!intent)throw new Error('Paper trade was not found.');
 const closes=await readStoredEvents(10000,'alpha-paper-close');
 if(closes.some(e=>e.payload?.tradeId===tradeId)){res.json({status:'closed',close:closes.find(e=>e.payload?.tradeId===tradeId).payload,duplicate:true});return;}
 const trigger=evaluatePaperExit(intent,markPrice);
 if(trigger){
  const feeBps=req.body?.feeBps==null?10:Number(req.body.feeBps),slippageBps=req.body?.slippageBps==null?5:Number(req.body.slippageBps);
  if(!Number.isFinite(feeBps)||feeBps<0||feeBps>100||!Number.isFinite(slippageBps)||slippageBps<0||slippageBps>100)throw new Error('Paper monitoring fee and slippage assumptions must be between 0 and 100 basis points.');
  const direction=intent.direction==='buy'?1:-1,exitPrice=markPrice*(direction===1?1-slippageBps/10000:1+slippageBps/10000),fees=exitPrice*intent.quantity*feeBps/10000,gross=(exitPrice-intent.entry)*intent.quantity*direction;
  const close={tradeId,signalId:intent.signalId,closedAt:new Date(now).toISOString(),exitPrice:round(exitPrice),markPrice:round(markPrice),fees:round(fees),grossPnl:round(gross,6),netPnl:round(gross-fees,6),returnPercent:round((gross-fees)/(intent.entry*intent.quantity)*100,4),reason:trigger,quoteTimestamp:new Date(quoteTime).toISOString(),liveExecutionAuthorized:false,exchangeOrdersCreated:0};
  await persistEvent('alpha-paper-close','jpti-alpha-paper','paper_trade_auto_closed',tradeId,close,close.closedAt);
  res.json({status:'closed',close,persisted:true,liveExecutionAuthorized:false});return;
 }
 const direction=intent.direction==='buy'?1:-1,unrealizedPnl=(markPrice-intent.entry)*intent.quantity*direction;
 const mark={tradeId,price:round(markPrice),quoteTimestamp:new Date(quoteTime).toISOString(),observedAt:new Date(now).toISOString(),quoteAgeMs,unrealizedPnl:round(unrealizedPnl,6),unrealizedReturnPercent:round(unrealizedPnl/(intent.entry*intent.quantity)*100,4),trigger:null};
 await persistEvent('alpha-paper-mark','jpti-alpha-paper','paper_trade_marked',tradeId+':'+quoteTime,mark,mark.observedAt);
 res.json({status:'open',mark,persisted:true,liveExecutionAuthorized:false});
}));
alphaSignalRouter.post('/paper/close',protectedRoute(async(req,res)=>{
 const tradeId=String(req.body?.tradeId||''),exitPrice=Number(req.body?.exitPrice);
 if(!/^[0-9a-f-]{36}$/i.test(tradeId)||!Number.isFinite(exitPrice)||exitPrice<=0)throw new Error('A valid paper tradeId and positive exitPrice are required.');
 const intents=await readStoredEvents(10000,'alpha-paper-intent'),intent=intents.find(e=>e.payload?.tradeId===tradeId)?.payload;
 if(!intent)throw new Error('Paper trade was not found.');
 const closes=await readStoredEvents(10000,'alpha-paper-close');
 if(closes.some(e=>e.payload?.tradeId===tradeId))throw new Error('Paper trade is already closed.');
 const fees=req.body?.fees==null?0:Number(req.body.fees);if(!Number.isFinite(fees)||fees<0||fees>intent.entry*intent.quantity*.1)throw new Error('Paper exit fees must be non-negative and no greater than 10% of entry notional.');
 const direction=intent.direction==='buy'?1:-1,gross=(exitPrice-intent.entry)*intent.quantity*direction,pnl=gross-fees;
 const close={tradeId,signalId:intent.signalId,closedAt:new Date().toISOString(),exitPrice:round(exitPrice),fees:round(fees),grossPnl:round(gross,6),netPnl:round(pnl,6),returnPercent:round(pnl/(intent.entry*intent.quantity)*100,4),reason:String(req.body?.reason||'operator_close').slice(0,80),liveExecutionAuthorized:false,exchangeOrdersCreated:0};
 await persistEvent('alpha-paper-close','jpti-alpha-paper','paper_trade_closed',tradeId,close,close.closedAt);
 res.json({...close,persisted:true});
}));
alphaSignalRouter.get('/promotion-readiness',protectedRoute(async(req,res)=>{
 const quoteCurrency=String(req.query.quoteCurrency||'').trim().toUpperCase();
 const [intents,closes,replayEvents]=await Promise.all([readStoredEvents(10000,'alpha-paper-intent'),readStoredEvents(10000,'alpha-paper-close'),readStoredEvents(1000,'alpha-signal-replay')]);
 const closed=new Map(closes.map(e=>[e.payload.tradeId,e.payload]));
 const trades=intents.map(e=>({...e.payload,close:closed.get(e.payload.tradeId)||null,status:closed.has(e.payload.tradeId)?'closed':'open'}));
 const result=evaluateAlphaPromotionReadiness({trades,replays:replayEvents.map(e=>e.payload),quoteCurrency});
 res.json(result);
}));
alphaSignalRouter.get('/paper/ledger',protectedRoute(async(_req,res)=>{
 const [intents,closes,marks]=await Promise.all([readStoredEvents(10000,'alpha-paper-intent'),readStoredEvents(10000,'alpha-paper-close'),readStoredEvents(20000,'alpha-paper-mark')]),closed=new Map(closes.map(e=>[e.payload.tradeId,e.payload])),latestMarks=new Map(marks.map(e=>[e.payload.tradeId,e.payload]));
 const trades=intents.map(e=>({...e.payload,mark:latestMarks.get(e.payload.tradeId)||null,close:closed.get(e.payload.tradeId)||null,status:closed.has(e.payload.tradeId)?'closed':'open'}));
 const realized=trades.filter(t=>t.close).reduce((s,t)=>s+t.close.netPnl,0);
 res.json({trades:trades.reverse(),summary:{total:trades.length,open:trades.filter(t=>t.status==='open').length,closed:closes.length,realizedPnl:round(realized,6),wins:trades.filter(t=>t.close?.netPnl>0).length,losses:trades.filter(t=>t.close?.netPnl<0).length},liveExecutionAuthorized:false});
}));
