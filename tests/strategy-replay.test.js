import test from 'node:test';
import assert from 'node:assert/strict';
import {replayStrategy} from '../src/strategy-replay-engine.js';
function risingCandles(count=650){const rows=[];let p=100;for(let i=0;i<count;i++){const drift=.8+Math.sin(i/8)*.025;p+=drift;rows.push([1700000000000+i*60000,p-.04,p+.22,p-.18,p,1000+(i%11)*20]);}return rows;}
test('replay is chronological, uses closed-bar decision inputs and applies execution costs',()=>{const result=replayStrategy({candles:risingCandles(),strategyId:'trend',monteCarloIterations:200});assert.equal(result.status,'completed');assert.equal(result.replay.lookaheadBias,false);assert.equal(result.replay.chronological,true);assert.equal(result.replay.decisionEngine,'derivePaperSignal');assert.ok(result.backtest.closedTrades>0);assert.ok(result.trades.every(t=>t.netPnlUsd<=t.grossPnlUsd));assert.equal(result.replay.executionModel.feeRate,.0006);});
test('replay reports held-out results and Monte Carlo drawdown',()=>{const result=replayStrategy({candles:risingCandles(),strategyId:'trend',monteCarloIterations:100});assert.ok(result.split.heldOut>0);assert.ok(result.outOfSample);assert.equal(result.monteCarlo.iterations,100);assert.ok(result.monteCarlo.p95DrawdownPct>=0);});
test('insufficient candle history fails closed',()=>{assert.equal(replayStrategy({candles:risingCandles(30)}).status,'insufficient_data');});
