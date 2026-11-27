import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeStreamRequest,exchangeStreamConfig,parseStreamMessage,advanceBookSequence,applyOrderBookUpdate,summarizeOrderBook} from '../src/sequence-aware-stream-engine.js';
import collector from '../workers/market-stream-collector.js';
test('stream plans normalize and reject invalid symbols',()=>{assert.equal(normalizeStreamRequest({exchange:'binance',marketType:'spot',symbol:'BTC/USDT'}).streamId,'binance:spot:BTC/USDT');assert.throws(()=>normalizeStreamRequest({exchange:'bad',symbol:'BTC/USDT'}));assert.equal(normalizeStreamRequest({exchange:'binance',symbol:'BTCUSDT'}).symbol,'BTC/USDT');});
test('Binance futures stream combines depth, trades, ticker, mark price and liquidation channels',()=>{const c=exchangeStreamConfig({exchange:'binance',marketType:'usdt-m',symbol:'BTC/USDT'});assert.match(c.url,/fstream\.binance\.com\/stream\?streams=/);assert.ok(c.streams.some(x=>x.endsWith('@forceOrder')));assert.ok(c.snapshotUrl.includes('/fapi/v1/depth'));});
test('Binance depth snapshot bridges the first overlapping diff and detects later gaps',()=>{let state=advanceBookSequence({}, {quality:{snapshot:true},sequence:{last:100},receivedAt:'t'}).state;let first=advanceBookSequence(state,{sequence:{first:99,last:102,previous:95}});assert.equal(first.action,'applied');state=first.state;let second=advanceBookSequence(state,{sequence:{first:103,last:105,previous:102}});assert.equal(second.action,'applied');let gap=advanceBookSequence(second.state,{sequence:{first:108,last:109,previous:105}});assert.equal(gap.action,'gap');assert.equal(gap.state.valid,false);});
test('a REST-seeded Binance snapshot accepts the first overlapping diff without requiring pu to equal snapshot id',()=>{let state={valid:true,lastSequence:100,bridged:false};const first=advanceBookSequence(state,{sequence:{first:99,last:102,previous:95}});assert.equal(first.action,'applied');assert.equal(first.state.lastSequence,102);assert.equal(first.state.bridged,true);});
test('order book deltas update and delete price levels and calculate imbalance',()=>{let book=applyOrderBookUpdate({}, {quality:{snapshot:true},payload:{type:'snapshot',bids:[['100','2'],['99','3']],asks:[['101','1']]},sequence:{last:10}});book=applyOrderBookUpdate(book,{quality:{bookValid:true},payload:{bids:[['100','0'],['98','4']],asks:[['101','2']]},sequence:{last:11}});const s=summarizeOrderBook(book);assert.equal(s.bestBid,99);assert.equal(s.bestAsk,101);assert.equal(s.valid,true);assert.ok(s.depthImbalance<1);});
test('Binance aggregate trade maps maker flag to aggressor side',()=>{const [event]=parseStreamMessage({exchange:'binance',marketType:'usdt-m',symbol:'BTC/USDT'},{stream:'btcusdt@aggTrade',data:{e:'aggTrade',a:7,p:'100',q:'2',T:1700000000000,m:true}},1700000000000);assert.equal(event.kind,'trade');assert.equal(event.payload.side,'sell');assert.equal(event.payload.quoteNotional,200);});
test('Bybit ticker provides cross-market funding and open-interest observations',()=>{const events=parseStreamMessage({exchange:'bybit',marketType:'usdt-m',symbol:'BTC/USDT'},{topic:'tickers.BTCUSDT',ts:1700000000000,data:{lastPrice:'100',bid1Price:'99',ask1Price:'101',fundingRate:'0.0001',openInterest:'200'}},1700000000000);assert.deepEqual(events.map(x=>x.kind),['ticker','funding','open_interest']);});

test('read-only public stream history is accessible without private control credentials',async()=>{
 const env={MARKET_STREAMS:{idFromName:id=>id,get:()=>({fetch:async()=>new Response(JSON.stringify({count:1,events:[{event_kind:'trade'}]}),{status:200,headers:{'content-type':'application/json'}})})}};
 const response=await collector.fetch(new Request('https://collector.test/history?exchange=binance&marketType=spot&symbol=BTC%2FUSDT'),env);
 assert.equal(response.status,200);
 assert.equal((await response.json()).count,1);
});
test('stream control remains private when no control token is configured',async()=>{
 const response=await collector.fetch(new Request('https://collector.test/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({exchange:'binance',marketType:'spot',symbol:'BTC/USDT'})}),{});
 assert.equal(response.status,401);
});

test('order-book reconstruction rejects negative quantities and stays invalid until a fresh snapshot',()=>{
 let book=applyOrderBookUpdate({}, {quality:{snapshot:true},payload:{type:'snapshot',bids:[['100','2']],asks:[['101','3']]},sequence:{last:10}});
 assert.equal(book.valid,true);
 book=applyOrderBookUpdate(book,{quality:{bookValid:true},payload:{bids:[['100','-4']]},sequence:{last:11}});
 assert.equal(book.valid,false);
 assert.equal(book.invalidLevel,true);
 assert.equal(summarizeOrderBook(book).valid,false);
 book=applyOrderBookUpdate(book,{quality:{bookValid:true},payload:{bids:[['100','5']]},sequence:{last:12}});
 assert.equal(book.valid,false);
 book=applyOrderBookUpdate(book,{quality:{snapshot:true},payload:{type:'snapshot',bids:[['100','5']],asks:[['101','2']]},sequence:{last:13}});
 assert.equal(book.valid,true);
 assert.equal(book.invalidLevel,false);
});
test('crossed order books are explicitly invalid and cannot be summarized as trusted depth',()=>{
 const book=applyOrderBookUpdate({}, {quality:{snapshot:true},payload:{type:'snapshot',bids:[['102','2']],asks:[['101','3']]},sequence:{last:20}});
 const summary=summarizeOrderBook(book);
 assert.equal(book.crossed,true);
 assert.equal(book.valid,false);
 assert.equal(summary.crossed,true);
 assert.equal(summary.valid,false);
 assert.ok(summary.spread<0);
});
test('order-book reconstruction rejects non-finite and non-positive price levels',()=>{
 const book=applyOrderBookUpdate({}, {quality:{snapshot:true},payload:{type:'snapshot',bids:[['0','2'],['NaN','3'],['100','2']],asks:[['101','1']]},sequence:{last:30}});
 assert.equal(book.valid,false);
 assert.equal(book.invalidLevel,true);
 assert.deepEqual(book.bids,[[100,2]]);
});
