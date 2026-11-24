import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sessionForecastAdjustment, detectSessionLiquiditySweeps, sessionRiskAssessment, sessionPerformanceComparison, summarizeSessionMemory, recordSessionOutcome, readSessionMemory } from './session-trading-intelligence.js';

const candle=(t,o,h,l,c,v=100)=>[t,o,h,l,c,v];
describe('session trading intelligence',()=>{
 it('returns safe insufficient forecast for empty candles',()=>assert.equal(sessionForecastAdjustment([]).status,'insufficient'));
 it('calculates forecast adjustment with sufficient session samples',()=>{const rows=[];for(let i=0;i<100;i++){const t=Date.UTC(2026,10,2,8,i*15);const p=100+i*.15;rows.push(candle(t,p,p+.3,p-.1,p+.2));}const out=sessionForecastAdjustment(rows,{now:Date.UTC(2026,10,2,10)});assert.ok(['ready','insufficient'].includes(out.status));assert.ok(out.confidence>=5&&out.confidence<=95);});
 it('returns liquidity sweep report with stable schema',()=>{const rows=Array.from({length:50},(_,i)=>candle(Date.UTC(2026,10,1)+i*3600000,100,101,99,100+i*.01));const out=detectSessionLiquiditySweeps(rows);assert.ok(['ready','insufficient'].includes(out.status));assert.ok(Array.isArray(out.events)&&Array.isArray(out.levels));});
 it('reduces risk for low liquidity or abnormal range and never authorizes orders',()=>{const rows=Array.from({length:30},(_,i)=>candle(Date.UTC(2026,10,1)+i*3600000,100,101,99,100));const out=sessionRiskAssessment(rows,{now:Date.UTC(2026,10,1,1),baseRiskPercent:1});assert.ok(out.riskPercent<=1);assert.equal(out.orderAuthorization,false);});
 it('compares session metrics from OHLCV',()=>{const rows=Array.from({length:100},(_,i)=>candle(Date.UTC(2026,10,1)+i*3600000,100,102,98,100+i*.02,50));const out=sessionPerformanceComparison(rows);assert.equal(out.status,'ready');assert.ok(out.sessions.sydney.observations>0);});
 it('aggregates session memory by setup dimensions',()=>{const out=summarizeSessionMemory([{session:'London',symbol:'BTC',strategy:'breakout',volatility:'high',outcome:'win',returnR:2},{session:'London',symbol:'BTC',strategy:'breakout',volatility:'high',outcome:'loss',returnR:-1}]);assert.equal(out[0].trades,2);assert.equal(out[0].winRate,50);assert.equal(out[0].averageR,.5);});
 it('does not convert missing R values into breakeven returns',()=>{const rows=summarizeSessionMemory([{session:'London',symbol:'BTC',strategy:'test',volatility:'normal',outcome:'win',returnR:null},{session:'London',symbol:'BTC',strategy:'test',volatility:'normal',outcome:'loss',returnR:-1}]);assert.equal(rows[0].trades,2);assert.equal(rows[0].averageR,-1);});
 it('rejects invalid session outcome before persistence',()=>assert.equal(recordSessionOutcome({outcome:'bad'}).ok,false));
 it('handles unavailable browser memory cleanly',()=>assert.ok(Array.isArray(readSessionMemory())));
});

 it('detects sweep, reclaim and displacement as separate confirmation stages',()=>{
  const rows=[];
  const ts=(day,hour)=>Date.UTC(2026,10,day,hour);
  for(let hour=0;hour<=8;hour++) rows.push(candle(ts(1,hour),100,101,99,100));
  for(let hour=0;hour<=8;hour++) rows.push(candle(ts(2,hour),100,101,99,100));
  rows.push(candle(ts(2,9),100.7,102,100.6,101.5));
  rows.push(candle(ts(2,10),101.2,101.3,100.6,100.8));
  rows.push(candle(ts(2,11),100.7,100.8,100.0,100.0));
  const result=detectSessionLiquiditySweeps(rows,{now:ts(2,12),confirmationBars:5});
  const stages=result.events.filter(e=>e.session==='Tokyo'&&e.level===101&&e.side==='buy-side').map(e=>e.phase);
  assert.ok(stages.includes('sweep-detected'));
  assert.ok(stages.includes('reclaim-confirmed'));
  assert.ok(stages.includes('displacement-confirmed'));
 });

 it('accepts normalized Alpha candle objects as well as chart array candles',()=>{const rows=Array.from({length:100},(_,i)=>({timestamp:Date.UTC(2026,10,2,8,i*15),open:100+i*.1,high:100.3+i*.1,low:99.9+i*.1,close:100.2+i*.1,volume:100}));const out=sessionForecastAdjustment(rows,{now:Date.UTC(2026,10,2,10)});assert.equal(out.status,'ready');assert.ok(out.sampleCount>0);});
