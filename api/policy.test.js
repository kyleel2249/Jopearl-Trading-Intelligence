import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSchema, assertLiveTradingAllowed, requirePrivateApiAuth } from './policy.js';

test('validates a limit order with a positive price', () => {
  const result = orderSchema.safeParse({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.001, price: 50000 });
  assert.equal(result.success, true);
});

test('rejects limit orders without a price', () => {
  const result = orderSchema.safeParse({ symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.001 });
  assert.equal(result.success, false);
});

test('live trading is blocked by default', () => {
  const previousMode = process.env.JPTI_TRADING_MODE;
  const previousEnabled = process.env.JPTI_ENABLE_LIVE_TRADING;
  delete process.env.JPTI_TRADING_MODE;
  delete process.env.JPTI_ENABLE_LIVE_TRADING;
  const req = { get: () => 'I_ACKNOWLEDGE_LIVE_TRADING' };
  assert.throws(() => assertLiveTradingAllowed(req, { has: { createOrder: true } }, { active: true, spot: true, quote: 'USDT' }, { type: 'limit', price: 50000, amount: 0.001 }, 50000), /Live trading is locked/);
  if (previousMode === undefined) delete process.env.JPTI_TRADING_MODE; else process.env.JPTI_TRADING_MODE = previousMode;
  if (previousEnabled === undefined) delete process.env.JPTI_ENABLE_LIVE_TRADING; else process.env.JPTI_ENABLE_LIVE_TRADING = previousEnabled;
});

test('live gate enforces the configured notional cap', () => {
  const keys = ['JPTI_TRADING_MODE','JPTI_ENABLE_LIVE_TRADING','JPTI_API_TOKEN','JPTI_MAX_ORDER_NOTIONAL_USDT'];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.JPTI_TRADING_MODE = 'live';
  process.env.JPTI_ENABLE_LIVE_TRADING = 'true';
  process.env.JPTI_API_TOKEN = 'test-token';
  process.env.JPTI_MAX_ORDER_NOTIONAL_USDT = '40';
  const req = { get: (name) => ({ 'x-jpti-api-token': 'test-token', 'x-jpti-live-confirmation': 'I_ACKNOWLEDGE_LIVE_TRADING' }[name]) };
  assert.throws(() => assertLiveTradingAllowed(req, { has: { createOrder: true } }, { active: true, spot: true, quote: 'USDT' }, { type: 'limit', price: 50000, amount: 0.001 }, 50000), /exceeds configured per-order cap/);
  for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
});

test('local desktop private access is restricted to loopback server and client', () => {
  const old = {
    enabled: process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS,
    host: process.env.JPTI_API_HOST,
    token: process.env.JPTI_API_TOKEN
  };
  process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS = 'true';
  process.env.JPTI_API_HOST = '127.0.0.1';
  delete process.env.JPTI_API_TOKEN;
  assert.doesNotThrow(() => requirePrivateApiAuth({ ip: '::ffff:127.0.0.1', get: () => undefined }));
  assert.throws(() => requirePrivateApiAuth({ ip: '192.168.1.25', get: () => undefined }), /Missing or invalid/);
  process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS = old.enabled ?? 'false';
  process.env.JPTI_API_HOST = old.host ?? '127.0.0.1';
  if (old.token === undefined) delete process.env.JPTI_API_TOKEN; else process.env.JPTI_API_TOKEN = old.token;
});
