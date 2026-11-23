import test from 'node:test';
import assert from 'node:assert/strict';
import { runDeterministicReplay } from './market-replay.js';
const candles=()=>Array.from({length:160},(_,i)=>{const close=100+Math.sin(i/8)*4+i*.03;return{timestamp:1700000000000+i*3600000,open:close-.1,high:close+.5,low:close-.5,close,volume:1000+i};});
test('replays chronological candles with next-open fills and fee/slippage accounting',()=>{
 const r=runDeterministicReplay({candles:candles(),strategy:'ema_cross',fastPeriod:5,slowPeriod:12});
 assert.equal(r.data.candleCount,160);assert.equal(r.data.chronological,true);assert.equal(r.validation.splitPolicy.startsWith('chronological'),true);assert.ok(Number.isFinite(r.performance.finalEquity));assert.ok(r.trades.every(t=>t.exitAt>t.entryAt));
});
test('supports breakout strategy and bounds returned audit series',()=>{
 const r=runDeterministicReplay({candles:candles(),strategy:'breakout',lookback:10});assert.equal(r.strategy,'breakout');assert.ok(r.equityCurve.length<=500);
});
test('rejects unordered, malformed and too-short candle sets',()=>{
 const c=candles();c[20].timestamp=c[19].timestamp;assert.throws(()=>runDeterministicReplay({candles:c}),/strictly chronological/);
 assert.throws(()=>runDeterministicReplay({candles:candles().slice(0,20)}),/60–20,000/);
});
test('rejects unknown strategies and unrealistic fee parameters',()=>{
 assert.throws(()=>runDeterministicReplay({candles:candles(),strategy:'ml_magic'}),/Supported replay/);
 assert.throws(()=>runDeterministicReplay({candles:candles(),feeBps:5000}),/outside valid bounds/);
});
