import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandleFormation } from './candle-formation.js';

const H=3600000;
const flat=()=>Array.from({length:30},(_,i)=>[i*H,100,101,99,100,100]);
test('CFIE identifies bullish hammer, bearish shooting star and engulfing patterns',()=>{
 const rows=flat();rows[30]=[30*H,100,101,97,100.6,260];
 const r=analyzeCandleFormation(rows);
 assert.equal(r.status,'ready');assert.ok(r.patterns.some(x=>x.kind==='HAMMER'));
 const engulf=flat();engulf[30]=[30*H,101,101.2,99.8,100,100];engulf[31]=[31*H,100.5,104,100.2,103.8,240];
 assert.ok(analyzeCandleFormation(engulf).patterns.some(x=>x.kind==='BULLISH_ENGULFING'));
 const bear=flat();bear[30]=[30*H,100,104,99.8,100.2,250];assert.ok(analyzeCandleFormation(bear).patterns.some(x=>x.kind==='SHOOTING_STAR'));
});
test('CFIE detects morning-star and evening-star three-candle sequences',()=>{
 const morning=flat();morning[30]=[30*H,100,100.2,97.8,98,100];morning[31]=[31*H,98,98.2,97.8,98,100];morning[32]=[32*H,98,101.2,97.9,101,180];
 assert.ok(analyzeCandleFormation(morning).patterns.some(x=>x.kind==='MORNING_STAR'));
 const evening=flat();evening[30]=[30*H,98,100.2,97.8,100,100];evening[31]=[31*H,100,100.2,99.8,100,100];evening[32]=[32*H,100,100.1,96.8,97,180];
 assert.ok(analyzeCandleFormation(evening).patterns.some(x=>x.kind==='EVENING_STAR'));
});
test('CFIE star patterns need a big first candle and a SMALL middle candle (regression: the body check was on the wrong candle)',()=>{
 const kinds=(rows)=>analyzeCandleFormation(rows).patterns.map(x=>x.kind);
 // Realistic star: the middle candle has a small but non-zero body, so it is not an exact doji.
 const morning=flat();morning[30]=[30*H,100,100.2,97.8,98,100];morning[31]=[31*H,98,98.5,97.5,98.2,100];morning[32]=[32*H,98.2,101.2,98.1,101,180];
 assert.ok(kinds(morning).includes('MORNING_STAR'));
 const evening=flat();evening[30]=[30*H,98,100.2,97.8,100,100];evening[31]=[31*H,100,100.5,99.5,99.8,100];evening[32]=[32*H,99.8,99.9,96.8,97,180];
 assert.ok(kinds(evening).includes('EVENING_STAR'));
 // A large-bodied middle candle is not a star, so it must not form one.
 const notStar=flat();notStar[30]=[30*H,100,100.2,97.8,98,100];notStar[31]=[31*H,98,99.6,97.9,99.5,100];notStar[32]=[32*H,99.5,101.2,99.4,101,180];
 assert.ok(!kinds(notStar).includes('MORNING_STAR'));
 // A weak first candle is not a star setup either.
 const weakFirst=flat();weakFirst[30]=[30*H,100,102,97.8,99.9,100];weakFirst[31]=[31*H,99.9,100.1,99.7,99.9,100];weakFirst[32]=[32*H,99.9,101.2,99.8,101,180];
 assert.ok(!kinds(weakFirst).includes('MORNING_STAR'));
});
test('CFIE computes bounded candle DNA, pressure, rejection and heuristic bias',()=>{
 const rows=flat();rows[30]=[30*H,100,101,98,100.8,500];
 const r=analyzeCandleFormation(rows);
 for(const k of ['bodyPct','upperWickPct','lowerWickPct','closeLocation','volumeRatio','pressure'])assert.ok(Number.isFinite(r.latest[k]));
 assert.ok(r.latest.pressureScore>=0&&r.latest.pressureScore<=100);
 assert.ok(r.summary.bullishProbability>=0&&r.summary.bullishProbability<=100);
 assert.match(r.summary.basis,/not a calibrated probability/);
});
test('CFIE flags high-range/high-volume anomaly and estimated absorption without claiming tick data',()=>{
 const rows=flat();rows[30]=[30*H,100,100.3,96,100.1,600];
 const r=analyzeCandleFormation(rows);
 assert.equal(r.latest.anomaly,true);assert.equal(r.latest.absorption,true);
 assert.equal(r.latest.patterns[0].source.basis,'ohlcv-derived');
});
test('CFIE rejects malformed input and never emits NaN',()=>{
 assert.equal(analyzeCandleFormation([[1,2,1,3,4,5]]).status,'insufficient');
 const r=analyzeCandleFormation(flat());assert.ok(!JSON.stringify(r).includes('NaN'));
});
