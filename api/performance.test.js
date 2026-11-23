import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTradePerformance } from './performance.js';

const fill = (overrides = {}) => ({
  source:'binance', accountId:'spot-main', eventType:'fill', symbol:'BTC/USDT',
  side:'buy', quantity:1, price:100, fee:0, feeCurrency:'USDT',
  occurredAt:'2026-01-01T10:00:00.000Z', metadata:{strategyId:'trend-follow'},
  ...overrides
});

test('calculates weighted-average realized PnL for matched sell executions', () => {
  const report = calculateTradePerformance([
    fill({quantity:2,price:100,fee:0.2}),
    fill({side:'sell',quantity:1,price:120,fee:0.12,occurredAt:'2026-01-02T14:00:00.000Z'})
  ]);
  const row = report.byCurrency.find(x=>x.quoteCurrency==='USDT');
  assert.equal(report.fillCount,2);
  assert.equal(row.closedExitExecutions,1);
  assert.ok(Math.abs(row.netRealizedPnl-19.78)<1e-9);
  assert.equal(row.wins,1);
  assert.equal(row.winRatePercent,100);
  assert.equal(report.byStrategy[0].strategy,'trend-follow');
  assert.equal(report.bySession[0].session,'US (13:00–21:00 UTC)');
});

test('flags unmatched sell quantity rather than fabricating opening cost basis', () => {
  const report=calculateTradePerformance([fill({side:'sell',quantity:2,price:50})]);
  assert.equal(report.matchedExitCount,0);
  assert.equal(report.unmatchedSellExecutions,1);
  assert.ok(report.dataQuality.warnings.some(x=>x.includes('Unmatched sell quantity')));
});

test('keeps quote currencies separate in strategy and market attribution', () => {
  const report=calculateTradePerformance([
    fill({symbol:'BTC/USDT',side:'buy',quantity:1,price:10}),
    fill({symbol:'BTC/USDT',side:'sell',quantity:1,price:12}),
    fill({symbol:'ETH/USD',side:'buy',quantity:1,price:100}),
    fill({symbol:'ETH/USD',side:'sell',quantity:1,price:105})
  ]);
  assert.equal(report.byStrategy.length,2);
  assert.deepEqual(new Set(report.byStrategy.map(x=>x.quoteCurrency)),new Set(['USDT','USD']));
  assert.equal(report.byCurrency.length,2);
});

test('reports third-token fees without silently converting them', () => {
  const report=calculateTradePerformance([
    fill({quantity:1,price:100,fee:0.005,feeCurrency:'BNB'}),
    fill({side:'sell',quantity:1,price:110,fee:0.01,feeCurrency:'BNB'})
  ]);
  assert.equal(report.thirdCurrencyFees.length,2);
  assert.equal(report.thirdCurrencyFees[0].currency,'BNB');
  assert.equal(report.thirdCurrencyFees[0].side,'buy');
});

test('adds deterministic analyst insights for losing streaks and small samples', () => {
  const report=calculateTradePerformance([
    fill({quantity:3,price:100}),
    fill({side:'sell',quantity:1,price:90,occurredAt:'2026-01-02T10:00:00.000Z'}),
    fill({side:'sell',quantity:1,price:89,occurredAt:'2026-01-03T10:00:00.000Z'}),
    fill({side:'sell',quantity:1,price:88,occurredAt:'2026-01-04T10:00:00.000Z'})
  ]);
  const currency=report.byCurrency[0];
  assert.equal(currency.currentLossStreak,3);
  assert.equal(currency.longestLossStreak,3);
  assert.ok(report.analystInsights.some(x=>x.title==='Consecutive realized losses'));
  assert.ok(report.analystInsights.some(x=>x.title==='Small performance sample'));
});
