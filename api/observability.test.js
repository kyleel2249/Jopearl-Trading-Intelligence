import test from 'node:test';
import assert from 'node:assert/strict';
import { buildObservabilitySnapshot } from './observability.js';
test('builds operational checks without exposing credentials',()=>{
 const r=buildObservabilitySnapshot({now:1700000000000,storage:{backend:'file',durable:false,initialized:true},scheduler:{initialized:true,coordination:'single-process-only'},exchanges:[{id:'binance',configured:true}],memory:{rss:1,heapUsed:2,heapTotal:3,external:4},uptime:10});
 assert.equal(r.readiness,'limited');assert.equal(r.exchanges.configured,1);assert.equal(r.security.credentialsExposed,false);assert.equal(r.security.liveTradingEnabled,false);
});
test('marks uninitialized services degraded',()=>{
 const r=buildObservabilitySnapshot({storage:{initialized:false,durable:false},scheduler:{initialized:false,coordination:'single-process-only'},exchanges:[]});
 assert.equal(r.readiness,'degraded');assert.ok(r.checks.some(c=>c.status==='fail'));
});
