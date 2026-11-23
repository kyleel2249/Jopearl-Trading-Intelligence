import express from 'express';
import { requirePrivateApiAuth } from './policy.js';
import { getStorageStatus } from './storage.js';
import { getSchedulerLeaseStatus } from './scheduler-lease.js';
import { listExchangeCatalog } from './exchanges.js';
export const productionReadinessRouter=express.Router();
const loopback=host=>['127.0.0.1','::1','localhost'].includes(host);
const positive=v=>Number.isFinite(Number(v))&&Number(v)>0?Number(v):null;
const validCorsOrigin=value=>{if(value==='capacitor://localhost')return true;try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value&&!url.username&&!url.password;}catch{return false;}};
export function evaluateProductionReadiness({env=process.env,storage=getStorageStatus(),scheduler=getSchedulerLeaseStatus(),exchanges=listExchangeCatalog()}={}){
 const host=String(env.JPTI_API_HOST||'127.0.0.1'),remote=!loopback(host),token=String(env.JPTI_API_TOKEN||''),strongToken=token.length>=32&&new Set(token).size>=12&&!/(password|changeme|example|placeholder)/i.test(token),backend=String(env.JPTI_STORAGE_BACKEND||(env.DATABASE_URL?'postgres':'file')).toLowerCase();
 const origins=String(env.JPTI_CORS_ORIGINS||'https://localhost,capacitor://localhost').split(',').map(x=>x.trim()).filter(Boolean);
 const signoff=env.JPTI_LIVE_TRADING_SIGNOFF==='I_HAVE_REVIEWED_AND_ACCEPT_THE_LIVE_TRADING_RISK';
 const checks=[
  {id:'api_binding',passed:!remote||(env.JPTI_ALLOW_REMOTE_API==='true'&&strongToken),severity:'critical',detail:'Remote binding requires explicit enablement and a strong API token.'},
  {id:'api_token',passed:strongToken,severity:'critical',detail:'API token must contain at least 32 characters.'},
  {id:'durable_storage',passed:backend==='postgres'&&Boolean(env.DATABASE_URL)&&storage.initialized===true&&storage.durable===true,severity:'critical',detail:'Initialized PostgreSQL storage is required for multi-instance production operation.'},
  {id:'distributed_scheduler',passed:scheduler.initialized===true&&scheduler.coordination==='postgres-distributed',severity:'critical',detail:'PostgreSQL scheduler lease coordination must be initialized.'},
  {id:'cors_origins',passed:origins.length>0&&!origins.includes('*')&&origins.every(validCorsOrigin),severity:'high',detail:'CORS must use explicit HTTPS or Capacitor origins; wildcard origins are forbidden.'},
  {id:'order_notional_cap',passed:positive(env.JPTI_MAX_ORDER_NOTIONAL_USDT)!==null&&positive(env.JPTI_MAX_ORDER_NOTIONAL_USDT)<=10000,severity:'critical',detail:'A positive per-order notional cap no greater than 10,000 USDT is required.'},
  {id:'exchange_credentials',passed:exchanges.some(x=>x.configured),severity:'high',detail:'At least one server-side exchange connection must be configured.'},
  {id:'live_trading_signoff',passed:signoff,severity:'critical',detail:'Explicit operator acknowledgement is required before live-readiness can be considered.'},
  {id:'live_mode_flags',passed:env.JPTI_TRADING_MODE==='live'&&env.JPTI_ENABLE_LIVE_TRADING==='true',severity:'critical',detail:'Both explicit live mode flags must be set; this assessment never changes them.'}
 ];
 const failed=checks.filter(c=>!c.passed),criticalFailures=failed.filter(c=>c.severity==='critical');
 const liveEligible=criticalFailures.length===0&&failed.length===0;
 return {generatedAt:new Date().toISOString(),environment:env.NODE_ENV||'unspecified',deployment:{hostBinding:remote?'remote':'loopback',storageBackend:backend,schedulerMode:scheduler.coordination||'unknown'},
  checks:checks.map(c=>({...c,status:c.passed?'pass':'blocked'})),failedChecks:failed.map(c=>c.id),criticalFailures:criticalFailures.map(c=>c.id),
  readiness:liveEligible?'all_configured_gates_passed':criticalFailures.length?'not_ready':'limited',
  permissions:{liveExecutionEligible:liveEligible,liveExecutionAuthorized:false,liveTradingEnabled:env.JPTI_ENABLE_LIVE_TRADING==='true',ordersCreated:0},
  actions:failed.map(c=>({check:c.id,requiredAction:c.detail})),
  statement:'This is a read-only readiness assessment. It does not change environment flags, unlock execution, place orders or certify regulatory compliance. Independent security review, exchange permissions review and controlled operator sign-off remain mandatory.'};
}
productionReadinessRouter.get('/readiness',(req,res)=>{
 try{requirePrivateApiAuth(req);res.json(evaluateProductionReadiness());}
 catch(error){res.status(error.status||500).json({error:error.message||'Production readiness assessment unavailable.'});}
});
