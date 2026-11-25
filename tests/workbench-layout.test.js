import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PANELS, MAX_LAYOUTS, defaultPanels, sanitizePanel, sanitizePanels, presetPanels, addPanel, removePanel, updatePanel, defaultStore, parseStore, serializeStore, saveLayout, deleteLayout } from '../src/lib/workbench-layout.js';

test('panels are sanitised: unknown values fall back, symbols are upper-cased', () => {
  const panel = sanitizePanel({ id: 'x', product: 'nonsense', symbol: 'eth/usdt:usdt', timeframe: '7h', exchange: 'evil', side: 'sell' }, 'p1');
  assert.deepEqual(panel, { id: 'x', exchange: 'bitget', product: 'futures', symbol: 'ETH/USDT:USDT', timeframe: '1h', side: 'sell', nonce: 0 });
  assert.equal(sanitizePanel({ symbol: '<script>' }, 'p1').symbol, 'BTC/USDT');
});

test('a layout never exceeds the panel limit and ids stay unique', () => {
  const many = Array.from({ length: 9 }, () => ({ id: 'dup', product: 'spot' }));
  const panels = sanitizePanels(many);
  assert.equal(panels.length, MAX_PANELS);
  assert.equal(new Set(panels.map((p) => p.id)).size, MAX_PANELS);
  assert.deepEqual(sanitizePanels('garbage').map((p) => p.id), defaultPanels().map((p) => p.id));
});

test('add, update and remove keep the grid valid', () => {
  let panels = presetPanels(1);
  for (let i = 0; i < 6; i += 1) panels = addPanel(panels);
  assert.equal(panels.length, MAX_PANELS);
  assert.equal(addPanel(panels).length, MAX_PANELS);
  assert.equal(updatePanel(panels, 'p2', { product: 'margin', id: 'hacked' }).find((p) => p.id === 'p2').product, 'margin');
  assert.equal(removePanel(presetPanels(1), 'p1').length, 1, 'the last panel cannot be removed');
  assert.equal(removePanel(panels, 'p3').some((p) => p.id === 'p3'), false);
});

test('presets pair a spot chart with a futures chart for basis comparison', () => {
  assert.deepEqual(presetPanels(2).map((p) => p.product), ['futures', 'spot']);
  assert.deepEqual(presetPanels(4).map((p) => p.product), ['futures', 'spot', 'usdc-futures', 'margin']);
  assert.equal(presetPanels(99).length, MAX_PANELS);
});

test('the store round-trips and survives corrupt or foreign storage', () => {
  const saved = saveLayout(defaultStore(), 'Scalping', presetPanels(4)).store;
  const back = parseStore(serializeStore(saved));
  assert.equal(back.active, 'Scalping');
  assert.equal(back.layouts.Scalping.panels.length, 4);
  for (const bad of ['', 'not json', '{"version":99}', '{"version":1}', 'null', '{"version":1,"layouts":{}}']) assert.deepEqual(parseStore(bad), defaultStore());
});

test('layout names are validated, limited in number and deletable down to one', () => {
  assert.ok(saveLayout(defaultStore(), '   ', []).error);
  let store = defaultStore();
  for (let i = 0; i < MAX_LAYOUTS + 3; i += 1) store = saveLayout(store, 'L' + i, defaultPanels()).store;
  assert.equal(Object.keys(store.layouts).length, MAX_LAYOUTS);
  assert.ok(saveLayout(store, 'one-too-many', []).error);
  assert.equal(saveLayout(store, 'L1', presetPanels(3)).error, null, 'overwriting an existing name is allowed at the limit');
  let small = saveLayout(defaultStore(), 'B', defaultPanels()).store;
  small = deleteLayout(small, 'B');
  assert.equal(small.active, 'Default');
  assert.deepEqual(Object.keys(deleteLayout(small, 'Default').layouts), ['Default'], 'the last layout cannot be deleted');
});
