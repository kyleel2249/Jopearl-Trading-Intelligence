import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {isDailyReviewDue,buildStreamStartPayload,startMarketStreamCollector,normalizeBitgetPerpetualUniverse,selectRoundRobinBatch,loadBitgetPerpetualWatchlist,markBitgetWatchlistRotationStarted} from '../workers/paper-scheduler.js';
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

test('Bitget perpetual catalogue filters inactive/non-USDT contracts and ranks liquidity',()=>{const rows=normalizeBitgetPerpetualUniverse([{symbol:'BTCUSDT',symbolStatus:'normal',quoteCoin:'USDT',baseCoin:'BTC'},{symbol:'ETHUSDT',symbolStatus:'normal',quoteCoin:'USDT',baseCoin:'ETH'},{symbol:'BADUSDT',symbolStatus:'offline',quoteCoin:'USDT'},{symbol:'BTCUSD',symbolStatus:'normal',quoteCoin:'USD'}],[{symbol:'BTCUSDT',usdtVolume:'100'},{symbol:'ETHUSDT',usdtVolume:'250'}]);assert.deepEqual(rows.map(x=>x.symbol),['ETHUSDT','BTCUSDT']);});
test('perpetual universe rotation covers every symbol without duplicates',()=>{const universe=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT'];const first=selectRoundRobinBatch(universe,0,2),second=selectRoundRobinBatch(universe,first.nextOffset,2),third=selectRoundRobinBatch(universe,second.nextOffset,2);assert.deepEqual(first.symbols,['BTCUSDT','ETHUSDT']);assert.deepEqual(second.symbols,['SOLUSDT','XRPUSDT']);assert.deepEqual(third.symbols,['BNBUSDT','BTCUSDT']);});
test('priority perpetual symbols receive four venue futures streams within the 40-stream cap',()=>{const payload=buildStreamStartPayload([],['BTCUSDT','ETHUSDT']);assert.equal(payload.streams.length,8);assert.deepEqual(payload.streams.slice(0,4).map(x=>x.exchange),['binance','bybit','okx','bitget']);assert.ok(payload.streams.every(x=>x.marketType==='usdt-m'));});


test('Bitget perpetual universe rotation persists a pending cursor until stream startup succeeds',async()=>{
 let cursorValue=null;const db={prepare(sql){let args=[];return{bind(...values){args=values;return this;},async first(){return cursorValue?{cursor_value:cursorValue}:null;},async run(){if(sql.includes('jpti_multi_asset_backfill_cursors'))cursorValue=sql.startsWith('UPDATE')?args[0]:args[6];return{success:true};}};},async batch(){return[];}};
 const contracts=Array.from({length:12},(_,i)=>({symbol:'COIN'+String(i).padStart(2,'0')+'USDT',symbolStatus:'normal',quoteCoin:'USDT',baseCoin:'COIN'+String(i).padStart(2,'0')}));
 const tickers=contracts.map((x,i)=>({symbol:x.symbol,usdtVolume:String(1000-i)}));
 const fetchImpl=async url=>new Response(JSON.stringify({code:'00000',data:String(url).includes('contracts')?contracts:tickers}),{status:200,headers:{'content-type':'application/json'}});
 const first=await loadBitgetPerpetualWatchlist(db,fetchImpl,Date.UTC(2026,10,26,12,0),10);
 assert.equal(first.symbols.length,10);assert.equal(first.pendingRotation,true);
 const retry=await loadBitgetPerpetualWatchlist(db,fetchImpl,Date.UTC(2026,10,26,12,1),10);
 assert.deepEqual(retry.symbols,first.symbols);assert.equal(retry.rotated,true);
 assert.equal(await markBitgetWatchlistRotationStarted(db),true);
 const next=await loadBitgetPerpetualWatchlist(db,fetchImpl,Date.UTC(2026,10,26,12,6),10);
 assert.deepEqual(next.previousSymbols,first.symbols);assert.equal(next.symbols.length,2);
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

test('stream rotation starts the replacement futures batch before stopping the previous batch',async()=>{
 const calls=[];
 const MARKET_STREAMS={
  idFromName(name){return name;},
  get(id){
   return {
    async fetch(url){
     calls.push({id,url});
     const status=url.endsWith('/stop')?'stopped':'connected';
     return new Response(JSON.stringify({status}),{status:200,headers:{'content-type':'application/json'}});
    }
   };
  }
 };
 const JPTI_DB={prepare(){return {async all(){return {results:[]};}};}};
 const result=await startMarketStreamCollector({MARKET_STREAMS,JPTI_DB},['BTCUSDT'],['ETHUSDT']);
 const firstStop=calls.findIndex(x=>x.url.endsWith('/stop'));
 const lastStart=calls.map(x=>x.url).lastIndexOf('https://stream-hub/start');
 assert.equal(result.requested,4);
 assert.equal(result.started,4);
 assert.equal(result.stopped,4);
 assert.ok(firstStop>lastStart);
});
