import test from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCT_OPTIONS, productSupport, resolveProductChoice, coerceProductForExchange, normalizeMode } from './product-support.js';

test('full API mode serves every derivative product on every venue', () => {
  const table = productSupport({ exchange: 'binance', mode: 'api' });
  for (const value of ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures']) {
    assert.deepEqual([table[value].available, table[value].native], [true, true], value);
  }
});

test('cloudflare-edge and direct mode serve derivatives through Bitget instead of greying them out', () => {
  for (const mode of ['cloudflare-edge', 'direct']) {
    const table = productSupport({ exchange: 'binance', mode });
    for (const value of ['margin', 'futures', 'coin-futures', 'usdc-futures']) {
      assert.equal(table[value].available, true, mode + ' ' + value + ' must stay selectable');
      assert.equal(table[value].native, false);
      assert.equal(table[value].switchTo, 'bitget');
    }
    const bitget = productSupport({ exchange: 'bitget', mode });
    for (const value of ['margin', 'futures', 'coin-futures', 'usdc-futures']) assert.equal(bitget[value].native, true);
  }
});

test('CFD is only offered when the Cloudflare read-only feed is ready, and always through Bitget', () => {
  const off = productSupport({ exchange: 'bitget', mode: 'api', cfdReady: false }).cfd;
  assert.equal(off.available, false);
  assert.match(off.reason, /Cloudflare/);
  const ready = productSupport({ exchange: 'binance', mode: 'cloudflare-edge', cfdReady: true }).cfd;
  assert.deepEqual([ready.available, ready.native, ready.switchTo], [true, false, 'bitget']);
  assert.equal(productSupport({ exchange: 'bitget', mode: 'cloudflare-edge', cfdReady: true }).cfd.native, true);
});

test('choosing a product on a venue that cannot serve it switches to Bitget and says so', () => {
  const r = resolveProductChoice({ exchange: 'binance', requested: 'futures', mode: 'cloudflare-edge' });
  assert.deepEqual([r.ok, r.exchange, r.marketType, r.switched], [true, 'bitget', 'futures', true]);
  assert.match(r.notice, /Binance to Bitget/);
  const stay = resolveProductChoice({ exchange: 'bitget', requested: 'futures', mode: 'cloudflare-edge' });
  assert.deepEqual([stay.ok, stay.exchange, stay.marketType, stay.switched, stay.notice], [true, 'bitget', 'futures', false, '']);
  const api = resolveProductChoice({ exchange: 'okx', requested: 'coin-futures', mode: 'api' });
  assert.deepEqual([api.ok, api.exchange, api.switched], [true, 'okx', false]);
});

test('unavailable and unknown products are refused with a reason and never change state', () => {
  const cfd = resolveProductChoice({ exchange: 'bitget', requested: 'cfd', mode: 'api', cfdReady: false });
  assert.equal(cfd.ok, false);
  assert.equal(cfd.marketType, null);
  assert.ok(cfd.notice.length > 10);
  const options = resolveProductChoice({ exchange: 'bitget', requested: 'options', mode: 'api' });
  assert.equal(options.ok, false);
});

test('changing exchange keeps a still-native product and otherwise falls back to spot with a notice', () => {
  assert.deepEqual(coerceProductForExchange({ exchange: 'okx', marketType: 'futures', mode: 'api' }), { marketType: 'futures', notice: '' });
  assert.deepEqual(coerceProductForExchange({ exchange: 'bitget', marketType: 'futures', mode: 'direct' }), { marketType: 'futures', notice: '' });
  const fallback = coerceProductForExchange({ exchange: 'kraken', marketType: 'futures', mode: 'cloudflare-edge' });
  assert.equal(fallback.marketType, 'spot');
  assert.match(fallback.notice, /Kraken does not serve USDT-M Futures/);
  assert.deepEqual(coerceProductForExchange({ exchange: 'kraken', marketType: 'spot', mode: 'direct' }), { marketType: 'spot', notice: '' });
  assert.deepEqual(coerceProductForExchange({ exchange: 'kraken', marketType: undefined, mode: 'direct' }), { marketType: 'spot', notice: '' });
});

test('option list and mode normalisation', () => {
  assert.deepEqual(PRODUCT_OPTIONS.map((o) => o.value), ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd']);
  assert.equal(normalizeMode('paper'), 'api');
  assert.equal(normalizeMode('direct'), 'direct');
  assert.equal(normalizeMode(undefined), 'api');
});
