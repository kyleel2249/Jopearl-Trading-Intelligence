// Multi-chart workbench layouts: sanitising, presets and persistence. Pure so it can be tested and
// safely reloaded from localStorage that may have been edited, truncated or written by an old version.
import { PRODUCT_IDS } from './bitget-search.js';

export const MAX_PANELS = 4;
export const MAX_LAYOUTS = 20;
export const STORE_VERSION = 1;
export const STORAGE_KEY = 'jpti.workbench.layouts.v1';
export const TIMEFRAME_IDS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];
export const EXCHANGE_IDS = ['bitget', 'binance', 'bybit', 'okx'];
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}(\/[A-Z0-9._-]{1,20}(:[A-Z0-9._-]{1,20})?)?$/;

export function sanitizePanel(raw, fallbackId) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const symbol = String(source.symbol || '').trim().toUpperCase();
  return {
    id: typeof source.id === 'string' && /^[a-z0-9_-]{1,24}$/i.test(source.id) ? source.id : fallbackId,
    exchange: EXCHANGE_IDS.includes(source.exchange) ? source.exchange : 'bitget',
    product: PRODUCT_IDS.includes(source.product) ? source.product : 'futures',
    symbol: SYMBOL_PATTERN.test(symbol) ? symbol : 'BTC/USDT',
    timeframe: TIMEFRAME_IDS.includes(source.timeframe) ? source.timeframe : '1h',
    side: source.side === 'sell' ? 'sell' : 'buy',
    nonce: Number.isInteger(source.nonce) && source.nonce >= 0 ? source.nonce : 0
  };
}

export function sanitizePanels(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_PANELS) : [];
  const panels = [];
  const used = new Set();
  list.forEach((item, index) => {
    let panel = sanitizePanel(item, 'p' + (index + 1));
    while (used.has(panel.id)) panel = { ...panel, id: panel.id + '_' + index };
    used.add(panel.id);
    panels.push(panel);
  });
  return panels.length ? panels : defaultPanels();
}

export function defaultPanels() {
  return [
    sanitizePanel({ id: 'p1', product: 'futures', symbol: 'BTC/USDT', timeframe: '1h' }, 'p1'),
    sanitizePanel({ id: 'p2', product: 'spot', symbol: 'BTC/USDT', timeframe: '1h' }, 'p2')
  ];
}

export function presetPanels(count, template = {}) {
  const size = Math.max(1, Math.min(MAX_PANELS, Math.round(Number(count)) || 1));
  const base = sanitizePanel(template, 'p1');
  const products = [base.product, base.product === 'spot' ? 'futures' : 'spot', 'usdc-futures', 'margin'];
  return Array.from({ length: size }, (_, index) => sanitizePanel({ ...base, id: 'p' + (index + 1), product: products[index], nonce: 0 }, 'p' + (index + 1)));
}

export function nextPanelId(panels) {
  for (let i = 1; i <= MAX_PANELS + 1; i += 1) if (!panels.some((panel) => panel.id === 'p' + i)) return 'p' + i;
  return 'p' + Date.now().toString(36);
}
export function addPanel(panels, partial = {}) {
  if (panels.length >= MAX_PANELS) return panels;
  const source = panels[panels.length - 1] || {};
  return [...panels, sanitizePanel({ ...source, ...partial, id: nextPanelId(panels), nonce: 0 }, nextPanelId(panels))];
}
export function removePanel(panels, id) {
  if (panels.length <= 1) return panels;
  return panels.filter((panel) => panel.id !== id);
}
export function updatePanel(panels, id, patch) {
  return panels.map((panel) => (panel.id === id ? sanitizePanel({ ...panel, ...patch, id: panel.id }, panel.id) : panel));
}

export const defaultStore = () => ({ version: STORE_VERSION, active: 'Default', layouts: { Default: { panels: defaultPanels() } } });
export function cleanLayoutName(name) { return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40); }

export function parseStore(text) {
  try {
    const data = JSON.parse(String(text));
    if (!data || typeof data !== 'object' || data.version !== STORE_VERSION || !data.layouts || typeof data.layouts !== 'object') return defaultStore();
    const layouts = {};
    for (const [rawName, value] of Object.entries(data.layouts).slice(0, MAX_LAYOUTS)) {
      const name = cleanLayoutName(rawName);
      if (name && !(name in layouts)) layouts[name] = { panels: sanitizePanels(value?.panels) };
    }
    const names = Object.keys(layouts);
    if (!names.length) return defaultStore();
    return { version: STORE_VERSION, active: names.includes(data.active) ? data.active : names[0], layouts };
  } catch { return defaultStore(); }
}
export const serializeStore = (store) => JSON.stringify({ version: STORE_VERSION, active: store.active, layouts: store.layouts });
export function saveLayout(store, name, panels) {
  const clean = cleanLayoutName(name);
  if (!clean) return { store, error: 'Enter a layout name.' };
  if (!(clean in store.layouts) && Object.keys(store.layouts).length >= MAX_LAYOUTS) return { store, error: 'Layout limit reached (' + MAX_LAYOUTS + '). Delete one first.' };
  return { store: { ...store, active: clean, layouts: { ...store.layouts, [clean]: { panels: sanitizePanels(panels) } } }, error: null };
}
export function deleteLayout(store, name) {
  const names = Object.keys(store.layouts);
  if (names.length <= 1 || !(name in store.layouts)) return store;
  const layouts = { ...store.layouts };
  delete layouts[name];
  const remaining = Object.keys(layouts);
  return { ...store, layouts, active: store.active === name ? remaining[0] : store.active };
}
