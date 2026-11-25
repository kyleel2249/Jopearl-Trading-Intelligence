import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFvgLiquidity } from './fvg-liquidity.js';
import { assessWalletAttribution, aggregateAttributedWalletSwapFlows } from './wallet-attribution.js';
import { aggregateCrossExchangeFlows } from './cross-exchange-flows.js';
import { normalizeBisFlows } from './bis-flows.js';
import { predictEventImpact } from './event-impact.js';

const now=Date.parse('2026-11-25T12:00:00Z');
const candles=Array.from({length:12},(_,i)=>[now-(11-i)*60_000,100+i*.2,101+i*.2,99+i*.2,100.5+i*.2,1000]);
const at=i=>candles[i][0];

test('FVG-liquidity correlates a sweep, displacement, structure shift and fresh gap',()=>{
  const smc={items:[
    {id:'sweep',kind:'LIQUIDITY_SWEEP',direction:'bullish',ts:at(2),price:99,poolType:'EQL',quality:.9},
    {id:'disp',kind:'DISPLACEMENT',direction:'bullish',ts:at(3),strength:.9},
    {id:'mss',kind:'MSS',direction:'bullish',ts:at(3)},
    {id:'fvg',kind:'FVG',direction:'bullish',ts:at(4),top:103,bottom:101,fillPct:0,status:'active'}
  ],liquidity:{pools:[{kind:'EXTERNAL',side:'high',price:110},{kind:'EQL',side:'low',price:99}]}};
  const result=analyzeFvgLiquidity(smc,candles,{atr:2,timeframeMs:60_000,now});
  assert.equal(result.status,'ready');
  assert.equal(result.setups.length,1);
  assert.equal(result.setups[0].direction,'bullish');
  assert.equal(result.setups[0].confirmations.displacement,true);
  assert.equal(result.setups[0].confirmations.structure,true);
  assert.equal(result.setups[0].fvg.lifecycle,'fresh');
  assert.equal(result.setups[0].targets[0].price,110);
});

test('wallet attribution refuses unverified labels and accepts explicit verified registry evidence',()=>{
  const address='0x1111111111111111111111111111111111111111';
  const unverified=assessWalletAttribution({chain:'ethereum',address,claims:[{type:'provider-verified-label',verified:false,source:'example',sourceUrl:'https://example.com'}]});
  assert.equal(unverified.verified,false);
  const verified=assessWalletAttribution({chain:'ethereum',address,claims:[{type:'official-entity-registry',verified:true,registryRecordId:'REG-1',entityName:'Example Exchange',entityType:'exchange',source:'official-registry',sourceUrl:'https://example.com/registry'}]});
  assert.equal(verified.verified,true);
  const flows=aggregateAttributedWalletSwapFlows([{chainId:'ethereum',trader:address,side:'buy',amountUsd:100,timestamp:now}], [verified], {now});
  assert.equal(flows.verifiedTrades,1);
  assert.equal(flows.netflowUsd,100);
});

test('cross-exchange aggregation excludes stale venues and scores fresh evidence',()=>{
  const result=aggregateCrossExchangeFlows([
    {venue:'binance',timestamp:new Date(now).toISOString(),orderBookImbalance:.4,fundingRate:.0001},
    {venue:'okx',timestamp:new Date(now-10*60_000).toISOString(),orderBookImbalance:-.8}
  ],{now,maxAgeMs:180_000});
  assert.equal(result.venueCount,1);
  assert.equal(result.rejected.length,1);
  assert.equal(result.bias,'buy-pressure');
});

test('BIS normalizer preserves period, value and reporting metadata',()=>{
  const result=normalizeBisFlows({dataset:'WS_LBS_D_PUB',data:[
    {period:'2026-06',value:'125.5',reporter:'US',counterparty:'GB',measure:'claims'},
    {period:'2026-09',value:'130.5',reporter:'US',counterparty:'GB',measure:'claims'}
  ]},{now});
  assert.equal(result.status,'ready');
  assert.equal(result.latest.value,130.5);
  assert.equal(result.change,5);
});

test('event-impact model ranks imminent high-impact events without inventing direction',()=>{
  const result=predictEventImpact({now,events:[{id:'fomc',title:'Central bank rate decision',time:new Date(now+30*60_000).toISOString(),importance:'critical',source:'official-calendar'}]});
  assert.equal(result.active,true);
  assert.equal(result.events[0].direction,'neutral');
  assert.ok(result.impactScore>=80);
});
