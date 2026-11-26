import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest} from '../functions/api/market-data/live.js';
function database(queries){return{prepare(sql){queries.push(sql);return{bind(...args){this.args=args;return this;},async all(){return{results:[]};}};}};}
test('unified live market API reads D1 across all exchanges and both symbol notations',async()=>{
 const queries=[],request=new Request('https://jpti.test/api/market-data/live?symbol=BTC%2FUSDT&marketType=usdt-m&limit=20');
 const response=await onRequest({request,env:{JPTI_DB:database(queries)}});
 const body=await response.json();
 assert.equal(response.status,200);
 assert.equal(body.filters.exchange,'all');
 assert.equal(queries.length,6);
 assert.ok(queries.every(sql=>!sql.includes('exchange=?')));
 assert.ok(queries.every(sql=>sql.includes('symbol IN (?,?)')));
});
test('unified live market API merges bounded Durable Object history from all four exchanges',async()=>{
 const calls=[];
 const db=database([]);
 const env={JPTI_DB:db,JPTI_MARKET_STREAM:{async fetch(url){const u=new URL(url);calls.push(u.searchParams.get('exchange'));return new Response(JSON.stringify({events:[{event_kind:'trade',event_id:u.searchParams.get('exchange'),observedAt:'2026-11-26T00:00:00.000Z',payload:{side:'buy'}}]}),{status:200,headers:{'content-type':'application/json'}});}}};
 const request=new Request('https://jpti.test/api/market-data/live?symbol=BTC%2FUSDT&marketType=usdt-m&limit=40');
 const response=await onRequest({request,env}),body=await response.json();
 assert.equal(response.status,200);
 assert.deepEqual(calls.sort(),['binance','bitget','bybit','okx']);
 assert.equal(body.sections.completeWebSocketHistory.count,4);
 assert.equal(body.sections.completeWebSocketHistory.venues.length,4);
});
test('unified live market API rejects unsupported exchange filters',async()=>{
 const response=await onRequest({request:new Request('https://jpti.test/api/market-data/live?exchange=unknown'),env:{JPTI_DB:database([])}});
 assert.equal(response.status,400);
});
