import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuoteQuality, buildAssetQuoteConsensus, normalizeAssetMarket } from './asset-intelligence.js';

test('normalizes CCXT spot and derivatives into a common instrument schema',()=>{
 const spot=normalizeAssetMarket('binance',{id:'BTCUSDT',symbol:'BTC/USDT',base:'BTC',quote:'USDT',spot:true,active:true});
 const perp=normalizeAssetMarket('bybit',{id:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',swap:true,contract:true,linear:true,contractSize:.001,active:true});
 assert.equal(spot.assetClass,'crypto_spot');assert.equal(perp.assetClass,'crypto_perpetual');assert.equal(perp.contractSize,.001);assert.equal(perp.linear,true);
 const margin=normalizeAssetMarket('binance',{id:'ETHUSDT',symbol:'ETH/USDT',base:'ETH',quote:'USDT',spot:true,margin:true,active:true});assert.equal(margin.marginEnabled,true);
});

test('rejects stale, future, missing and invalid quote evidence',()=>{
 const now=Date.now();
 assert.equal(assessQuoteQuality({provider:'a',price:10,currency:'USD',timestamp:now},now).valid,true);
 assert.equal(assessQuoteQuality({provider:'iso',price:10,currency:'USD',timestamp:new Date(now).toISOString()},now).valid,true);
 assert.ok(assessQuoteQuality({provider:'b',price:10,currency:'USD',timestamp:now-60000},now).reasons.includes('stale_observation'));
 assert.ok(assessQuoteQuality({provider:'c',price:10,currency:'USD',timestamp:now+30000},now).reasons.includes('future_timestamp'));
 assert.ok(assessQuoteQuality({provider:'d',price:0,currency:'USD',timestamp:now},now).reasons.includes('invalid_or_missing_price'));
});

test('builds median consensus and flags outliers without hiding provider rows',()=>{
 const now=Date.now(),obs=[
  {provider:'a',price:100,currency:'USD',timestamp:now},
  {provider:'b',price:100.1,currency:'USD',timestamp:now},
  {provider:'c',price:99.9,currency:'USD',timestamp:now},
  {provider:'d',price:130,currency:'USD',timestamp:now}
 ];
 const result=buildAssetQuoteConsensus(obs,{now});
 assert.equal(result.sourceCount,3);assert.equal(result.sources.find(x=>x.provider==='d').outlier,true);assert.equal(result.confidence,'high');
});

test('withholds consensus when source currencies conflict',()=>{
 const now=Date.now(),result=buildAssetQuoteConsensus([
  {provider:'a',price:100,currency:'USD',timestamp:now},
  {provider:'b',price:80,currency:'EUR',timestamp:now}
 ],{now});
 assert.equal(result.status,'currency_conflict');assert.equal(result.consensusPrice,null);
});
