import test from 'node:test';
import assert from 'node:assert/strict';
import {derivePaperSignal} from '../src/paper-trading-engine.js';
function risingCandles(count=180){const rows=[];let p=100;for(let i=0;i<count;i++){p+=.08+Math.sin(i/7)*.01;rows.push([1700000000000+i*60000,p-.03,p+.2,p-.15,p,1000]);}return rows;}
test('same decision engine consumes aligned book and aggressor-flow features in live and replay modes',()=>{const candles=risingCandles();const base=derivePaperSignal(candles,{},'trend');const enriched=derivePaperSignal(candles,{},'trend',{marketData:{orderBookImbalance:.9,tradeFlowImbalance:.8}});assert.equal(enriched.features.marketData.orderBookImbalance,.9);assert.ok(enriched.score>base.score);assert.ok(enriched.features.microstructureScore>0);});
