import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateRiskParityAllocation } from './portfolio-allocation.js';

const fixture=()=>({assets:[
 {symbol:'BTC/USDT',quoteCurrency:'USDT',returns:Array.from({length:60},(_,i)=>Math.sin(i*.3)*.02+Math.cos(i*.07)*.003),maxWeight:.7},
 {symbol:'ETH/USDT',quoteCurrency:'USDT',returns:Array.from({length:60},(_,i)=>Math.sin(i*.3)*.012+Math.cos(i*.11)*.002),maxWeight:.7},
 {symbol:'SOL/USDT',quoteCurrency:'USDT',returns:Array.from({length:60},(_,i)=>Math.cos(i*.21)*.03+Math.sin(i*.09)*.002),maxWeight:.7}
]});
test('computes bounded covariance-aware risk parity weights summing to one',()=>{
 const r=calculateRiskParityAllocation(fixture());
 assert.ok(Math.abs(r.weights.reduce((s,x)=>s+x.weight,0)-1)<1e-7);
 assert.ok(r.weights.every(x=>x.weight>=0&&x.weight<=.7));
 assert.ok(Math.abs(r.riskContributionsSumPercent-100)<1e-6);
 assert.ok(r.annualizedVolatilityPercent>0);
});
test('rejects mixed quote currencies instead of inventing FX conversions',()=>{
 const f=fixture();f.assets[2].quoteCurrency='USD';
 assert.throws(()=>calculateRiskParityAllocation(f),/one explicit quote currency/);
});
test('rejects unaligned or insufficient return observations',()=>{
 const f=fixture();f.assets[1].returns=f.assets[1].returns.slice(0,20);
 assert.throws(()=>calculateRiskParityAllocation(f),/30 aligned/);
});
test('supports low-volatility series and rejects duplicate instruments',()=>{
 const f=fixture();f.assets.forEach((a,i)=>a.returns=a.returns.map(v=>v*1e-5*(i+1)));
 const r=calculateRiskParityAllocation(f);assert.ok(Math.abs(r.weights.reduce((s,x)=>s+x.weight,0)-1)<1e-7);
 const duplicate=fixture();duplicate.assets[1].symbol=duplicate.assets[0].symbol;
 assert.throws(()=>calculateRiskParityAllocation(duplicate),/unique, non-empty symbol/);
});
test('rejects impossible allocation bounds and zero volatility assets',()=>{
 const f=fixture();f.assets[0].maxWeight=.2;f.assets[1].maxWeight=.2;f.assets[2].maxWeight=.2;
 assert.throws(()=>calculateRiskParityAllocation(f),/cannot sum to 100/);
 const z=fixture();z.assets[0].returns=Array(60).fill(0);
 assert.throws(()=>calculateRiskParityAllocation(z),/Zero or invalid volatility/);
});
