import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeMicrostructurePlan,buildMicrostructureUrl,normalizeMicrostructurePayload,microstructureObservationKey,summarizeMicrostructureObservations} from '../src/microstructure-replication-engine.js';
import {createMicrostructureReplicationHandler} from '../functions/api/replication/microstructure.js';

test('microstructure plan validates and bounds exchanges, symbols, kinds and request budget',()=>{
 const p=normalizeMicrostructurePlan({exchanges:['BINANCE','unknown','okx'],symbols:['BTC/USDT','bad symbol'],kinds:['trade','bad'],maxRequests:999});
 assert.deepEqual(p.exchanges,['binance','okx']);assert.deepEqual(p.symbols,['BTC/USDT']);assert.deepEqual(p.kinds,['trade']);assert.equal(p.maxRequests,24);
});
test('venue URL builders select the correct public product endpoints',()=>{
 assert.match(buildMicrostructureUrl('binance','BTC/USDT','orderbook','spot'),/api\.binance\.com\/api\/v3\/depth/);
 assert.match(buildMicrostructureUrl('binance','BTC/USDT','orderbook','margin'),/api\.binance\.com\/api\/v3\/depth/);
 assert.match(buildMicrostructureUrl('binance','BTC/USDT','funding','usdt-m'),/fapi\.binance\.com\/fapi\/v1\/fundingRate/);
 assert.match(buildMicrostructureUrl('binance','BTC/USD:BTC','open_interest','coin-m'),/dapi\.binance\.com\/dapi\/v1\/openInterest/);
 assert.match(buildMicrostructureUrl('bybit','BTC/USDT','trade','usdt-m'),/category=linear/);
 assert.match(buildMicrostructureUrl('okx','BTC/USDT','orderbook','usdt-m'),/BTC-USDT-SWAP/);
 assert.match(buildMicrostructureUrl('bitget','BTC/USDT','funding','usdt-m'),/productType=USDT-FUTURES/);
 assert.equal(buildMicrostructureUrl('binance','BTC/USDT','liquidation','usdt-m'),null);
});
test('orderbook normalizer computes spread and flags crossed books',()=>{
 const rows=normalizeMicrostructurePayload({exchange:'okx',symbol:'BTC/USDT',marketType:'spot',kind:'orderbook',payload:{code:'0',data:[{ts:'1795683600000',bids:[['90000','2']],asks:[['90010','3']]}]},receivedAt:1795683601000});
 assert.equal(rows.length,1);assert.equal(rows[0].payload.spread,10);assert.equal(rows[0].payload.midPrice,90005);assert.equal(rows[0].quality.crossed,false);
});
test('order-book normalizer calculates spread basis points and depth imbalance',()=>{
 const rows=normalizeMicrostructurePayload({exchange:'binance',symbol:'BTC/USDT',marketType:'spot',kind:'orderbook',payload:{bids:[['100','4'],['99','2']],asks:[['101','2'],['102','2']]},receivedAt:1795683601000});
 assert.equal(rows.length,1);assert.ok(rows[0].payload.spreadBps>0);assert.ok(rows[0].payload.depthImbalance>0);
});
test('microstructure analytics derives aggressive flow and liquidation exposure',()=>{
 const summary=summarizeMicrostructureObservations([
  {exchange:'binance',marketType:'usdt-m',symbol:'BTC/USDT',kind:'trade',observedAt:'2026-11-26T09:00:00.000Z',payload:{side:'buy',quantity:2,quoteQuantity:200}},
  {exchange:'binance',marketType:'usdt-m',symbol:'BTC/USDT',kind:'trade',observedAt:'2026-11-26T09:00:01.000Z',payload:{side:'sell',quantity:1,quoteQuantity:100}},
  {exchange:'okx',marketType:'usdt-m',symbol:'BTC/USDT',kind:'liquidation',observedAt:'2026-11-26T09:00:01.000Z',payload:{side:'sell',notional:500}}
 ]);
 assert.equal(summary.tradeFlow[0].netAggressorNotional,100);assert.equal(summary.liquidations[0].sellSideNotional,500);
});
test('trade, funding, open interest and liquidation events are normalized with stable IDs',()=>{
 const cases=[
  ['trade',{data:[{tradeId:'t1',ts:'1795683600000',price:'100',size:'2',side:'buy'}]},'tradeId','t1'],
  ['funding',{result:{list:[{symbol:'BTCUSDT',fundingRate:'0.0001',fundingRateTimestamp:'1795683600000'}]}},'rate',0.0001],
  ['open_interest',{openInterest:'1234',time:1795683600000},'openInterest',1234],
  ['liquidation',{data:[{orderId:'l1',ts:'1795683600000',bkPx:'100',sz:'3',side:'sell'}]},'notional',300]
 ];
 for(const [kind,payload,key,value]of cases){const rows=normalizeMicrostructurePayload({exchange:'okx',symbol:'BTC/USDT',marketType:'usdt-m',kind,payload,receivedAt:1795683601000});assert.equal(rows.length,1);assert.equal(rows[0].payload[key],value);assert.equal(microstructureObservationKey(rows[0]),microstructureObservationKey(rows[0]));}
});
function makeDb(){
 const saved=new Map(),runs=new Map();
 return {saved,runs,prepare(sql){return{args:[],bind(...args){this.args=args;return this;},async run(){if(sql.startsWith('INSERT INTO jpti_microstructure_runs'))runs.set(this.args[0],{status:'running'});if(sql.startsWith('UPDATE jpti_microstructure_runs'))runs.set(this.args[4],{status:this.args[0],summary:this.args[3]});return{meta:{changes:1}};},async all(){if(sql.includes('FROM jpti_microstructure_observations'))return{results:[...saved.values()].map(x=>({exchange:x.exchange,market_type:x.marketType,symbol:x.symbol,observation_kind:x.kind,event_id:x.eventId,observed_at:x.observedAt,received_at:x.receivedAt,payload:JSON.stringify(x.payload),quality:JSON.stringify(x.quality)}))};if(sql.includes('FROM jpti_microstructure_runs'))return{results:[]};return{results:[]};},async first(){return{observations:saved.size,exchanges:1,symbols:1,last_received_at:null};}};},async batch(stmts){return stmts.map(s=>{const a=s.args,exists=saved.has(a[0]);if(!exists)saved.set(a[0],{exchange:a[1],marketType:a[2],symbol:a[3],kind:a[4],eventId:a[5],observedAt:a[6],receivedAt:a[7],payload:JSON.parse(a[8]),quality:JSON.parse(a[9])});return{meta:{changes:exists?0:1}};});}};
}
test('microstructure API authenticates writes and persists public trade observations',async()=>{
 const db=makeDb(),handler=createMicrostructureReplicationHandler({verifyToken:async()=>({ok:true}),fetchImpl:async()=>new Response(JSON.stringify({data:[{tradeId:'trade-1',ts:'1795683600000',price:'90000',size:'0.5',side:'buy'}]}),{status:200,headers:{'content-type':'application/json'}}),now:()=>new Date(1795683601000)});
 const response=await handler({request:new Request('https://jpti.example/api/replication/microstructure',{method:'POST',body:JSON.stringify({exchanges:['binance'],symbols:['BTC/USDT'],kinds:['trade'],maxRequests:1})}),env:{JPTI_DB:db}});
 const body=await response.json();assert.equal(response.status,200);assert.equal(body.status,'completed');assert.equal(body.inserted,1);assert.equal(db.saved.size,1);
});
test('microstructure API fails closed when authorization is rejected',async()=>{
 const handler=createMicrostructureReplicationHandler({verifyToken:async()=>({ok:false,status:401,error:'denied'})});
 const response=await handler({request:new Request('https://jpti.example/api/replication/microstructure',{method:'POST',body:'{}'}),env:{JPTI_DB:makeDb()}});
 assert.equal(response.status,401);
});
test('unsupported liquidation adapters are reported instead of fabricated',async()=>{
 const db=makeDb(),handler=createMicrostructureReplicationHandler({verifyToken:async()=>({ok:true}),fetchImpl:async()=>{throw new Error('must not fetch');}});
 const response=await handler({request:new Request('https://jpti.example/api/replication/microstructure',{method:'POST',body:JSON.stringify({exchanges:['bybit'],symbols:['BTC/USDT'],marketType:'usdt-m',kinds:['liquidation'],maxRequests:1})}),env:{JPTI_DB:db}});
 const body=await response.json();assert.equal(response.status,200);assert.equal(body.status,'partial');assert.equal(body.coverage.unsupported,1);assert.equal(db.saved.size,0);
});
