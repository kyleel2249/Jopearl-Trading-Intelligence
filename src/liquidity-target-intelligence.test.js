import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLiquidityTargets, backtestLiquidityPatterns } from './liquidity-target-intelligence.js';

const row=(t,o,h,l,c,v=100)=>[t,o,h,l,c,v];
const base=Date.parse('2026-11-20T00:00:00Z');
const bars=Array.from({length:40},(_,i)=>{const mid=100+Math.sin(i*.8)*2;return row(base+i*900000,mid,mid+1,mid-1,mid+.1,100);});

test('ranks confirmed equal highs and lows as opposing liquidity pools',()=>{
 const rows=bars.slice();
 rows[8]=row(base+8*900000,101,104,100,102);
 rows[16]=row(base+16*900000,102,104.01,101,103);
 rows[12]=row(base+12*900000,102,103,98,100);\n rows[13]=row(base+13*900000,100,101,99.5,100,100);
 rows[24]=row(base+24*900000,100,102,98.01,99);
 const out=analyzeLiquidityTargets(rows,{timeframe:'15m',now:base+41*900000});
 assert.equal(out.status,'ready');
 assert.ok(out.pools.buySide.some(p=>p.equal));
 assert.ok(out.pools.sellSide.some(p=>p.equal));
 assert.ok(out.pools.buySide.every(p=>p.price>out.last));
 assert.ok(out.pools.sellSide.every(p=>p.price<out.last));
});

test('returns safe insufficient state for thin history',()=>{
 assert.equal(analyzeLiquidityTargets(bars.slice(0,6),{timeframe:'15m',now:base+10*900000}).status,'insufficient');
});

test('backtest reports ambiguous same-candle stop and target separately from wins',()=>{
 const out=backtestLiquidityPatterns(bars,{timeframe:'15m',horizon:5});
 assert.ok(Number.isInteger(out.sampleSize));
 assert.ok(out.resolved<=out.sampleSize);
 assert.ok(out.winRate===null||(out.winRate>=0&&out.winRate<=100));
 assert.ok(out.methodology.includes('ambiguous'));
});

test('detects a bullish liquidity sweep and reclaim as a watch candidate',()=>{
 const rows=bars.slice();
 rows[8]=row(base+8*900000,101,104,100,102);
 rows[16]=row(base+16*900000,102,104.01,101,103);
 rows[12]=row(base+12*900000,102,103,98,100);
 rows[13]=row(base+13*900000,100,101,99.5,100,100);
 rows[24]=row(base+24*900000,100,102,98.01,99);
 rows.push(row(base+40*900000,97.8,99.8,97.5,99.4,180));
 const out=analyzeLiquidityTargets(rows,{timeframe:'15m',now:base+41*900000});
 assert.equal(out.setup?.direction,'bullish');
 assert.ok(out.setup?.score>=65);
 assert.ok(out.setup?.rewardRisk>=1.5);
});
