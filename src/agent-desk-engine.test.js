import test from 'node:test';
import assert from 'node:assert/strict';
import { DESK_AGENTS, DESK_MODE, normalizeCandles, buildFleetEvidence, fleetEvents, paperEvents, initialDeskState, reduceDesk } from './agent-desk-engine.js';
import { AGENT_CATALOG } from './agent-fleet-engine.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
function candles(count, step = 300000, drift = 0.002, volume = 100) {
  let price = 100;
  return Array.from({ length: count }, (_, i) => {
    const o = price; price *= 1 + drift + Math.sin(i / 3) * 0.001;
    return [NOW - (count - i) * step, o, Math.max(o, price) * 1.001, Math.min(o, price) * 0.999, price, volume + (i === count - 2 ? 150 : 0)];
  });
}

test('desk roster is exactly the shared specialist catalog and is paper-only', () => {
  assert.deepEqual(DESK_AGENTS.map((a) => a.id), AGENT_CATALOG.map(([id]) => id));
  assert.equal(DESK_MODE.liveExecutionAuthorized, false);
  assert.equal(DESK_MODE.ordersCreated, 0);
});

test('normalizeCandles drops malformed, inverted and duplicate rows and sorts by time', () => {
  const rows = normalizeCandles([[2, 1, 2, 1, 1.5, 3], [1, 1, 2, 1, 1.5, 3], [1, 1, 2, 1, 1.5, 3], [3, 1, 0.5, 1, 1, 1], ['x', 1, 2, 1, 1, 1], [4, 1, 2], null, 'bad']);
  assert.deepEqual(rows.map((r) => r[0]), [1, 2]);
  assert.deepEqual(normalizeCandles(undefined), []);
});

test('evidence is built only from supplied data; missing context stays missing', () => {
  const out = buildFleetEvidence({ '5m': candles(80) }, null, NOW);
  assert.ok(out.evidence);
  assert.equal(out.evidence.depthImbalance, undefined);
  assert.equal(out.evidence.fundingRate, undefined);
  assert.equal(out.evidence.timeframeAlignment, undefined);
  assert.ok(Number.isFinite(out.evidence.momentumPct));
  assert.equal(buildFleetEvidence({ '5m': candles(10) }, null, NOW).evidence, null);
  assert.equal(buildFleetEvidence({}, null, NOW).evidence, null);
});

test('context payload feeds depth imbalance (percent to ratio, clamped) and funding', () => {
  const out = buildFleetEvidence({ '5m': candles(80), '15m': candles(80, 900000), '1h': candles(80, 3600000) }, { orderBookImbalancePct: 250, fundingRate: 0.0002 }, NOW);
  assert.equal(out.evidence.depthImbalance, 1);
  assert.equal(out.evidence.fundingRate, 0.0002);
  assert.ok(out.evidence.timeframeAlignment >= -1 && out.evidence.timeframeAlignment <= 1);
});

test('fleet events cover all ten specialists, honour the risk gate and never authorise orders', () => {
  const { evidence } = buildFleetEvidence({ '5m': candles(80) }, null, NOW);
  const { result, events } = fleetEvents('btc/usdt', evidence, NOW);
  assert.equal(events.filter((e) => e.type === 'agent').length, 10);
  assert.equal(result.symbol, 'BTC/USDT');
  assert.equal(result.permissions.ordersCreated, 0);
  const log = events.find((e) => e.type === 'log').data;
  assert.equal(log.kind, result.risk.blocked ? 'BLOCK' : 'SCAN');
  const insufficient = events.filter((e) => e.type === 'agent' && e.data.status === 'insufficient_evidence');
  assert.ok(insufficient.length > 0, 'agents without evidence must say so instead of guessing');
});

test('stale evidence blocks every agent', () => {
  const { evidence } = buildFleetEvidence({ '5m': candles(80) }, null, NOW - 3600000);
  const { events } = fleetEvents('BTC/USDT', evidence, NOW);
  assert.ok(events.filter((e) => e.type === 'agent').every((e) => e.data.status === 'blocked_stale_evidence'));
  assert.equal(events.find((e) => e.type === 'consensus').data.blocked, true);
});

const overview = {
  mode: 'PAPER_ONLY', updatedAt: '2026-11-25T12:00:00.000Z',
  agents: [
    { id: 'atlas-trend', name: 'Atlas', role: 'Trend', tier: 'RESEARCH', status: 'active', metrics: { equityUsd: 1.1, wins: 2, losses: 1, closedTrades: 3, winRatePct: 66.6, netPnlUsd: 0.1 },
      openTrades: [{ tradeId: 't3', status: 'open', symbol: 'BTCUSDT', direction: 'LONG', openedAt: '2026-11-25T11:00:00Z', entryPrice: 100 }],
      recentTrades: [{ tradeId: 't1', status: 'closed', symbol: 'BTCUSDT', direction: 'LONG', entryPrice: 100, exitPrice: 102, quantity: 0.01, netPnlUsd: 0.015, closedAt: '2026-11-25T10:00:00Z', openedAt: '2026-11-25T09:00:00Z' },
        { tradeId: 't2', status: 'closed', symbol: 'ETHUSDT', direction: 'SHORT', entryPrice: 50, exitPrice: 51, quantity: 0.02, netPnlUsd: -0.03, closedAt: '2026-11-25T10:30:00Z', openedAt: '2026-11-25T10:10:00Z' }] },
    { id: 'pulse-momentum', name: 'Pulse', tier: 'LIVE_READY', status: 'active', metrics: { equityUsd: 0.9, wins: 0, losses: 1, closedTrades: 1, winRatePct: 0, netPnlUsd: -0.1 }, openTrades: [], recentTrades: [] }
  ]
};

test('paper ledger maps to real equity, counts, seats and chronologically ordered trade events', () => {
  const seen = new Set();
  const events = paperEvents(overview, seen);
  const tick = events.find((e) => e.type === 'tick').data;
  assert.equal(tick.balance, 2);
  assert.equal(tick.start, 2);
  assert.equal(tick.trades, 4);
  assert.equal(events.find((e) => e.type === 'mode').data.mode, 'PAPER');
  assert.equal(events.find((e) => e.type === 'seats').data.length, 2);
  const kinds = events.filter((e) => e.type === 'log').map((e) => e.data.kind);
  assert.deepEqual(kinds, ['TARGET', 'STOP', 'OPEN']);
  const short = events.filter((e) => e.type === 'ticket').find((e) => e.data.symbol === 'ETHUSDT').data;
  assert.ok(short.pct < 0, 'a short that rose in price is a loss');
});

test('repeated polls do not duplicate trade events', () => {
  const seen = new Set();
  paperEvents(overview, seen);
  const again = paperEvents(overview, seen);
  assert.equal(again.filter((e) => e.type === 'log' || e.type === 'ticket').length, 0);
});

test('malformed or empty overview never throws and is marked unverified', () => {
  for (const bad of [null, undefined, {}, { agents: 'x' }, { agents: [null] }]) {
    assert.doesNotThrow(() => paperEvents(bad, new Set()));
  }
  assert.equal(paperEvents({}, new Set()).find((e) => e.type === 'mode').data.mode, 'UNVERIFIED');
});

test('reducer is pure, bounded and ignores unknown events', () => {
  let state = initialDeskState();
  const frozen = Object.freeze({ ...state });
  assert.equal(reduceDesk(frozen, { type: 'nope' }), frozen);
  assert.equal(reduceDesk(frozen, null), frozen);
  for (let i = 0; i < 400; i += 1) state = reduceDesk(state, { type: 'tick', data: { balance: 1 + i, start: 1, wins: 0, losses: 0, trades: 0, at: i } });
  for (let i = 0; i < 100; i += 1) state = reduceDesk(state, { type: 'log', data: { kind: 'SCAN', text: String(i) } });
  for (let i = 0; i < 30; i += 1) state = reduceDesk(state, { type: 'ticket', data: { key: String(i) } });
  assert.equal(state.history.length, 240);
  assert.equal(state.log.length, 60);
  assert.equal(state.tickets.length, 12);
  assert.equal(state.balance, 400);
  state = reduceDesk(state, { type: 'tick', data: { balance: 'NaN?', start: 1, at: 1 } });
  assert.equal(state.balance, null);
  assert.equal(state.history.length, 240, 'a non-numeric balance never enters the curve');
});

test('first tick seeds the curve at real starting capital; restore never overwrites live data', () => {
  let state = reduceDesk(initialDeskState(), { type: 'tick', data: { balance: 2.1, start: 2, wins: 0, losses: 0, trades: 0, at: 1000 } });
  assert.deepEqual(state.history.map((p) => p.v), [2, 2.1]);
  state = reduceDesk(state, { type: 'tick', data: { balance: 2.2, start: 2, at: 2000 } });
  assert.equal(state.history.length, 3, 'seed is added only once');
  const kept = reduceDesk(state, { type: 'restore', data: { history: [{ at: 1, v: 9 }] } });
  assert.equal(kept, state);
  const restored = reduceDesk(initialDeskState(), { type: 'restore', data: { history: [{ at: 1, v: 1 }, { at: 'x', v: 2 }, null, { at: 3, v: NaN }, { at: 4, v: 1.5 }] } });
  assert.deepEqual(restored.history.map((p) => p.v), [1, 1.5]);
  assert.equal(reduceDesk(initialDeskState(), { type: 'restore', data: null }).history.length, 0);
});
