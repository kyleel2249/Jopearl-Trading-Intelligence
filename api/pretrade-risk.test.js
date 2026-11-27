import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { evaluatePretradeRisk, pretradeRouter } from './pretrade-risk.js';
const now=1700000000000;
const fixture=()=>({account:{equity:10000,currency:'USDT',dailyPnl:-50,exposures:[{symbol:'ETH/USDT',marketValue:1000,currency:'USDT'}]},order:{symbol:'BTC/USDT',side:'buy',quantity:.1,referencePrice:50000,stopPrice:49000,quoteTimestamp:new Date(now).toISOString()},limits:{maxDailyLoss:300,maxOrderNotional:6000,maxGrossExposure:10000,maxRiskPercent:2,maxSymbolConcentrationPercent:80,maxQuoteAgeMs:15000}});
test('allows only a fully evidenced paper intent within every configured risk cap',()=>{
 const r=evaluatePretradeRisk(fixture(),now);assert.equal(r.decision,'paper_intent_eligible');assert.equal(r.permissions.liveExecutionAuthorized,false);assert.equal(r.permissions.ordersCreated,0);
});
test('blocks stale quotes, excessive size, invalid stops and daily loss breaches',()=>{
 const f=fixture();f.order.quoteTimestamp=new Date(now-60000).toISOString();f.order.quantity=1;f.order.stopPrice=51000;f.account.dailyPnl=-500;
 const r=evaluatePretradeRisk(f,now);assert.equal(r.decision,'blocked');assert.ok(r.failedChecks.includes('quote_freshness'));assert.ok(r.failedChecks.includes('per_order_notional'));assert.ok(r.failedChecks.includes('protective_stop'));assert.ok(r.failedChecks.includes('daily_loss_limit'));
});
test('fails closed when account exposure inventory is missing or malformed',()=>{
 const f=fixture();delete f.account.exposures;assert.ok(evaluatePretradeRisk(f,now).failedChecks.includes('account_exposures'));
 f.account.exposures=[{symbol:'ETH/USDT',marketValue:-100}];assert.ok(evaluatePretradeRisk(f,now).failedChecks.includes('account_exposures'));
});
test('fails closed when any required account or limit input is absent',()=>{
 const r=evaluatePretradeRisk({},now);assert.equal(r.decision,'blocked');assert.ok(r.failedChecks.length>=9);
});

test('blocks quote-currency mismatches across account and existing exposure inventory',()=>{
 const f=fixture();f.account.currency='USD';const a=evaluatePretradeRisk(f,now);assert.ok(a.failedChecks.includes('account_quote_currency'));
 f.account.currency='USDT';f.account.exposures[0].currency='USD';const b=evaluatePretradeRisk(f,now);assert.ok(b.failedChecks.includes('account_exposures'));
});

test('futures risk gate requires the configured private API token', async () => {
 const priorToken=process.env.JPTI_API_TOKEN,priorLocal=process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS;
 process.env.JPTI_API_TOKEN='test-private-token-for-futures-gate';
 process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS='false';
 const app=express();app.use(express.json());app.use('/api/risk',pretradeRouter);
 const server=createServer(app);
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 try {
  const url='http://127.0.0.1:'+server.address().port+'/api/risk/futures-gate';
  const payload={product:'futures',side:'long',entry:100,stop:95,equity:10000,riskPercent:1,leverage:10};
  const denied=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
  assert.equal(denied.status,401);
  const allowed=await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':process.env.JPTI_API_TOKEN},body:JSON.stringify(payload)});
  assert.equal(allowed.status,200);
  const body=await allowed.json();
  assert.equal(body.permissions.liveExecutionAuthorized,false);
  assert.equal(body.permissions.ordersCreated,0);
 } finally {
  await new Promise(resolve=>server.close(resolve));
  if(priorToken===undefined)delete process.env.JPTI_API_TOKEN;else process.env.JPTI_API_TOKEN=priorToken;
  if(priorLocal===undefined)delete process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS;else process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS=priorLocal;
 }
});
