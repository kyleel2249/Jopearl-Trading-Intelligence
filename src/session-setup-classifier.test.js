import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySessionSetups } from './session-setup-classifier.js';

const c=(t,o,h,l,close,v=100)=>[t,o,h,l,close,v];
const londonTime=(day,hour)=>Date.UTC(2026,10,1+day,hour);

test('returns insufficient when candle history is too short',()=>{
 const r=classifySessionSetups([c(1,1,2,1,1)]);
 assert.equal(r.status,'insufficient');assert.equal(r.selected,null);
});
test('detects first-candle sweep and confirms reclaim/displacement inside the entry window',()=>{
 const rows=[];
 for(let d=0;d<2;d++)for(let h=8;h<=17;h++)rows.push(c(londonTime(d,h),100,101,99,100));
 rows.push(c(londonTime(2,8),100.8,102,100.7,101.5));
 rows.push(c(londonTime(2,9),101.2,101.3,100.6,100.8));
 rows.push(c(londonTime(2,10),100.7,100.8,100,100));
 const result=classifySessionSetups(rows,{now:londonTime(2,12),symbol:'BTC/USDT'});
 const event=result.events.find(e=>e.sessionId==='london'&&e.side==='buy-side'&&e.phase==='displacement-confirmed');
 assert.ok(event,'expected a buy-side sweep setup to be confirmed');
 assert.equal(event.direction,'bearish');assert.equal(event.entryWindowOpen,true);
 assert.equal(result.selected.id,event.id);
});
test('records a failed reclaim when price sweeps but never closes back through level',()=>{
 const rows=[];
 for(let d=0;d<2;d++)for(let h=8;h<=17;h++)rows.push(c(londonTime(d,h),100,101,99,100));
 rows.push(c(londonTime(2,8),101,103,100.8,102),c(londonTime(2,9),102,104,101,103),c(londonTime(2,10),103,105,102,104));
 const result=classifySessionSetups(rows);
 assert.ok(result.events.some(e=>e.phase==='false-sweep'&&e.classification==='failed-reclaim'));
 assert.equal(result.selected,null);
});
test('calculates matching historical expectancy and bounds its influence weight',()=>{
 const rows=[];
 for(let d=0;d<2;d++)for(let h=8;h<=17;h++)rows.push(c(londonTime(d,h),100,101,99,100));
 rows.push(c(londonTime(2,8),100.8,102,100.7,101.5),c(londonTime(2,9),101.2,101.3,100.6,100.8),c(londonTime(2,10),100.7,100.8,100,100));
 const history=Array.from({length:8},()=>({symbol:'BTC/USDT',session:'London',direction:'bearish',setupId:'sweep-reclaim-displacement',outcome:'win',returnR:1.5}));
 const result=classifySessionSetups(rows,{now:londonTime(2,12),symbol:'BTC/USDT',historicalOutcomes:history});
 assert.ok(result.selected,'confirmed setup should be selected');
 assert.equal(result.selected.expectancy.status,'ready');assert.equal(result.selected.expectancy.expectancy,1.5);
 assert.ok(result.selected.modelWeight>=.02&&result.selected.modelWeight<=.12);
});
test('adaptive thresholds increase only from relevant historical false sweeps and are capped',()=>{
 const candles=[];
 for(let d=0;d<2;d++)for(let h=8;h<=17;h++)candles.push(c(londonTime(d,h),100,101,99,100));
 const history=Array.from({length:10},()=>({symbol:'BTC/USDT',session:'London',setupId:'sweep-reclaim-displacement',falseSweep:true,outcome:'loss',returnR:-1}));
 const result=classifySessionSetups(candles,{symbol:'BTC/USDT',historicalOutcomes:history});
 assert.ok(result.sessionSummaries.london.adaptiveDisplacementThreshold>result.adaptivePolicy.thresholdBase);
 assert.ok(result.sessionSummaries.london.adaptiveDisplacementThreshold<=.8);
 assert.equal(result.sessionSummaries.sydney.historicalFalseSweepRate,0,'other sessions must not inherit London false-sweep history');
});
test('rejects malformed OHLC candles without poisoning valid chronological rows',()=>{
 const valid=[c(londonTime(0,8),100,101,99,100),c(londonTime(0,9),100,101,99,100),c(londonTime(1,8),100,101,99,100)];
 const invalid=[c(londonTime(1,9),100,99,101,100),c(londonTime(1,10),100,101,99,100,-1)];
 const result=classifySessionSetups([...valid,...invalid]);
 assert.equal(result.candleCount,3);
});
