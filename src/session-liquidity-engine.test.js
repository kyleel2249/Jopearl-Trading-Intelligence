import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze24hLiquidity, timeframeToMs } from './session-liquidity-engine.js';

const candle=(t,o,h,l,c,v=10)=>[t,o,h,l,c,v];
const ts=(day,hour,minute=0)=>Date.UTC(2026,10,20+day,hour,minute);

test('timeframe parser supports minute, hour, day and week bars',()=>{
 assert.equal(timeframeToMs('15m'),900000);
 assert.equal(timeframeToMs('4h'),14400000);
 assert.equal(timeframeToMs('1d'),86400000);
 assert.equal(timeframeToMs('1w'),604800000);
});

test('uses exchange ticker for authoritative rolling 24-hour high and low',()=>{
 const now=Date.parse('2026-11-20T14:00:00Z');
 const rows=[candle(now-3600000,100,105,99,104),candle(now-1800000,104,106,101,105)];
 const out=analyze24hLiquidity(rows,{now,timeframe:'30m',ticker:{high:110,low:95,last:105,percentage:2.5}});
 assert.equal(out.status,'ready');
 assert.equal(out.levels.high.price,110);
 assert.equal(out.levels.low.price,95);
 assert.equal(out.levels.high.source,'exchange-24h-ticker');
 assert.equal(out.change24h,2.5);
});

test('falls back to candles and attributes matching extremes to the originating session',()=>{
 const now=Date.parse('2026-11-20T14:00:00Z');
 const rows=[
  candle(Date.parse('2026-11-20T08:00:00Z'),100,108,99,105),
  candle(Date.parse('2026-11-20T07:00:00Z'),105,106,96,100),
  candle(Date.parse('2026-11-20T13:00:00Z'),100,104,98,102)
 ];
 const out=analyze24hLiquidity(rows,{now,timeframe:'1h'});
 assert.equal(out.levels.high.price,108);
 assert.equal(out.levels.low.price,96);
 assert.equal(out.levels.high.session,'Tokyo + London');
 assert.equal(out.levels.low.session,'Tokyo');
});

test('calculates range position, previous UTC day and safe insufficient history',()=>{
 const now=Date.parse('2026-11-20T14:00:00Z');
 const rows=[
  candle(Date.parse('2026-11-19T10:00:00Z'),90,101,88,95),
  candle(Date.parse('2026-11-20T08:00:00Z'),95,110,90,105)
 ];
 const out=analyze24hLiquidity(rows,{now,timeframe:'1h'});
 assert.equal(out.levels.previousUtcDay.high,101);
 assert.equal(out.levels.previousUtcDay.low,88);
 assert.equal(out.range.positionPercent,75);
 assert.equal(analyze24hLiquidity([],{now}).status,'insufficient');
});

test('flags high sweep reclaim and abnormal range/volume without authorizing trades',()=>{
 const now=Date.parse('2026-11-20T14:00:00Z');
 const rows=[
  candle(now-4*3600000,100,105,99,103,10),
  candle(now-3*3600000,103,104,100,102,10),
  candle(now-2*3600000,102,106,101,105,10),
  candle(now-3600000,105,125,104,104,100)
 ];
 const out=analyze24hLiquidity(rows,{now,timeframe:'1h',ticker:{high:125,low:99,last:104}});
 assert.ok(out.alerts.some(alert=>alert.code==='HIGH_SWEEP_RECLAIM'));
 assert.ok(out.alerts.some(alert=>alert.code==='RANGE_EXPANSION'));
 assert.ok(out.alerts.some(alert=>alert.code==='VOLUME_EXPANSION'));
});
