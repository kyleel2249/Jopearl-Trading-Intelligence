import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStreamRequest } from './market-stream.js';

test('normalizes and validates stream subscriptions',()=>{
 assert.deepEqual(normalizeStreamRequest({exchange:'binance',symbol:'btc/usdt',intervalMs:'5000'}),{exchange:'binance',symbol:'BTC/USDT',intervalMs:5000});
});
test('rejects invalid symbols, exchange identifiers and aggressive polling',()=>{
 assert.throws(()=>normalizeStreamRequest({symbol:'BTC-USDT'}),/BASE\/QUOTE/);
 assert.throws(()=>normalizeStreamRequest({exchange:'../secret'}),/exchange identifier/);
 assert.throws(()=>normalizeStreamRequest({intervalMs:'100'}),/between 3000 and 60000/);
});
