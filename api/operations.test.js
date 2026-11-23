import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSchema, getOperationsSnapshot, operationsRouter } from './operations.js';

test('operations snapshot exposes monitored services and honest waiting states', () => {
  const snapshot = getOperationsSnapshot();
  const ids = snapshot.jobs.map((job) => job.id);
  for (const id of ['market-monitor','fill-ingestion','provider-health','reconciliation','investor-monitor','market-maker','news-monitor','onchain-monitor']) assert.ok(ids.includes(id));
  assert.equal(snapshot.schedulerEnabled, true);
  assert.ok(snapshot.uptimeSeconds >= 0);
});

test('transaction event schema accepts normalized fill records', () => {
  const result = eventSchema.safeParse({
    source: 'alpaca', eventType: 'fill', externalId: 'fill-12345',
    accountId: 'paper-account-01', symbol: 'AAPL', side: 'buy',
    quantity: 2, price: 190.25, fee: 0.01, feeCurrency: 'USD'
  });
  assert.equal(result.success, true);
});

test('transaction event schema rejects negative quantities and prices', () => {
  const result = eventSchema.safeParse({
    source: 'exchange', eventType: 'fill', externalId: 'fill-12345',
    accountId: 'account-01', symbol: 'BTC/USDT', side: 'buy',
    quantity: -1, price: 0
  });
  assert.equal(result.success, false);
});

test('transaction event schema accepts derivative cash-flow events', () => {
  for (const eventType of ['funding', 'interest', 'borrow', 'rebate']) {
    const result = eventSchema.safeParse({ source: 'bitget', eventType, externalId: 'cashflow-123', accountId: 'main-account', currency: 'USDT', quantity: 0.25 });
    assert.equal(result.success, true, eventType);
  }
});

test('manual portfolio reconciliation endpoint is registered as a POST route', () => {
  const route = operationsRouter.stack.find(layer => layer.route?.path === '/operations/reconciliation/run');
  assert.ok(route, 'manual reconciliation route should be registered');
  assert.equal(route.route.methods.post, true);
});
