import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTrades,
  detectLiveSweep,
  normalizeTrade
} from './live-trade-flow.js';

test('normalizes venue prints and rejects invalid records', () => {
  assert.deepEqual(
    normalizeTrade({ price: '12', size: '3', side: 'buy', ts: 1000 }),
    { price: 12, size: 3, ts: 1000, side: 'buy', notional: 36 }
  );
  assert.equal(normalizeTrade({ price: 0, size: 2 }), null);
});

test('rolling window counts unknown-side prints and excludes stale and future outliers', () => {
  const trades = [
    { price: 2, size: 1, ts: 90000, side: 'buy', notional: 2 },
    { price: 2, size: 2, ts: 99000, side: 'sell', notional: 4 },
    { price: 2, size: 1, ts: 50000, side: null, notional: 2 },
    { price: 2, size: 1, ts: 30000, side: 'buy', notional: 2 },
    { price: 2, size: 1, ts: 106000, side: 'buy', notional: 2 }
  ];

  const flow = aggregateTrades(trades, 100000);

  assert.equal(flow.count, 3);
  assert.equal(flow.buy, 1);
  assert.equal(flow.sell, 2);
  assert.equal(flow.unknown, 1);
  assert.equal(flow.coverage, 3 / 4);
  assert.equal(flow.delta, -1);
});

test('sweep classifier distinguishes an unconfirmed reclaim from a continuing break', () => {
  const rows = Array.from({ length: 22 }, (_, index) => [
    index, 10, 11, 9, 10, 1
  ]);
  rows[21] = [21, 9.2, 10, 8.8, 9.8, 2];

  assert.equal(detectLiveSweep(rows, 8.9)?.label, 'LOW-SIDE RECLAIM');

  const breakRows = rows.map((candle) => [...candle]);
  breakRows[21][4] = 8.9;
  assert.equal(detectLiveSweep(breakRows, 8.7)?.label, 'LOW-SIDE BREAK');

  assert.equal(detectLiveSweep(rows, 10.5), null);
});
