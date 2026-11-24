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
  const a=Array.from({length:16},(_,i)=>[i*60000,0,0,0,100*Math.pow(1.01,i),1]);
  const b=Array.from({length:16},(_,i)=>[i*60000,0,0,0,200*Math.pow(0.99,i),1]);
  const result=correlateCandleSeries(a,b,'TESTUSDT','1h');
  assert.equal(result.status,'measured');
  assert.ok(result.correlation < -0.99);
});
