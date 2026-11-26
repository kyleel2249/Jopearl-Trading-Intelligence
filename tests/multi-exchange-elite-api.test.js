import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../functions/api/multi-exchange-elite.js';
const now='2026-11-26T12:00:00.000Z';
const candidate={exchange:'bybit',marketType:'usdt_perpetual',traderId:'bybit-lead-test',source:'approved-export',sourceAttested:true,retrievedAt:now,totalTrades:600,historyDays:300,averageHoldingHours:5,maxLeverage:3,windows:{'7d':{roiPct:3,winRatePct:70,maxDrawdownPct:3},'30d':{roiPct:12,winRatePct:72,maxDrawdownPct:4},'90d':{roiPct:32,winRatePct:71,maxDrawdownPct:5,sharpe:4,sortino:4,profitFactor:4},'180d':{roiPct:48,winRatePct:70,maxDrawdownPct:6}}};
function makeDb(){
 const events=[];
 const db={
  events,
  prepare(sql){return {sql,args:[],bind(...args){this.args=args;return this;},async all(){return {results:events.filter(x=>x.kind==='multi-exchange-elite-ranking').sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)).map(x=>({payload:x.payload})).slice(0,this.args[0]||20)};}}},
  async batch(statements){for(const statement of statements){const [id,kind,source,external_id,occurred_at,payload]=statement.args;events.push({id,kind,source,external_id,occurred_at,payload});}return {success:true};}
 };
 return db;
}
test('public capability endpoint exposes supported exchanges and stays paper-only',async()=>{
 const response=await onRequest({request:new Request('https://jpti.example/api/multi-exchange-elite'),env:{}});
 const body=await response.json();
 assert.equal(response.status,200);assert.deepEqual(body.exchanges.map(x=>x.id),['bitget','bybit','binance']);
 assert.equal(body.policy.liveExecutionAuthorized,false);assert.equal(body.agents.length,24);
});
test('private ranking endpoint fails closed when caller has no token',async()=>{
 const response=await onRequest({request:new Request('https://jpti.example/api/multi-exchange-elite',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({candidates:[candidate]})}),env:{JPTI_API_TOKEN:'secret',JPTI_DB:makeDb()}});
 assert.equal(response.status,401);
});
test('ranking run persists snapshot plus shared-memory and risk events atomically',async()=>{
 const db=makeDb();
 const response=await onRequest({request:new Request('https://jpti.example/api/multi-exchange-elite',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':'secret'},body:JSON.stringify({candidates:[candidate]})}),env:{JPTI_API_TOKEN:'secret',JPTI_DB:db}});
 const body=await response.json();
 assert.equal(response.status,201);assert.equal(body.persisted,true);assert.equal(body.execution.liveExecutionAuthorized,false);
 assert.equal(db.events.length,3);
 assert.ok(db.events.some(x=>x.kind==='shared-intelligence-memory-event'));
 assert.ok(db.events.some(x=>x.kind==='risk-command-centre-event'));
});
test('protected history returns stored snapshots',async()=>{
 const db=makeDb();
 await onRequest({request:new Request('https://jpti.example/api/multi-exchange-elite',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':'secret'},body:JSON.stringify({candidates:[candidate]})}),env:{JPTI_API_TOKEN:'secret',JPTI_DB:db}});
 const response=await onRequest({request:new Request('https://jpti.example/api/multi-exchange-elite?limit=5',{headers:{'x-jpti-api-token':'secret'}}),env:{JPTI_API_TOKEN:'secret',JPTI_DB:db}});
 const body=await response.json();
 assert.equal(response.status,200);assert.equal(body.count,1);assert.equal(body.rankings[0].candidateCount,1);
});
