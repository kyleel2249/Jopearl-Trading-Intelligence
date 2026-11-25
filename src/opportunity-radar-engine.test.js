import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreOpportunity,correlationFromCandles,buildOpportunityRadar} from './opportunity-radar-engine.js';

const snapshot=(bias='bullish',mis=72)=>({status:'ready',scores:{MIS:mis,directionalBias:bias,confidence:70},domains:{structure:{bias},regime:{label:'bullish trend'},flow:{relativeVolume:1.8}},evidence:[{domain:'Momentum',score:bias==='bullish'?68:32},{domain:'Flow proxy',score:bias==='bullish'?66:34}],conflicts:[]});
const candles=(values,start=1700000000000)=>values.map((v,i)=>[start+i*3600000,v,v*1.01,v*.99,v,100+i]);

test('opportunity score is explainable and never labels a heuristic as probability',()=>{
 const result=scoreOpportunity(snapshot(),{liquidity:{visibleDepth:{imbalancePct:12}}});
 assert.equal(result.direction,'LONG');assert.ok(result.score>=0&&result.score<=100);
 assert.match(result.confidenceType,/not a probability/);assert.ok(result.reasons.length>=3);
});
test('missing context remains a visible data gap and never creates a depth penalty',()=>{
 const result=scoreOpportunity(snapshot(),null);
 assert.equal(result.contextAvailable,false);
 assert.ok(result.riskFlags.includes('NO_LIVE_CONTEXT'));
 assert.ok(Number.isFinite(result.score));
});
test('insufficient candle analysis cannot receive a ranked score',()=>{
 const result=scoreOpportunity({status:'insufficient'});
 assert.equal(result.status,'INSUFFICIENT_DATA');assert.equal(result.score,null);
});
test('correlation aligns candles by timestamp and identifies strongly related returns',()=>{
 const a=candles(Array.from({length:40},(_,i)=>100+i));
 const b=candles(Array.from({length:40},(_,i)=>200+i*2));
 const result=correlationFromCandles(a,b);
 assert.equal(result.status,'READY');assert.ok(result.correlation>.99);assert.equal(result.observations,39);
});
test('correlation detects inverse return behaviour for diversifying candidates',()=>{
 let up=100,down=200;
 const a=[[1700000000000,up,up,up,up,100]],b=[[1700000000000,down,down,down,down,100]];
 for(let i=0;i<40;i++){const r=[.012,-.006,.018,-.011,.004][i%5];const prevUp=up,prevDown=down;up*=1+r;down*=1-r;a.push([1700000000000+(i+1)*3600000,prevUp,up,Math.min(prevUp,up),up,100]);b.push([1700000000000+(i+1)*3600000,prevDown,down,Math.min(prevDown,down),down,100]);}
 const result=correlationFromCandles(a,b);assert.equal(result.status,'READY');assert.ok(result.correlation<-.99);
});
test('correlation rejects insufficient timestamp overlap',()=>{
 assert.equal(correlationFromCandles(candles(Array.from({length:10},(_,i)=>100+i)),candles(Array.from({length:10},(_,i)=>200+i),1800000000000)).status,'INSUFFICIENT_OVERLAP');
});
test('radar ranks available markets and preserves data gaps',()=>{
 const result=buildOpportunityRadar([{symbol:'AAA/USDT',snapshot:snapshot(),candles:candles(Array.from({length:40},(_,i)=>100+i))},{symbol:'BBB/USDT',snapshot:{status:'insufficient'},candles:[]}]);
 assert.equal(result.summary.scanned,2);assert.equal(result.summary.insufficient,1);assert.equal(result.markets[0].symbol,'AAA/USDT');
});
