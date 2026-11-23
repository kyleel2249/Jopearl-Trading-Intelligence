import assert from 'node:assert/strict';
import { analyzeSmc } from '../src/chart-intelligence/smc.js';
import { analyzeChartIntelligence } from '../src/chart-intelligence/engine.js';
import { volumeProfile } from '../src/chart-intelligence/levels.js';

const interval = 15 * 60 * 1000;
const candles = [];
let close = 100;
for (let i = 0; i < 360; i++) {
  const drift = i < 100 ? 0.035 : i < 180 ? -0.028 : i < 260 ? 0.045 : -0.012;
  const wave = Math.sin(i / 5.2) * 0.72 + Math.sin(i / 13) * 0.38;
  const open = close;
  close = Math.max(10, close + drift + wave * 0.22);
  const high = Math.max(open, close) + 0.35 + Math.abs(Math.sin(i * 1.7)) * 0.28;
  const low = Math.min(open, close) - 0.32 - Math.abs(Math.cos(i * 1.3)) * 0.24;
  const volume = 100 + (i % 17) * 11 + (i % 29 === 0 ? 500 : 0);
  candles.push([1700000000000 + i * interval, open, high, low, close, volume]);
}

const profile = volumeProfile(candles.slice(-300), { bins: 64, valueAreaPct: 0.7 });
assert.ok(profile && profile.bins.length === 64, 'Volume Profile returns its price distribution');
assert.ok(profile.vah > profile.poc && profile.poc > profile.val, 'POC sits inside the value area');

const smc = analyzeSmc(candles);
assert.equal(smc.status, 'ready', 'SMC analysis reaches ready state');
assert.ok(smc.items.some((item) => item.kind === 'DISPLACEMENT') || smc.items.some((item) => item.layer === 'structure'), 'SMC produces structural evidence');
assert.ok(smc.items.every((item) => item.source?.module && item.source?.method && item.source?.basis), 'Every SMC annotation has provenance');

const result = analyzeChartIntelligence(candles, {
  exchange: 'bitget', symbol: 'BTC/USDT', timeframe: '15m',
  now: candles.at(-1)[0] + interval + 1, historyBars: 20
});
assert.equal(result.status, 'ready', 'Integrated chart engine reaches ready state');
assert.equal(result.volumeProfile?.bins?.length, 64, 'Integrated result exposes the histogram for the chart');
assert.ok(Array.isArray(result.layers.volumeNodes), 'HVN/LVN layer is present');
assert.ok(Array.isArray(result.layers.orderBlocks) && Array.isArray(result.layers.fvg), 'OB and FVG chart layers are present');
assert.ok(Array.isArray(result.layers.structure) && Array.isArray(result.layers.sweeps), 'Structure and liquidity-sweep layers are present');
assert.ok(result.provenance.some((item) => item.layer === 'volumeNodes'), 'Volume-node provenance is reported');

console.log(JSON.stringify({
  status: 'ok',
  candles: candles.length,
  volumeProfileBins: result.volumeProfile.bins.length,
  volumeNodes: result.layers.volumeNodes.length,
  orderBlocks: result.layers.orderBlocks.length,
  fairValueGaps: result.layers.fvg.length,
  structureEvents: result.layers.structure.length,
  liquiditySweeps: result.layers.sweeps.length
}, null, 2));
