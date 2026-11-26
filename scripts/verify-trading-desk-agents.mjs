import assert from 'node:assert/strict';
import { evaluateTradingDeskAgents } from '../src/chart-intelligence/trading-desk-agents.js';

const base = {
  now: 1795700000000, symbol: 'BTC/USDT', timeframe: '5m', signal: 'BUY',
  active: { signal: 'BUY', confidence: 82 },
  plan: { entry: 100, stopLoss: 98, targets: [{ name: 'TP1', price: 104, rr: 2.0 }] },
  grade: { points: 82 }, confluence: { score: 0.62 }, conflictSeverity: 0,
  regime: { state: 'trending-up', confidence: 0.82 },
  mtf: [{ timeframe: '15m', status: 'fresh', bias: 0.8 }, { timeframe: '1h', status: 'fresh', bias: 0.7 }],
  smc: { status: 'ready', trend: 1, items: [{ kind: 'LIQUIDITY_SWEEP', direction: 'bullish' }] },
  fvgLiquidity: { setups: [{ id: 's1', direction: 'bullish', state: 'active', score: 86 }] },
  flow: { status: 'ready', summary: { pressure: 0.7 } },
  executionCosts: { spreadPct: 0.0004, slippagePct: 0.0005 }
};
const ready = evaluateTradingDeskAgents(base);
assert.equal(ready.profiles.length, 2);
assert.ok(ready.profiles.every(profile => profile.agents.length === 8));
assert.equal(ready.authority, 'research-and-paper-review-only');
assert.equal(ready.executionAuthority, 'none');
assert.equal(ready.profiles.find(profile => profile.id === 'scalp').status, 'paper-review');
assert.equal(ready.profiles.find(profile => profile.id === 'day').status, 'paper-review');
assert.ok(ready.profiles.every(profile => profile.riskPolicy.maxRiskPercent <= 0.25));

const conflict = evaluateTradingDeskAgents({ ...base, conflictSeverity: 3 });
assert.ok(conflict.profiles.every(profile => profile.status === 'blocked'));
assert.ok(conflict.profiles.every(profile => profile.blockers.some(reason => reason.includes('conflict veto'))));

const noSignal = evaluateTradingDeskAgents({ ...base, active: null, signal: 'WAIT', plan: null });
assert.ok(noSignal.profiles.every(profile => profile.status === 'blocked'));
assert.ok(noSignal.profiles.every(profile => profile.direction === 'WAIT'));

const noMtf = evaluateTradingDeskAgents({ ...base, mtf: [] });
assert.ok(noMtf.profiles.find(profile => profile.id === 'day').blockers.some(reason => reason.includes('fresh higher-timeframe')));
console.log(JSON.stringify({ status: 'ok', profiles: ready.profiles.map(profile => ({ id: profile.id, status: profile.status, consensus: profile.consensus })), agentsPerDesk: 8 }, null, 2));
