import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlert, evaluateAlerts, quoteKey, parseAlerts, serializeAlerts, sanitizeAlerts, MAX_ALERTS } from '../src/lib/alerts.js';

const mk = (raw, price = 100, now = 1000) => createAlert({ exchange: 'bitget', product: 'futures', symbol: 'btc/usdt:usdt', ...raw }, price, now, 'a1').alert;
const q = (price) => ({ [quoteKey({ exchange: 'bitget', product: 'futures', symbol: 'BTC/USDT:USDT' })]: price });

test('validation rejects bad type, symbol and value, and a pct alert needs a baseline price', () => {
  assert.ok(createAlert({ type: 'nope' }, 1).error);
  assert.ok(createAlert({ type: 'price_above', symbol: '<x>', value: 1 }, 1).error);
  assert.ok(createAlert({ type: 'price_above', symbol: 'BTC/USDT', value: -5 }, 1).error);
  assert.ok(createAlert({ type: 'pct_move', symbol: 'BTC/USDT', value: 2 }, null).error);
  assert.equal(mk({ type: 'price_above', value: 105 }).symbol, 'BTC/USDT:USDT');
});

test('price_above fires on the crossing only, once', () => {
  let alerts = [mk({ type: 'price_above', value: 105 })];
  let r = evaluateAlerts(alerts, q(104), 2000); assert.equal(r.triggered.length, 0); alerts = r.alerts;
  r = evaluateAlerts(alerts, q(106), 3000); assert.equal(r.triggered.length, 1); alerts = r.alerts;
  assert.equal(alerts[0].enabled, false, 'one-shot alerts disarm');
  assert.equal(evaluateAlerts(alerts, q(107), 4000).triggered.length, 0);
});

test('an alert created already past its level waits for a fresh crossing', () => {
  const alerts = [mk({ type: 'price_above', value: 105 }, 110)];
  assert.equal(evaluateAlerts(alerts, q(111), 2000).triggered.length, 0);
  const down = evaluateAlerts(alerts, q(100), 3000).alerts;
  assert.equal(evaluateAlerts(down, q(106), 4000).triggered.length, 1);
});

test('price_below, level_touch (tolerance and gap-through) and pct_move behave', () => {
  assert.equal(evaluateAlerts([mk({ type: 'price_below', value: 95 })], q(94.9)).triggered.length, 1);
  assert.equal(evaluateAlerts([mk({ type: 'level_touch', value: 100, tolerancePercent: 0.1 }, 90)], q(100.05)).triggered.length, 1);
  assert.equal(evaluateAlerts([mk({ type: 'level_touch', value: 100, tolerancePercent: 0.1 }, 90)], q(110)).triggered.length, 1, 'a poll gap that jumps over the level still counts');
  assert.equal(evaluateAlerts([mk({ type: 'level_touch', value: 100, tolerancePercent: 0.1 }, 90)], q(95)).triggered.length, 0);
  const pct = mk({ type: 'pct_move', value: 2, direction: 'down' }, 100);
  assert.equal(evaluateAlerts([pct], q(98.1)).triggered.length, 0, '-1.9% is inside a 2% threshold');
  assert.equal(evaluateAlerts([pct], q(97.9)).triggered.length, 1, '-2.1% is outside it');
  assert.equal(evaluateAlerts([mk({ type: 'pct_move', value: 2, direction: 'up' }, 100)], q(90)).triggered.length, 0);
});

test('repeat alerts respect the cooldown and rebaseline percent moves', () => {
  let alerts = [mk({ type: 'pct_move', value: 1, repeat: true, cooldownMinutes: 10 }, 100)];
  let r = evaluateAlerts(alerts, q(101), 0); assert.equal(r.triggered.length, 1); alerts = r.alerts;
  assert.equal(alerts[0].baseline, 101);
  assert.equal(alerts[0].enabled, true);
  r = evaluateAlerts(alerts, q(103), 5 * 60000); assert.equal(r.triggered.length, 0, 'inside the cooldown'); alerts = r.alerts;
  r = evaluateAlerts(alerts, q(103), 11 * 60000); assert.equal(r.triggered.length, 1, 'after the cooldown');
});

test('missing quotes and disabled alerts never fire', () => {
  assert.equal(evaluateAlerts([mk({ type: 'price_above', value: 105 })], {}).triggered.length, 0);
  assert.equal(evaluateAlerts([{ ...mk({ type: 'price_above', value: 105 }), enabled: false }], q(200)).triggered.length, 0);
});

test('storage round-trips and rejects corrupt or oversized data', () => {
  const alerts = [mk({ type: 'price_above', value: 105 }), { ...mk({ type: 'level_touch', value: 90 }), id: 'a2' }];
  assert.deepEqual(parseAlerts(serializeAlerts(alerts)).map((a) => a.id), ['a1', 'a2']);
  assert.deepEqual(parseAlerts('garbage'), []);
  assert.deepEqual(parseAlerts('{"x":1}'), []);
  assert.equal(sanitizeAlerts(Array.from({ length: MAX_ALERTS + 10 }, (_, i) => ({ ...alerts[0], id: 'id' + i }))).length, MAX_ALERTS);
  assert.equal(sanitizeAlerts([alerts[0], alerts[0]]).length, 1, 'duplicate ids are dropped');
});

test('the exact instrument id is kept (sanitised) so USDC-M quotes use the right contract', () => {
  const alert = createAlert({ type: 'price_above', symbol: 'BTC/USDC:USDC', value: 5, instrumentId: 'BTCPERP<script>' }, 4, 1, 'a9').alert;
  assert.equal(alert.instrumentId, 'BTCPERPscript');
  assert.equal(parseAlerts(serializeAlerts([{ ...alert, instrumentId: 'BTCPERP' }]))[0].instrumentId, 'BTCPERP');
});
