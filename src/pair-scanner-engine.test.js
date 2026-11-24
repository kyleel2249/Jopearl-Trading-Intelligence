import test from 'node:test';
import assert from 'node:assert/strict';
import { pearsonCorrelation, candleReturns, correlateCandleSeries } from './pair-scanner-engine.js';

test('Pearson correlation distinguishes inverse and aligned returns', () => {
  assert.ok(Math.abs(pearsonCorrelation([1,2,3,4],[4,3,2,1]) + 1) < 1e-12);
  assert.ok(Math.abs(pearsonCorrelation([1,2,3,4],[2,4,6,8]) - 1) < 1e-12);
});
test('Pearson correlation returns null for insufficient or constant data', () => {
  assert.equal(pearsonCorrelation([1,2],[2,1]), null);
  assert.equal(pearsonCorrelation([1,1,1],[2,3,4]), null);
});
test('candleReturns sorts candles and computes log returns', () => {
  const rows=[[3000,0,0,0,3,1],[1000,0,0,0,1,1],[2000,0,0,0,2,1]];
  const result=candleReturns(rows);
  assert.equal(result.length,2);
  assert.equal(result[0][0],2000);
  assert.ok(Math.abs(result[0][1]-Math.log(2))<1e-12);
});
test('correlation aligns candles by timestamp rather than array position', () => {
  const factors=[1.01,1.02,0.99,1.03,0.98,1.015,0.995,1.04,0.97,1.025,0.985,1.012,0.992,1.035,0.975];
  const pricesA=[100],pricesB=[200];
  for(const factor of factors){pricesA.push(pricesA.at(-1)*factor);pricesB.push(pricesB.at(-1)/factor);}
  const a=pricesA.map((close,i)=>[i*3600000,0,0,0,close,1]);
  const b=pricesB.map((close,i)=>[i*3600000,0,0,0,close,1]);
  const result=correlateCandleSeries(a,b,'TESTUSDT','1h');
  assert.equal(result.status,'measured');
  assert.ok(result.correlation < -0.99);
});
