import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePortfolioAccounting, calculatePortfolioRisk, percentile } from './portfolio-intelligence.js';

const fill = (overrides = {}) => ({
  kind:'ledger-transaction', eventType:'fill', source:'binance', accountId:'spot-main',
  symbol:'BTC/USDT', side:'buy', quantity:2, price:100, fee:0, feeCurrency:'USDT',
  occurredAt:'2026-01-01T00:00:00.000Z', ...overrides
});

test('portfolio accounting computes weighted-average inventory, realized and unrealized PnL', () => {
  const events = [
    fill(),
    fill({externalId:'sell-1', side:'sell', quantity:1, price:120, occurredAt:'2026-01-02T00:00:00.000Z'})
  ];
  const result = calculatePortfolioAccounting(events, {'binance:BTC/USDT':130});
  assert.equal(result.positions.length,1);
  assert.equal(result.positions[0].quantity,1);
  assert.equal(result.positions[0].averageCost,100);
  assert.equal(result.positions[0].marketValue,130);
  assert.equal(result.positions[0].unrealizedPnl,30);
  assert.equal(result.realizedPnlByQuoteCurrency.USDT,20);
  assert.equal(result.assetMovements.find(row=>row.currency==='BTC').netMovement,1);
  assert.equal(result.assetMovements.find(row=>row.currency==='USDT').netMovement,-80);
});

test('portfolio inventory is isolated by exchange, account and market', () => {
  const result = calculatePortfolioAccounting([
    fill(),
    fill({source:'bitget', accountId:'second', externalId:'other', quantity:3, price:50})
  ]);
  assert.equal(result.positions.length,2);
  assert.deepEqual(result.positions.map(row=>row.quantity).sort(),[2,3]);
});

test('base-currency fees reduce acquired inventory and increase disposed quantity', () => {
  const result = calculatePortfolioAccounting([
    fill({quantity:2, fee:0.1, feeCurrency:'BTC'}),
    fill({side:'sell', quantity:1, price:120, fee:0.05, feeCurrency:'BTC', occurredAt:'2026-01-02T00:00:00.000Z'})
  ]);
  assert.ok(Math.abs(result.positions[0].quantity - 0.85) < 1e-12);
  assert.ok(Math.abs(result.positions[0].averageCost - 200/1.9) < 1e-12);
  assert.ok(result.warnings.some(value=>value.includes('Unmatched sell quantity')) === false);
});

test('quote currencies remain separate and unmarked positions are not assigned a market value', () => {
  const result = calculatePortfolioAccounting([
    fill(),
    fill({symbol:'ETH/USD', externalId:'eth', quantity:1, price:2000})
  ]);
  assert.equal(result.positions.find(row=>row.symbol==='BTC/USDT').marketValue,null);
  assert.equal(result.positions.find(row=>row.symbol==='ETH/USD').marketValue,null);
  const risk = calculatePortfolioRisk({positions:[
    {exchange:'binance',symbol:'BTC/USDT',quoteCurrency:'USDT',marketValue:100},
    {exchange:'binance',symbol:'ETH/USD',quoteCurrency:'USD',marketValue:200}
  ]});
  assert.deepEqual(risk.portfolios.map(row=>row.quoteCurrency),['USD','USDT']);
});

test('portfolio risk calculates aligned historical VaR, expected shortfall and concentration', () => {
  const first = {}, second = {};
  for (let i=0;i<120;i++) {
    first[String(i)] = i===119 ? -0.1 : (i%2 ? 0.01 : -0.005);
    second[String(i)] = i===119 ? -0.05 : (i%3 ? 0.005 : -0.002);
  }
  const risk = calculatePortfolioRisk({
    positions:[
      {exchange:'binance',symbol:'BTC/USDT',quoteCurrency:'USDT',marketValue:60},
      {exchange:'bitget',symbol:'ETH/USDT',quoteCurrency:'USDT',marketValue:40}
    ],
    returnSeries:{'binance:BTC/USDT':first,'bitget:ETH/USDT':second},
    shockPercent:10
  });
  const book = risk.portfolios[0];
  assert.equal(book.grossExposure,100);
  assert.equal(book.positions.length,2);
  assert.equal(book.concentration.largestPositionWeightPercent,60);
  assert.equal(book.historical.observations,120);
  assert.ok(book.historical.var95Percent > 0);
  assert.ok(book.historical.expectedShortfall95Percent >= book.historical.var95Percent);
  assert.ok(book.historical.var99Percent > 0);
  assert.equal(book.stress.estimatedLoss,10);
  assert.ok(risk.warnings.some(item=>item.message.includes('40%')));
});

test('historical VaR remains unavailable below minimum sample sizes', () => {
  const series = Object.fromEntries(Array.from({length:29},(_,i)=>[String(i),-0.01]));
  const risk = calculatePortfolioRisk({
    positions:[{exchange:'binance',symbol:'BTC/USDT',quoteCurrency:'USDT',marketValue:10}],
    returnSeries:{'binance:BTC/USDT':series}
  });
  assert.equal(risk.portfolios[0].historical.var95Percent,null);
  assert.equal(risk.portfolios[0].historical.observations,29);
});

test('percentile interpolates between ordered observations', () => {
  assert.equal(percentile([0,10],0.25),2.5);
  assert.equal(percentile([],0.5),null);
});
