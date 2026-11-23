import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePaperPosition, foldPaperEvents, normalizePaperPositionInput } from './futures-paper.js';

const contract = { base: 'BTC', quote: 'USDT', settle: 'USDT', linear: true, inverse: false, swap: true, future: false, contractSize: 0.001 };
const input = (overrides = {}) => ({
  symbol: 'BTC/USDT:USDT', quantityBase: 0.001, feeBps: 6,
  buy: { exchange: 'binance', symbol: 'BTC/USDT:USDT', contract, entryPrice: 100000 },
  sell: { exchange: 'bybit', symbol: 'BTC/USDT:USDT', contract, entryPrice: 100100 },
  ...overrides
});

test('normalizes a compatible two-venue linear paired position', () => {
  const result = normalizePaperPositionInput(input());
  assert.equal(result.legs.length, 2);
  assert.equal(result.legs[0].contracts, 1);
  assert.equal(result.legs[1].side, 'sell');
});

test('rejects same-venue, mismatched settlement and inverse contracts', () => {
  assert.throws(() => normalizePaperPositionInput(input({ sell: { ...input().sell, exchange: 'binance' } })), /different exchanges/);
  assert.throws(() => normalizePaperPositionInput(input({ sell: { ...input().sell, contract: { ...contract, settle: 'BTC' } } })), /settlement currency/);
  assert.throws(() => normalizePaperPositionInput(input({ sell: { ...input().sell, contract: { ...contract, linear: false, inverse: true } } })), /linear contracts only/);
  assert.throws(() => normalizePaperPositionInput(input({ sell: { ...input().sell, contract: { ...contract, swap: false, future: true, expiry: '2027-01-01T00:00:00.000Z' } } })), /same perpetual or dated contract type/);
});

test('computes paired linear PnL after estimated entry and exit fees', () => {
  const normalized = normalizePaperPositionInput(input());
  const position = { ...normalized, legs: normalized.legs };
  const result = calculatePaperPosition(position, { buy: 100200, sell: 99900 });
  assert.equal(result.grossPnlUsd, 0.4);
  assert.ok(result.estimatedFeesUsd > 0);
  assert.equal(result.netPnlUsd, result.grossPnlUsd - result.estimatedFeesUsd);
  assert.equal(result.fundingIncluded, false);
});

test('event folding preserves marks and terminal close state', () => {
  const opened = { kind: 'futures-paper-event', eventType: 'position_opened', positionId: 'p1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { id: 'p1', legs: [] } };
  const marked = { kind: 'futures-paper-event', eventType: 'position_marked', positionId: 'p1', occurredAt: '2026-01-01T00:01:00.000Z', payload: { marks: { buy: 10, sell: 11 }, calculation: { netPnlUsd: 1 } } };
  const closed = { kind: 'futures-paper-event', eventType: 'position_closed', positionId: 'p1', occurredAt: '2026-01-01T00:02:00.000Z', payload: { calculation: { netPnlUsd: 1 } } };
  const [position] = foldPaperEvents([opened, marked, closed]);
  assert.equal(position.status, 'closed');
  assert.equal(position.lastMark.netPnlUsd, 1);
  assert.equal(position.close.calculation.netPnlUsd, 1);
});
