import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';

export const allocationRouter=express.Router();
const finite=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));

function projectBoundedSimplex(values,mins,maxs){
 let lo=Math.min(...values.map((v,i)=>v-maxs[i])),hi=Math.max(...values.map((v,i)=>v-mins[i]));
 for(let n=0;n<100;n++){
  const mid=(lo+hi)/2,sum=values.reduce((s,v,i)=>s+clamp(v-mid,mins[i],maxs[i]),0);
  if(sum>1)lo=mid;else hi=mid;
 }
 const out=values.map((v,i)=>clamp(v-(lo+hi)/2,mins[i],maxs[i]));
 const sum=out.reduce((a,b)=>a+b,0);
 if(Math.abs(sum-1)>1e-7)throw new Error('Allocation constraints cannot be projected to a fully invested portfolio.');
 return out;
}
function covarianceMatrix(series){
 const n=series.length,k=series[0].length,means=series.map(row=>row.reduce((a,b)=>a+b,0)/k);
 return series.map((a,i)=>series.map((b,j)=>a.reduce((s,x,t)=>s+(x-means[i])*(b[t]-means[j]),0)/(k-1)));
}
function portfolioVariance(weights,cov){
 return weights.reduce((sum,wi,i)=>sum+wi*weights.reduce((inner,wj,j)=>inner+wj*cov[i][j],0),0);
}

export function calculateRiskParityAllocation(input={}){
 const assets=Array.isArray(input.assets)?input.assets:[];
 if(assets.length<2||assets.length>20)throw new Error('Provide between 2 and 20 assets.');
 const symbols=assets.map(a=>String(a.symbol||'').trim().toUpperCase());
 if(symbols.some(s=>!s)||new Set(symbols).size!==symbols.length)throw new Error('Each asset requires a unique, non-empty symbol.');
 const currencies=[...new Set(assets.map(a=>String(a.quoteCurrency||'').trim().toUpperCase()))];
 if(currencies.length!==1||!currencies[0])throw new Error('All assets must share one explicit quote currency. Cross-currency allocation is not supported.');
 const series=assets.map(a=>Array.isArray(a.returns)?a.returns.map(finite):[]);
 const observations=series[0].length;
 if(observations<30||series.some(row=>row.length!==observations||row.some(v=>v===null)))throw new Error('Each asset requires at least 30 aligned finite return observations.');
 const mins=assets.map(a=>finite(a.minWeight)??0),maxs=assets.map(a=>finite(a.maxWeight)??.6);
 if(mins.some((v,i)=>v<0||v>1||maxs[i]<0||maxs[i]>1||v>maxs[i])||mins.reduce((a,b)=>a+b,0)>1+1e-9||maxs.reduce((a,b)=>a+b,0)<1-1e-9)throw new Error('Weight constraints are invalid or cannot sum to 100%.');
 const cov=covarianceMatrix(series),vols=cov.map((row,i)=>Math.sqrt(Math.max(0,row[i])));
 if(vols.some(v=>!Number.isFinite(v)||v<=1e-12))throw new Error('Zero or invalid volatility asset detected; risk parity is undefined for that series.');
 let weights=projectBoundedSimplex(vols.map(v=>1/v),mins,maxs),iterations=0;
 for(;iterations<1000;iterations++){
  const variance=portfolioVariance(weights,cov);
  if(!Number.isFinite(variance)||variance<=1e-16)throw new Error('Portfolio covariance matrix has no usable positive risk.');
  const marginal=cov.map(row=>row.reduce((s,c,j)=>s+c*weights[j],0));
  const contributions=weights.map((w,i)=>w*marginal[i]);
  const target=variance/assets.length;
  const adjusted=weights.map((w,i)=>w*Math.sqrt(target/Math.max(contributions[i],variance*1e-8)));
  const next=projectBoundedSimplex(adjusted,mins,maxs);
  const delta=Math.max(...next.map((w,i)=>Math.abs(w-weights[i])));
  weights=next;
  if(delta<1e-9)break;
 }
 const variance=portfolioVariance(weights,cov),portfolioVol=Math.sqrt(Math.max(0,variance));
 const marginal=cov.map(row=>row.reduce((s,c,j)=>s+c*weights[j],0));
 const components=weights.map((w,i)=>w*marginal[i]);
 const total=components.reduce((a,b)=>a+b,0);
 const periodsPerYear=clamp(Number(input.periodsPerYear)||252,1,10000);
 const expectedReturns=assets.map(a=>finite(a.expectedReturn));
 const expectedReturn=expectedReturns.every(v=>v!==null)?weights.reduce((s,w,i)=>s+w*expectedReturns[i],0):null;
 const rows=assets.map((asset,i)=>({symbol:String(asset.symbol||'').toUpperCase(),exchange:String(asset.exchange||'').toLowerCase()||null,
  quoteCurrency:currencies[0],weight:weights[i],weightPercent:weights[i]*100,assetVolatilityPerPeriod:vols[i],
  riskContributionPercent:total>0?components[i]/total*100:null,expectedReturnPerPeriod:expectedReturns[i]}));
 const hhi=weights.reduce((s,w)=>s+w*w,0);
 return {generatedAt:new Date().toISOString(),method:'long-only covariance-aware equal-risk-contribution allocation with bounded-simplex projection',
  quoteCurrency:currencies[0],observations,periodsPerYear,iterations:iterations+1,weights:rows,
  portfolioVolatilityPerPeriod:portfolioVol,annualizedVolatilityPercent:portfolioVol*Math.sqrt(periodsPerYear)*100,
  expectedReturnPerPeriod:expectedReturn,annualizedExpectedReturnPercent:expectedReturn===null?null:expectedReturn*periodsPerYear*100,
  diversificationRatio:portfolioVol>0?weights.reduce((s,w,i)=>s+w*vols[i],0)/portfolioVol:null,
  concentration:{herfindahlIndex:hhi,effectivePositions:hhi>0?1/hhi:0},
  riskContributionsSumPercent:rows.reduce((s,r)=>s+(r.riskContributionPercent||0),0),
  limitations:['Assumes aligned return observations from the same sampling interval.','Annualization assumes periodsPerYear is appropriate for the supplied series.','Long-only weights; no shorting, leverage, transaction costs, taxes, liquidity constraints or market impact.','Historical covariance is unstable and is not a forecast or a guarantee of future risk.','Assets are optimized only within one quote currency; no FX conversion is inferred.']};
}

allocationRouter.post('/allocation/risk-parity',async(req,res)=>{
 try{
  requirePrivateApiAuth(req);
  const result=calculateRiskParityAllocation(req.body||{});
  const id=randomUUID();
  await appendStoredEvent({kind:'portfolio-allocation-recommendation',source:'jpti-allocation-engine',eventType:'allocation_calculated',externalId:id,occurredAt:result.generatedAt,payload:{id,...result}});
  res.json({id,...result,persisted:true,executionAuthorized:false,ordersCreated:0});
 }catch(error){res.status(error.status||400).json({error:error.message||'Allocation calculation failed.'});}
});
