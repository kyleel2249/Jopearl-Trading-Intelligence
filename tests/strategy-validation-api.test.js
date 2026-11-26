import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest,loadHistoricalMarketEvents,createMarketDataAt} from '../functions/api/paper/validation.js';
function candles(count=650){const rows=[];let p=100;for(let i=0;i<count;i++){p+=.08+Math.sin(i/8)*.02;const ts=1700000000000+i*60000;rows.push({observed_at:new Date(ts).toISOString(),payload:JSON.stringify([ts,p-.03,p+.2,p-.15,p,1000])});}return rows;}
function database(){return{prepare(sql){const statement={sql,args:[],bind(...args){this.args=args;return this;},async all(){if(this.sql.includes('jpti_market_observations'))return{results:candles()};return{results:[]};},async first(){return null;},async run(){return{success:true};}};return statement;}};}
test('validation API ignores forged client pass flags and recomputes server evidence',async()=>{const request=new Request('https://jpti.test/api/paper/validation',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':'secret'},body:JSON.stringify({strategyId:'trend',exchange:'bitget',marketType:'usdt-m',symbol:'BTC/USDT',timeframe:'1m',passed:true,status:'LIVE_READY',verdict:{passed:true,failedChecks:[]},backtest:{closedTrades:9999,profitFactor:99}})});const response=await onRequest({request,env:{JPTI_DB:database(),JPTI_API_TOKEN:'secret'}});const body=await response.json();assert.equal(response.status,200);assert.equal(body.verdict.passed,false);assert.equal(body.status,'RESEARCH_ONLY');assert.equal(body.liveExecutionAuthorized,false);assert.ok(body.verdict.failedChecks.includes('forward_sample'));});

test('historical market replay loads persisted microstructure across all supported exchanges',async()=>{
 const queries=[];
 const db={prepare(sql){queries.push(sql);return{bind(){return this;},async all(){return{results:[]};}};}};
 const urls=[];
 const env={JPTI_API_TOKEN:'secret',JPTI_MARKET_STREAM:{async fetch(url){urls.push(new URL(url).searchParams.get('exchange'));return new Response(JSON.stringify({events:[],count:0}),{status:200,headers:{'content-type':'application/json'}});}}};
 await loadHistoricalMarketEvents(db,{exchange:'bitget',marketType:'usdt-m',symbol:'BTC/USDT'},'2026-11-25T00:00:00.000Z','2026-11-26T00:00:00.000Z',env);
 assert.ok(queries.every(sql=>sql.includes("exchange IN ('binance','bybit','okx','bitget')")));
 assert.deepEqual(urls.sort(),['binance','bitget','bybit','okx']);
});
test('rolling replay microstructure aggregates cross-exchange books, flow, funding and open interest',()=>{
 const t=Date.parse('2026-11-26T00:00:00Z');
 const events=[
  {exchange:'binance',kind:'orderbook',ts:t,payload:{notionalImbalance:.4,bestBid:100,bestAsk:101}},
  {exchange:'bybit',kind:'orderbook',ts:t+100,payload:{notionalImbalance:-.2,bestBid:99,bestAsk:102}},
  {exchange:'binance',kind:'trade',ts:t+200,payload:{quoteNotional:100,side:'buy'}},
  {exchange:'okx',kind:'trade',ts:t+300,payload:{quoteNotional:50,side:'sell'}},
  {exchange:'bitget',kind:'funding',ts:t+400,payload:{rate:.001}},
  {exchange:'binance',kind:'open_interest',ts:t+500,payload:{openInterest:1000}}
 ];
 const at=createMarketDataAt(events,60000)(t+1000);
 assert.equal(at.orderBookImbalance,.1);
 assert.ok(Math.abs(at.tradeFlowImbalance-1/3)<1e-9);
 assert.equal(at.fundingRate,.001);
 assert.equal(at.openInterest,1000);
 assert.deepEqual(at.venues.sort(),['binance','bitget','bybit','okx']);
});
