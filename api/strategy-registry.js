import express from 'express';
import { createHash,randomUUID } from 'node:crypto';
import { appendStoredEvent,readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
export const strategyRegistryRouter=express.Router();
const idPattern=/^[a-z][a-z0-9_-]{2,47}$/;
const versionPattern=/^\d+\.\d+\.\d+$/;
const canonical=value=>JSON.stringify(value,Object.keys(value||{}).sort());
export function validateStrategyDefinition(input={}){
 const strategyId=String(input.strategyId||'').trim().toLowerCase(),version=String(input.version||'').trim();
 if(!idPattern.test(strategyId))throw new Error('strategyId must be 3–48 lowercase letters, numbers, underscores or hyphens and start with a letter.');
 if(!versionPattern.test(version))throw new Error('Strategy version must use semantic MAJOR.MINOR.PATCH.');
 const assetClasses=Array.isArray(input.assetClasses)?[...new Set(input.assetClasses.map(x=>String(x).trim().toLowerCase()))]:[];
 const timeframes=Array.isArray(input.timeframes)?[...new Set(input.timeframes.map(x=>String(x).trim().toLowerCase()))]:[];
 if(!assetClasses.length||assetClasses.length>20||assetClasses.some(x=>! /^[a-z0-9_-]{2,32}$/.test(x)))throw new Error('Provide 1–20 valid asset classes.');
 if(!timeframes.length||timeframes.length>20||timeframes.some(x=>! /^(1m|3m|5m|15m|30m|1h|2h|4h|6h|12h|1d|1w)$/.test(x)))throw new Error('Provide 1–20 supported timeframes.');
 if(!input.rules||typeof input.rules!=='object'||Array.isArray(input.rules)||Object.keys(input.rules).length>40)throw new Error('A bounded strategy rules object is required.');
 if(!input.riskPolicy||typeof input.riskPolicy!=='object'||Array.isArray(input.riskPolicy))throw new Error('A strategy-specific riskPolicy object is required.');
 const body={strategyId,version,name:String(input.name||strategyId).slice(0,80),description:String(input.description||'').slice(0,500),assetClasses,timeframes,rules:input.rules,riskPolicy:input.riskPolicy,author:String(input.author||'local-operator').slice(0,80)};
 const checksum=createHash('sha256').update(JSON.stringify(body)).digest('hex');
 return {...body,checksum,immutable:true,executionMode:'paper_review_only'};
}
export function evaluateStrategyPromotion(evidence={}){
 const closed=Number(evidence.closedTrades),pf=Number(evidence.profitFactor),drawdown=Number(evidence.maxDrawdownPercent),oos=Number(evidence.outOfSampleReturnPercent),wf=Number(evidence.walkForwardPositiveWindows),windows=Number(evidence.walkForwardWindows);
 const checks=[
  {id:'sample_size',passed:Number.isInteger(closed)&&closed>=30,detail:'At least 30 closed paper trades.'},
  {id:'profit_factor',passed:Number.isFinite(pf)&&pf>=1.2,detail:'Profit factor must be at least 1.20.'},
  {id:'drawdown',passed:Number.isFinite(drawdown)&&drawdown>=0&&drawdown<=10,detail:'Maximum drawdown must be no more than 10%.'},
  {id:'out_of_sample',passed:Number.isFinite(oos)&&oos>0,detail:'Out-of-sample return must be positive.'},
  {id:'walk_forward',passed:Number.isInteger(windows)&&windows>=3&&Number.isInteger(wf)&&wf>=Math.ceil(windows*.6),detail:'At least 60% of three or more walk-forward windows must be positive.'},
  {id:'data_quality',passed:evidence.staleEvidence!==true&&evidence.dataQuality==='verified',detail:'Evidence must be verified and not stale.'},
  {id:'risk_controls',passed:evidence.riskControlsPassed===true,detail:'Risk-control tests must pass.'}
 ];
 const passed=checks.every(c=>c.passed);
 return {reviewStatus:passed?'paper_promotion_candidate':'rejected_or_incomplete',checks,failedChecks:checks.filter(c=>!c.passed).map(c=>c.id),
  permissions:{paperTrialEligible:passed,livePromotionAuthorized:false,liveExecutionAuthorized:false},note:'Passing criteria nominates a strategy for controlled paper-trial review only. It does not authorize live deployment.'};
}
strategyRegistryRouter.get('/registry',async(req,res)=>{
 try{requirePrivateApiAuth(req);const events=await readStoredEvents(20000,'strategy-registry-version');const versions=events.filter(e=>e.source==='jpti-strategy-registry').map(e=>e.payload);res.json({count:versions.length,versions});}
 catch(error){res.status(error.status||500).json({error:error.message});}
});
strategyRegistryRouter.post('/registry',async(req,res)=>{
 try{requirePrivateApiAuth(req);const definition=validateStrategyDefinition(req.body||{});const existing=await readStoredEvents(20000,'strategy-registry-version');if(existing.some(e=>e.payload?.strategyId===definition.strategyId&&e.payload?.version===definition.version))return res.status(409).json({error:'This strategy version is immutable and already exists.'});const id=randomUUID();await appendStoredEvent({kind:'strategy-registry-version',source:'jpti-strategy-registry',eventType:'version_published',externalId:id,occurredAt:new Date().toISOString(),payload:{id,...definition}});res.status(201).json({id,...definition,persisted:true});}
 catch(error){res.status(error.status||400).json({error:error.message||'Strategy version could not be published.'});}
});
strategyRegistryRouter.post('/promotion-review',async(req,res)=>{
 try{requirePrivateApiAuth(req);const strategyId=String(req.body?.strategyId||'').trim().toLowerCase(),version=String(req.body?.version||'').trim();const rows=await readStoredEvents(20000,'strategy-registry-version');const strategy=rows.map(e=>e.payload).find(p=>p?.strategyId===strategyId&&p?.version===version);if(!strategy)return res.status(404).json({error:'Immutable strategy version was not found.'});const review=evaluateStrategyPromotion(req.body?.evidence||{});const id=randomUUID();const result={id,strategyId,version,checksum:strategy.checksum,...review,reviewedAt:new Date().toISOString()};await appendStoredEvent({kind:'strategy-promotion-review',source:'jpti-strategy-registry',eventType:'promotion_reviewed',externalId:id,occurredAt:result.reviewedAt,payload:result});res.json({...result,persisted:true});}
 catch(error){res.status(error.status||400).json({error:error.message||'Strategy review failed.'});}
});
