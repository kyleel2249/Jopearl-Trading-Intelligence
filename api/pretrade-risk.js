import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { evaluateFuturesRisk } from '../src/lib/futures-risk.js';
export const pretradeRouter=express.Router();
const n=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const positive=v=>{const x=n(v);return x!==null&&x>0?x:null;};
export function evaluatePretradeRisk(input={},now=Date.now()){
 const account=input.account||{},order=input.order||{},limits=input.limits||{};
 const equity=positive(account.equity),dailyPnl=n(account.dailyPnl),maxDailyLoss=positive(limits.maxDailyLoss),maxNotional=positive(limits.maxOrderNotional),maxGross=positive(limits.maxGrossExposure),maxRiskPct=positive(limits.maxRiskPercent);
 const qty=positive(order.quantity),price=positive(order.referencePrice),stop=positive(order.stopPrice),side=String(order.side||'').toLowerCase(),symbol=String(order.symbol||'').trim().toUpperCase();
 const ts=Date.parse(String(order.quoteTimestamp||'')),age=Number.isFinite(ts)?now-ts:null,maxAge= Math.max(1000,Math.min(120000,n(limits.maxQuoteAgeMs)||15000));
 const checks=[];
 const check=(id,passed,detail)=>checks.push({id,passed:Boolean(passed),detail});
 check('account_equity',equity!==null,'A positive account equity is required.');
 const quoteCurrency=symbol.split('/')[1]||'';
 check('account_quote_currency',Boolean(quoteCurrency&&String(account.currency||'').trim().toUpperCase()===quoteCurrency),'Account equity and exposure must use the instrument quote currency ('+quoteCurrency+').');
 check('daily_pnl',dailyPnl!==null,'Daily realized PnL must be supplied.');
 check('order_fields',Boolean(symbol&&qty&&price&&stop&&['buy','sell'].includes(side)),'Symbol, quantity, reference price, stop price and side are mandatory.');
 check('quote_freshness',age!==null&&age>=-5000&&age<=maxAge,'Quote must be timestamped, not future-dated and within the configured freshness window.');
 const notional=qty&&price?qty*price:null;
 check('per_order_notional',notional!==null&&maxNotional!==null&&notional<=maxNotional,'Order notional must remain within a configured positive cap.');
 const exposures=Array.isArray(account.exposures)?account.exposures:[];
 const exposureDataValid=Array.isArray(account.exposures)&&exposures.every(x=>String(x?.symbol||'').trim()&&positive(x?.marketValue)!==null&&String(x?.currency||'').trim().toUpperCase()===quoteCurrency);
 check('account_exposures',exposureDataValid,'Existing exposure inventory must be explicitly supplied with a symbol and positive market value for every position.');
 const gross=exposures.reduce((sum,x)=>sum+(positive(x.marketValue)||0),0)+(notional||0);
 check('gross_exposure',maxGross!==null&&gross<=maxGross,'Existing plus proposed gross exposure must remain within the configured cap.');
 const stopValid=side==='buy'?stop<price:stop>price;
 const risk=stopValid&&qty&&price?Math.abs(price-stop)*qty:null;
 const riskPct=equity&&risk!==null?risk/equity*100:null;
 check('protective_stop',stopValid,'Protective stop must be below entry for buys and above entry for sells.');
 check('risk_budget',riskPct!==null&&maxRiskPct!==null&&riskPct<=maxRiskPct,'Stop-distance risk must be within the configured percentage of equity.');
 check('daily_loss_limit',dailyPnl!==null&&maxDailyLoss!==null&&dailyPnl>-maxDailyLoss,'Daily realized loss must not have breached the configured loss limit.');
 const sameSymbol=exposures.filter(x=>String(x.symbol||'').toUpperCase()===symbol).reduce((sum,x)=>sum+(positive(x.marketValue)||0),0);
 const concentration=equity?((sameSymbol+(notional||0))/equity*100):null;
 const maxConcentration=positive(limits.maxSymbolConcentrationPercent);
 check('symbol_concentration',concentration!==null&&maxConcentration!==null&&concentration<=maxConcentration,'Proposed symbol concentration must remain within its configured cap.');
 const failures=checks.filter(c=>!c.passed);
 return {id:randomUUID(),generatedAt:new Date(now).toISOString(),symbol,side,notional,riskAtStop:risk,riskPercentOfEquity:riskPct,grossExposureAfter:gross,symbolConcentrationPercent:concentration,
  quoteAgeMs:age,checks,failedChecks:failures.map(c=>c.id),decision:failures.length?'blocked':'paper_intent_eligible',
  permissions:{paperIntentEligible:failures.length===0,liveExecutionAuthorized:false,ordersCreated:0},
  note:'Pre-trade risk assessment only. Passing this preflight does not place, reserve or authorize an exchange order.'};
}
pretradeRouter.post('/preflight',async(req,res)=>{
 try{requirePrivateApiAuth(req);const result=evaluatePretradeRisk(req.body||{});await appendStoredEvent({kind:'pretrade-risk-assessment',source:'jpti-pretrade-risk',eventType:'preflight',externalId:result.id,occurredAt:result.generatedAt,payload:result});res.json({...result,persisted:true});}
 catch(error){res.status(error.status||400).json({error:error.message||'Pre-trade assessment failed.'});}
});

pretradeRouter.post('/futures-gate', (req,res) => {
 try {
  requirePrivateApiAuth(req);
  const result=evaluateFuturesRisk(req.body||{});
  const eligible=result.decision==='eligible';
  res.json({...result,permissions:{paperIntentEligible:eligible,liveExecutionAuthorized:false,ordersCreated:0},note:'Futures risk assessment only. No exchange order is created or authorized.'});
 } catch(error) { res.status(error.status||400).json({decision:'blocked',error:error.message||'Futures risk assessment failed.',permissions:{liveExecutionAuthorized:false,ordersCreated:0}}); }
});
