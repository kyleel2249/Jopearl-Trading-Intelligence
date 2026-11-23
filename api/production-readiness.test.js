import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProductionReadiness } from './production-readiness.js';
const env=()=>({JPTI_API_HOST:'0.0.0.0',JPTI_ALLOW_REMOTE_API:'true',JPTI_API_TOKEN:'JpT1!Secure-Token-2026-Unique-Value-9382',JPTI_STORAGE_BACKEND:'postgres',DATABASE_URL:'postgres://redacted',JPTI_CORS_ORIGINS:'https://app.example.com',JPTI_MAX_ORDER_NOTIONAL_USDT:'1000',JPTI_TRADING_MODE:'live',JPTI_ENABLE_LIVE_TRADING:'true',JPTI_LIVE_TRADING_SIGNOFF:'I_HAVE_REVIEWED_AND_ACCEPT_THE_LIVE_TRADING_RISK'});
const deps=()=>({storage:{initialized:true,durable:true},scheduler:{initialized:true,coordination:'postgres-distributed'},exchanges:[{id:'binance',configured:true}]});
test('reports all gates only when every configured production prerequisite passes',()=>{
 const r=evaluateProductionReadiness({env:env(),...deps()});assert.equal(r.readiness,'all_configured_gates_passed');assert.equal(r.permissions.liveExecutionEligible,true);assert.equal(r.permissions.liveExecutionAuthorized,false);assert.equal(r.permissions.ordersCreated,0);
});
test('blocks weak secrets, ephemeral storage, missing signoff and wildcard CORS',()=>{
 const e=env();e.JPTI_API_TOKEN='weak';e.JPTI_CORS_ORIGINS='*';e.JPTI_LIVE_TRADING_SIGNOFF='';const d=deps();d.storage={initialized:true,durable:false};
 const r=evaluateProductionReadiness({env:e,...d});assert.equal(r.permissions.liveExecutionEligible,false);assert.ok(r.failedChecks.includes('api_token'));assert.ok(r.failedChecks.includes('cors_origins'));assert.ok(r.failedChecks.includes('durable_storage'));assert.ok(r.failedChecks.includes('live_trading_signoff'));
 const repeated=env();repeated.JPTI_API_TOKEN='x'.repeat(40);assert.ok(evaluateProductionReadiness({env:repeated,...deps()}).failedChecks.includes('api_token'));
 const invalidOrigin=env();invalidOrigin.JPTI_CORS_ORIGINS='https://app.example.com/path';assert.ok(evaluateProductionReadiness({env:invalidOrigin,...deps()}).failedChecks.includes('cors_origins'));
});
test('never changes live authorization even when configuration passes',()=>{
 const r=evaluateProductionReadiness({env:env(),...deps()});assert.equal(r.permissions.liveExecutionAuthorized,false);assert.equal(r.permissions.ordersCreated,0);
});
