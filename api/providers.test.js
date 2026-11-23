import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuoteConsensus, getOperationalIntervals, normalizeProviderQuote, providerDirectory, providerRouter } from './providers.js';

test('provider registry includes requested market, news and blockchain vendors', () => {
  const ids = providerDirectory().map((item) => item.id);
  for (const id of ['bitget','alpaca','quiver','finnhub','alphavantage','twelvedata','infura','liquid','gdelt']) assert.ok(ids.includes(id), id);
});

test('operational intervals expose positive second-based defaults', () => {
  const values = getOperationalIntervals();
  assert.equal(values.marketMonitorSeconds, 5);
  assert.equal(values.reconcileSeconds, 30);
  assert.equal(values.investorMonitorSeconds, 60);
  for (const [key, value] of Object.entries(values)) if (key !== 'schedulerEnabled') assert.ok(Number.isInteger(value) && value > 0, key);
});

test('provider directory exposes credential presence without leaking secret values', () => {
  const previousKey = process.env.JPTI_ALPACA_API_KEY;
  const previousSecret = process.env.JPTI_ALPACA_API_SECRET;
  process.env.JPTI_ALPACA_API_KEY = 'test-key-must-not-leak';
  process.env.JPTI_ALPACA_API_SECRET = 'test-secret-must-not-leak';
  try {
    const alpaca = providerDirectory().find((item) => item.id === 'alpaca');
    assert.equal(alpaca.configured, true);
    assert.deepEqual(alpaca.missingCredentials, []);
    assert.equal(JSON.stringify(alpaca).includes('test-key-must-not-leak'), false);
    assert.equal(JSON.stringify(alpaca).includes('test-secret-must-not-leak'), false);
  } finally {
    if (previousKey === undefined) delete process.env.JPTI_ALPACA_API_KEY; else process.env.JPTI_ALPACA_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.JPTI_ALPACA_API_SECRET; else process.env.JPTI_ALPACA_API_SECRET = previousSecret;
  }
});

test('provider quote normalizers reject missing and non-positive prices', () => {
  assert.equal(normalizeProviderQuote('finnhub', 'AAPL', { c: 0 }), null);
  const quote = normalizeProviderQuote('finnhub', 'AAPL', { c: 201.5, d: 1.5, dp: 0.75, t: 1795000000 });
  assert.equal(quote.price, 201.5);
  assert.equal(quote.changePercent, 0.75);
  assert.equal(quote.currency, 'USD');
});

test('quote consensus uses median and flags statistical outliers with three sources', () => {
  const result = buildQuoteConsensus('AAPL', [
    { provider: 'a', price: 100, currency: 'USD' },
    { provider: 'b', price: 101, currency: 'USD' },
    { provider: 'c', price: 140, currency: 'USD' }
  ]);
  assert.equal(result.consensusPrice, 101);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.confidence, 'multi-source');
  assert.equal(result.sources.find((item) => item.provider === 'c').outlier, true);
});

test('quote consensus refuses to combine explicit currency conflicts', () => {
  const result = buildQuoteConsensus('XYZ', [
    { provider: 'a', price: 100, currency: 'USD' },
    { provider: 'b', price: 90, currency: 'EUR' }
  ]);
  assert.equal(result.consensusPrice, null);
  assert.equal(result.currencyConflict, true);
  assert.equal(result.confidence, 'currency-conflict');
});


test('Bitget CCXT quote normalization accepts public ticker payloads', () => {
  const quote = normalizeProviderQuote('bitget', 'BTC/USDT', { last: 65432.1, change: 321.1, percentage: 0.49, timestamp: 1795000000000, currency: 'USDT' });
  assert.equal(quote.price, 65432.1);
  assert.equal(quote.change, 321.1);
  assert.equal(quote.changePercent, 0.49);
  assert.equal(quote.currency, 'USDT');
  assert.equal(quote.venue, 'bitget');
});

test('Bitget normalization rejects invalid public ticker prices', () => {
  assert.equal(normalizeProviderQuote('bitget', 'BTC/USDT', { last: 0, percentage: 2 }), null);
});


test('Bitget public market intelligence route is registered', () => {
  assert.ok(providerRouter.stack.some((layer) => layer.route?.path === '/providers/bitget/market-intelligence/:symbol'), 'Bitget intelligence route missing');
});
