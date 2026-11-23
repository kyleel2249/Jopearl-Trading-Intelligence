import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolioStress } from './portfolio-stress.js';
const fixture=()=>({assets:[
 {symbol:'BTC/USDT',quoteCurrency:'USDT',marketValue:60000,returns:Array.from({length:100},(_,i)=>Math.sin(i*.31)*.02)},
 {symbol:'ETH/USDT',quoteCurrency:'USDT',marketValue:40000,returns:Array.from({length:100},(_,i)=>Math.cos(i*.19)*.025)}
],scenarios:[{name:'Risk-off',shocks:{'BTC/USDT':-20,'ETH/USDT':-30}}]});
test('calculates historical VaR, expected shortfall, drawdown and scenario loss',()=>{
 const r=calculatePortfolioStress(fixture());
 assert.equal(r.quoteCurrency,'USDT');assert.equal(r.observations,100);
 assert.ok(r.historical.var95Percent>0);assert.ok(r.historical.expectedShortfall95Percent>=r.historical.var95Percent);
 assert.equal(r.scenarios[0].estimatedPnl,-24000);assert.equal(r.scenarios[0].lossPercent,24);
});
test('rejects cross-currency and unaligned portfolios',()=>{
 const f=fixture();f.assets[1].quoteCurrency='USD';assert.throws(()=>calculatePortfolioStress(f),/one explicit quote currency/);
 const g=fixture();g.assets[1].returns.pop();assert.throws(()=>calculatePortfolioStress(g),/30 aligned/);
});
test('rejects missing scenario shocks and duplicate symbols',()=>{
 const f=fixture();f.scenarios[0].shocks={};assert.throws(()=>calculatePortfolioStress(f),/requires a shock/);
 const g=fixture();g.assets[1].symbol=g.assets[0].symbol;assert.throws(()=>calculatePortfolioStress(g),/unique/);
});
