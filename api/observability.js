import express from 'express';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getStorageStatus } from './storage.js';
import { getSchedulerLeaseStatus } from './scheduler-lease.js';
import { listExchangeCatalog } from './exchanges.js';
import { requirePrivateApiAuth } from './policy.js';
export const observabilityRouter=express.Router();
const histogram=monitorEventLoopDelay({resolution:20});histogram.enable();
const counters=new Map();let requests=0,errors=0,totalLatencyMs=0;
export function observabilityMiddleware(req,res,next){
 const started=process.hrtime.bigint();requests++;
 res.on('finish',()=>{
  const latency=Number(process.hrtime.bigint()-started)/1e6;totalLatencyMs+=latency;if(res.statusCode>=500)errors++;
  const route=String(req.route?.path||req.path||'unknown').slice(0,120),key=req.method+' '+route;
  if(!counters.has(key)&&counters.size>=200)counters.delete(counters.keys().next().value);
  const row=counters.get(key)||{count:0,errors:0,totalLatencyMs:0,maxLatencyMs:0};
  row.count++;if(res.statusCode>=500)row.errors++;row.totalLatencyMs+=latency;row.maxLatencyMs=Math.max(row.maxLatencyMs,latency);counters.set(key,row);
 });
 next();
}
export function buildObservabilitySnapshot({now=Date.now(),storage=getStorageStatus(),scheduler=getSchedulerLeaseStatus(),exchanges=listExchangeCatalog(),memory=process.memoryUsage(),uptime=process.uptime()}={}){
 const routes=[...counters.entries()].map(([route,row])=>({route,...row,averageLatencyMs:row.count?row.totalLatencyMs/row.count:0})).sort((a,b)=>b.count-a.count).slice(0,50);
 const configured=exchanges.filter(x=>x.configured).length;
 const checks=[
  {id:'storage_initialized',status:storage.initialized?'pass':'fail',detail:'Storage initialization state.'},
  {id:'durable_storage',status:storage.durable?'pass':'warning',detail:storage.durable?'PostgreSQL durable storage selected.':'File storage is local and single-process only.'},
  {id:'scheduler_initialized',status:scheduler.initialized?'pass':'fail',detail:'Scheduler lease coordinator initialization state.'},
  {id:'scheduler_coordination',status:scheduler.coordination==='postgres-distributed'?'pass':'warning',detail:'Scheduler coordination mode.'},
  {id:'exchange_catalog',status:exchanges.length?'pass':'fail',detail:'CCXT exchange adapter catalog availability.'}
 ];
 return {generatedAt:new Date(now).toISOString(),service:{name:'JPTI',uptimeSeconds:uptime,nodeVersion:process.version,environment:process.env.NODE_ENV||'unspecified'},
  requests:{total:requests,serverErrors:errors,averageLatencyMs:requests?totalLatencyMs/requests:0,routes},
  eventLoop:{meanDelayMs:Number(histogram.mean)/1e6||0,p95DelayMs:Number(histogram.percentile(95))/1e6||0,maxDelayMs:Number(histogram.max)/1e6||0},
  memory:{rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,heapTotalBytes:memory.heapTotal,externalBytes:memory.external},
  storage,scheduler,exchanges:{supported:exchanges.length,configured,unconfigured:exchanges.length-configured},
  checks,readiness:checks.some(c=>c.status==='fail')?'degraded':checks.some(c=>c.status==='warning')?'limited':'operational',
  security:{liveTradingEnabled:process.env.JPTI_ENABLE_LIVE_TRADING==='true',tradingMode:process.env.JPTI_TRADING_MODE||'paper',credentialsExposed:false}};
}
observabilityRouter.get('/diagnostics',(req,res)=>{
 try{requirePrivateApiAuth(req);res.json(buildObservabilitySnapshot());}
 catch(error){res.status(error.status||500).json({error:error.message||'Diagnostics unavailable.'});}
});
