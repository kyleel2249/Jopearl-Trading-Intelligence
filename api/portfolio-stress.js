import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
export const portfolioStressRouter=express.Router();
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const positive=v=>{const n=num(v);return n!==null&&n>0?n:null;};
const quantile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);const index=Math.max(0,Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1));return sorted[index];};
export function calculatePortfolioStress(input={}){
 const assets=Array.isArray(input.assets)?input.assets:[];
 if(assets.length<1||assets.length>50)throw new Error('Provide between 1 and 50 portfolio assets.');
 const symbols=assets.map(a=>String(a.symbol||'').trim().toUpperCase());
 if(symbols.some(s=>!s)||new Set(symbols).size!==symbols.length)throw new Error('Every asset must have a unique non-empty symbol.');
 const currencies=[...new Set(assets.map(a=>String(a.quoteCurrency||'').trim().toUpperCase()))];
 if(currencies.length!==1||!currencies[0])throw new Error('All positions must use one explicit quote currency.');
 const values=assets.map(a=>positive(a.marketValue));
 if(values.some(v=>v===null))throw new Error('Each asset requires a positive marketValue.');
 const returns=assets.map(a=>Array.isArray(a.returns)?a.returns.map(num):[]);
 const count=returns[0].length;
 if(count<30||returns.some(row=>row.length!==count||row.some(v=>v===null||v<=-1)))throw new Error('Each asset requires at least 30 aligned finite simple-return observations greater than -100%.');
 const gross=values.reduce((a,b)=>a+b,0),weights=values.map(v=>v/gross);
 const portfolioReturns=Array.from({length:count},(_,i)=>returns.reduce((sum,row,j)=>sum+weights[j]*row[i],0));
 const losses=portfolioReturns.map(v=>-v);
 const var95=quantile(losses,.95),var99=quantile(losses,.99);
 const es95=losses.filter(v=>v>=var95).reduce((a,b)=>a+b,0)/Math.max(1,losses.filter(v=>v>=var95).length);
 const es99=losses.filter(v=>v>=var99).reduce((a,b)=>a+b,0)/Math.max(1,losses.filter(v=>v>=var99).length);
 let equity=1,peak=1,maxDrawdown=0;
 for(const r of portfolioReturns){equity*=1+r;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);}
 const scenarios=(Array.isArray(input.scenarios)?input.scenarios:[]).slice(0,30).map(s=>{
  const shocks=s.shocks&&typeof s.shocks==='object'?s.shocks:{};
  const rows=assets.map((a,i)=>{const shock=num(shocks[symbols[i]]);if(shock===null||shock < -100||shock>100)throw new Error('Scenario '+String(s.name||'unnamed')+' requires a shock from -100% to +100% for '+symbols[i]+'.');return {symbol:symbols[i],shockPercent:shock,estimatedPnl:values[i]*shock/100};});
  return {name:String(s.name||'Unnamed scenario').slice(0,80),estimatedPnl:rows.reduce((sum,r)=>sum+r.estimatedPnl,0),lossPercent:-rows.reduce((sum,r)=>sum+r.estimatedPnl,0)/gross*100,positions:rows};
 });
 return {generatedAt:new Date().toISOString(),quoteCurrency:currencies[0],grossExposure:gross,observations:count,
  historical:{var95Percent:var95*100,var99Percent:var99*100,expectedShortfall95Percent:es95*100,expectedShortfall99Percent:es99*100,maxDrawdownPercent:maxDrawdown*100,meanReturnPercent:portfolioReturns.reduce((a,b)=>a+b,0)/count*100},
  positions:assets.map((a,i)=>({symbol:symbols[i],marketValue:values[i],weightPercent:weights[i]*100,quoteCurrency:currencies[0]})),
  scenarios,limitations:['Historical VaR and expected shortfall are estimates from supplied aligned return samples, not loss limits.','Scenario shocks are deterministic user-supplied assumptions, not forecasts.','No derivatives margin, liquidation, funding, borrow cost, FX conversion, slippage or liquidity impact is modeled.','Market values and returns are supplied by the caller and are not independently verified.']};
}
portfolioStressRouter.post('/risk/stress',async(req,res)=>{
 try{requirePrivateApiAuth(req);const result=calculatePortfolioStress(req.body||{});const id=randomUUID();await appendStoredEvent({kind:'portfolio-stress-assessment',source:'jpti-portfolio-risk',eventType:'stress_assessment',externalId:id,occurredAt:result.generatedAt,payload:{id,...result}});res.json({id,...result,persisted:true,executionAuthorized:false});}
 catch(error){res.status(error.status||400).json({error:error.message||'Portfolio stress assessment failed.'});}
});
