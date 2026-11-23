import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSmartMoney } from './smartMoney.js';

const candle = (time, open, high, low, close, volume = 100) => [time, open, high, low, close, volume];

test('detects bullish and bearish fair value gaps from three-candle patterns', () => {
  const rows = [
    candle(0, 9, 10, 8, 9),
    candle(1, 10, 12, 9, 11),
    candle(2, 12, 13, 11, 12),
    candle(3, 12, 13, 10, 11),
    candle(4, 9, 9.5, 7, 8)
  ];
  const result = detectSmartMoney(rows);
  assert.ok(result.fairValueGaps.some((gap) => gap.direction === 'bullish' && gap.top === 11 && gap.bottom === 10 && gap.mitigatedAt === 3));
  assert.ok(result.fairValueGaps.some((gap) => gap.direction === 'bearish' && gap.top === 11 && gap.bottom === 9.5));
});

test('detects a buy-side liquidity sweep, bullish BOS and a preceding bearish order block', () => {
  const rows = [
    candle(0, 9, 10, 8, 9),
    candle(1, 9, 11, 8.5, 10),
    candle(2, 10, 12, 9, 11),
    candle(3, 11, 15, 10, 11),
    candle(4, 10, 12, 9, 10),
    candle(5, 9.5, 11, 8, 9),
    candle(6, 9, 10, 7.5, 8.5),
    candle(7, 12, 16, 11, 14),
    candle(8, 14, 17, 13, 16),
    candle(9, 16, 18, 15, 17)
  ];
  const result = detectSmartMoney(rows);
  assert.ok(result.liquiditySweeps.some((event) => event.direction === 'buy-side' && event.level === 15));
  assert.ok(result.structureBreaks.some((event) => event.kind === 'BOS' && event.direction === 'bullish' && event.level === 15));
  assert.ok(result.orderBlocks.some((zone) => zone.direction === 'bullish' && zone.start === 6));
});

test('returns empty event collections when there is insufficient candle history', () => {
  const result = detectSmartMoney([candle(0, 1, 2, 0.5, 1), candle(1, 1, 2, 0.5, 1)]);
  assert.equal(result.fairValueGaps.length, 0);
  assert.equal(result.structureBreaks.length, 0);
});


test('classifies a break against the established trend as CHoCH', () => {
  const rows = [
    candle(0, 9, 10, 8, 9),
    candle(1, 9, 11, 8.5, 10),
    candle(2, 10, 12, 9, 11),
    candle(3, 11, 15, 10, 11),
    candle(4, 10, 12, 9, 10),
    candle(5, 9.5, 11, 8, 9),
    candle(6, 9, 10, 7.5, 8.5),
    candle(7, 12, 16, 11, 14),
    candle(8, 14, 17, 13, 16),
    candle(9, 17, 19, 15, 18),
    candle(10, 8, 9, 6, 7)
  ];
  const result = detectSmartMoney(rows);
  assert.ok(result.structureBreaks.some((event) => event.kind === 'BOS' && event.direction === 'bullish'));
  assert.ok(result.structureBreaks.some((event) => event.kind === 'CHoCH' && event.direction === 'bearish'));
  assert.ok(result.orderBlocks.some((zone) => zone.direction === 'bullish' && zone.mitigatedAt === 10));
});
