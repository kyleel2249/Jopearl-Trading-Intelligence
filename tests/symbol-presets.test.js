import test from 'node:test';
import assert from 'node:assert/strict';
import { SYMBOL_PRESETS } from '../src/symbol-presets.js';

test('terminal symbol presets are unique and include core crypto and FX markets', () => {
  assert.equal(new Set(SYMBOL_PRESETS).size, SYMBOL_PRESETS.length);
  for (const symbol of ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'EUR/USDT', 'GBP/USDT', 'AUD/USDT']) {
    assert.ok(SYMBOL_PRESETS.includes(symbol), `missing ${symbol}`);
  }
});
