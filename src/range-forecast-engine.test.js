import test from 'node:test';
import assert from 'node:assert/strict';
import {forecast24h} from './range-forecast-engine.js';
const sample=()=>{let rows=[],p=100;for(let i=0;i<90;i++){const t=1700000000000+i*3600000,o=p;p*=1+(Math.sin(i*.43)*.001+Math.cos(i*.17)*.0007);const c=p;rows.push([t,o,Math.max(o,c)*1.001,Math.min(o,c)*.999,c,100+i]);}return rows;};
test('RFE produces valid finite range levels for healthy OHLCV',()=>{const f=forecast24h(sample(),{simulations:400,now:1});assert.equal(f.status,'ready');assert.ok(f.forecast.medianHigh>f.currentPrice);assert.ok(f.forecast.medianLow<f.currentPrice);assert.equal(f.steps,24);assert.equal(f.simulations,400);});
test('RFE flags insufficient samples rather than fabricate a forecast',()=>{const f=forecast24h(sample().slice(0,20));assert.equal(f.status,'insufficient');});
test('RFE bounds and probabilities stay in expected ranges',()=>{const f=forecast24h(sample(),{simulations:500,now:1});assert.ok(f.forecast.high90[1]>=f.forecast.high70[1]);assert.ok(f.forecast.low90[0]<=f.forecast.low70[0]);for(const p of Object.values(f.probabilities))if(p!=null)assert.ok(p>=0&&p<=1);});
