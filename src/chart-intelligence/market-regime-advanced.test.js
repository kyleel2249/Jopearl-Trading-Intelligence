import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRegimeDynamics } from './market-regime-advanced.js';

function prices(n,{drift=0,noise=.01,seed=7}={}){
  let p=100,s=seed;const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};
  return Array.from({length:n},()=>{p*=Math.exp(drift+(rnd()-.5)*noise);return p;});
}
test('MR-3.0 dynamics returns bounded change-point, Hurst and volatility diagnostics',()=>{
  const r=analyzeRegimeDynamics({closes:prices(180,{drift:.0003}),regimeHistory:Array(30).fill('trending-up'),currentState:'trending-up'});
  assert.equal(r.model,'JPTI-MR-3.0-DYNAMICS');
  assert.ok(r.changePoint.score>=0&&r.changePoint.score<=1);
  assert.ok(r.hurst.exponent>=.05&&r.hurst.exponent<=.95);
  assert.equal(r.volatilityClustering.status,'ready');
  assert.equal(r.guardrails.lookAhead,false);
});
test('transition forecast probabilities are normalised and use smoothed transitions',()=>{
  const history=['ranging','trending-up','trending-up','ranging','trending-up','trending-up','trending-up','ranging','trending-up','trending-up','trending-up','trending-up'];
  const r=analyzeRegimeDynamics({closes:prices(80),regimeHistory:history,currentState:'trending-up'});
  const sum=Object.values(r.transitionForecast.probabilities).reduce((a,b)=>a+b,0);
  assert.ok(Math.abs(sum-1)<.002);
  assert.equal(r.transitionForecast.status,'ready');
  assert.ok(r.transitionForecast.observations>=11);
});
test('short inputs fail safely without fabricated statistical estimates',()=>{
  const r=analyzeRegimeDynamics({closes:[100,101,100],regimeHistory:[],currentState:'transitional'});
  assert.equal(r.changePoint.status,'insufficient');
  assert.equal(r.hurst.status,'insufficient');
  assert.equal(r.volatilityClustering.status,'insufficient');
  assert.equal(r.transitionForecast.status,'warming-up');
  assert.ok(!JSON.stringify(r).includes('NaN'));
});
test('abrupt return-distribution shift raises the change-point score',()=>{
  const stable=prices(120,{noise:.001,seed:3});
  let p=stable.at(-1);const shifted=[...stable];
  for(let i=0;i<20;i++){p*=Math.exp((i%2?1:-1)*.035);shifted.push(p);}
  const a=analyzeRegimeDynamics({closes:stable,currentState:'ranging'});
  const b=analyzeRegimeDynamics({closes:shifted,currentState:'volatile'});
  assert.ok(b.changePoint.score>a.changePoint.score);
});
