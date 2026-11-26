import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isDailyReviewDue,buildStreamStartPayload,startMarketStreamCollector} from '../workers/paper-scheduler.js';
import {loadLiveMarketContext} from '../functions/api/paper/[[path]].js';
test('paper scheduler retains legacy dedicated daily cron compatibility',()=>{assert.equal(isDailyReviewDue({cron:'5 0 * * *'}),true);});
test('paper scheduler runs the daily review from its single per-minute trigger at 00:05 UTC',()=>{assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,0,5)}),true);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,0,4)}),false);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:Date.UTC(2026,10,25,12,5)}),false);});
test('paper scheduler ignores missing or invalid scheduled timestamps for the daily review',()=>{assert.equal(isDailyReviewDue({cron:'*/1 * * * *'}),false);assert.equal(isDailyReviewDue({cron:'*/1 * * * *',scheduledTime:'invalid'}),false);});

test('paper scheduler Wrangler config preserves deployed triggers without attempting quota changes',async()=>{const config=await readFile(new URL('../workers/wrangler.toml',import.meta.url),'utf8');assert.doesNotMatch(config,/^\[triggers\]/m);assert.match(config,/currently deployed/);assert.ok(config.includes('script_name = "jpti-market-stream-collector"'));});

test('stream start payload filters unsupported venues and markets and caps subscriptions',()=>{
 const payload=buildStreamStartPayload([
  {exchange:'binance',market_type:'spot',symbol:'BTCUSDT'},
  {exchange:'bitget',market_type:'usdt-m',symbol:'ETHUSDT'},
  {exchange:'unknown',market_type:'spot',symbol:'BADUSDT'}
 ]);
 assert.deepEqual(payload.streams,[
  {exchange:'binance',marketType:'spot',symbol:'BTC/USDT'},
  {exchange:'bitget',marketType:'usdt-m',symbol:'ETH/USDT'}
 ]);
 assert.equal(buildStreamStartPayload([]).streams.length,8);
});
test('paper scheduler starts streams through its cross-worker Durable Object binding',async()=>{
 const calls=[];
 const result=await startMarketStreamCollector({
  MARKET_STREAMS:{
   idFromName(name){return name;},
   get(id){return{async fetch(url,options){calls.push({id,url,options});return new Response(JSON.stringify({status:'connected'}),{status:200,headers:{'content-type':'application/json'}});}};}
  },
  JPTI_DB:{prepare(){return{async all(){return{results:[{exchange:'binance',market_type:'spot',symbol:'BTCUSDT'}]};}};}}
 });
 assert.equal(result.requested,1);
 assert.equal(result.started,1);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://stream-hub/start');
 assert.equal(JSON.parse(calls[0].options.body).symbol,'BTC/USDT');
});
test('collector configuration does not consume another account cron trigger',async()=>{
 const config=await readFile(new URL('../workers/market-stream-collector.wrangler.toml',import.meta.url),'utf8');
 assert.doesNotMatch(config,/^\[triggers\]/m);
});

test('live paper context consumes fresh spot and derivatives streams from every supported venue',async()=>{
 const calls=[],now=new Date().toISOString();
 const db={prepare(){return{bind(){return this;},async all(){return{results:[]};}};}};
 const context=await loadLiveMarketContext(db,'BTCUSDT',{
  MARKET_STREAMS:{
   idFromName(name){return name;},
   get(id){return{async fetch(url){calls.push({id,url});const config=id.split(':');return new Response(JSON.stringify({events:[{
    event_kind:'ticker',event_id:id,observedAt:now,received_at:now,
    payload:{bid:'100',ask:'101',last:'100.5'}
   }]}),{status:200,headers:{'content-type':'application/json'}});}};}
  }
 });
 assert.equal(calls.length,8);
 assert.deepEqual(context.venues.sort(),['binance','bitget','bybit','okx']);
 assert.equal(context.freshStreamEvents.length,8);
 assert.equal(context.ticker.bid,100);
 assert.equal(context.ticker.ask,101);
});
