import assert from 'node:assert/strict';
import { PAPER_AGENTS, PAPER_POLICY, derivePaperSignal } from '../src/paper-trading-engine.js';

const strategies = PAPER_AGENTS.map(agent => agent.strategyId);
for (const id of ['liquidity-scalp','momentum-scalp','trend-day','range-day','breakout-day','fvg-retest']) {
  assert.ok(strategies.includes(id), 'paper fleet includes ' + id);
}
assert.equal(PAPER_AGENTS.length, 16, 'six new specialist paper bots join the existing ten');
assert.equal(PAPER_POLICY.mode, 'PAPER_ONLY');
assert.equal(PAPER_POLICY.riskPerTradePct, 0.25);
assert.equal(PAPER_POLICY.maxLeverage, 1);

const rows = [];
let price = 100;
for (let i = 0; i < 110; i++) {
  const open = price;
  price += 0.25;
  rows.push([1700000000000 + i * 300000, open, price + 0.12, open - 0.12, price, i >= 90 ? 320 : 100]);
}
const htf = rows.map((row, index) => [row[0], row[1], row[2], row[3], row[4], row[5]]);
const momentum = derivePaperSignal(rows, { bid: price - 0.01, ask: price + 0.01 }, 'momentum-scalper', { timeframes: { '1h': htf } });
assert.equal(momentum.action, 'SIGNAL');
assert.equal(momentum.direction, 'LONG');
assert.ok(momentum.features.relativeVolume >= 1.2);

const trendDay = derivePaperSignal(rows, { bid: price - 0.01, ask: price + 0.01 }, 'trend-day', { timeframes: { '1h': htf, '4h': htf } });
assert.equal(trendDay.action, 'SIGNAL');
assert.equal(trendDay.direction, 'LONG');

const breakout = derivePaperSignal(rows, { bid: price - 0.01, ask: price + 0.01 }, 'breakout-day', {});
assert.equal(breakout.action, 'SIGNAL');
assert.equal(breakout.direction, 'LONG');

const liquidityWithoutProof = derivePaperSignal(rows, {}, 'liquidity-scalper', {});
assert.equal(liquidityWithoutProof.action, 'WAIT', 'liquidity scalper must abstain without a confirmed SMC sweep/FVG setup');

console.log(JSON.stringify({ status: 'ok', paperAgents: PAPER_AGENTS.length, newStrategies: strategies.slice(-6), riskPerTradePct: PAPER_POLICY.riskPerTradePct, checks: ['momentum-scalp','trend-day','breakout-day','liquidity-no-proof-abstention'] }, null, 2));
