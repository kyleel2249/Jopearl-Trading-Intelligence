// Shared, persisted chart-intelligence settings (one store for every chart instance) and alert de-duplication.
import { DEFAULT_LAYER_VISIBILITY } from './engine.js';

export const SETTINGS_KEY = 'jpti.chart-intelligence.settings.v1', SEEN_KEY = 'jpti.chart-intelligence.alerts-seen.v1';
export const DEFAULT_SETTINGS = { enabled: true, layers: { ...DEFAULT_LAYER_VISIBILITY }, density: 'auto', alerts: { notify: false }, historyBars: 60 };

export function sanitizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const layers = { ...DEFAULT_LAYER_VISIBILITY };
  for (const k of Object.keys(layers)) if (s.layers && typeof s.layers[k] === 'boolean') layers[k] = s.layers[k];
  return { enabled: s.enabled !== false, layers, density: ['auto', 'full', 'minimal'].includes(s.density) ? s.density : 'auto', alerts: { notify: !!(s.alerts && s.alerts.notify) }, historyBars: Math.max(20, Math.min(150, Math.floor(Number(s.historyBars) || 60))) };
}

export function createSettingsStore(storage = null) {
  let state = sanitizeSettings(null);
  const subs = new Set();
  if (storage) { try { const raw = storage.getItem(SETTINGS_KEY); if (raw) state = sanitizeSettings(JSON.parse(raw)); } catch { /* defaults */ } }
  const persist = () => { if (storage) { try { storage.setItem(SETTINGS_KEY, JSON.stringify(state)); } catch { /* memory only */ } } };
  return {
    get: () => state,
    update(patch) { state = sanitizeSettings({ ...state, ...patch, layers: { ...state.layers, ...(patch && patch.layers) }, alerts: { ...state.alerts, ...(patch && patch.alerts) } }); persist(); subs.forEach((f) => { try { f(state); } catch { /* isolate */ } }); return state; },
    reset() { state = sanitizeSettings(null); persist(); subs.forEach((f) => { try { f(state); } catch { /* isolate */ } }); return state; },
    subscribe(f) { subs.add(f); return () => subs.delete(f); }
  };
}

/** Returns alerts not seen before; remembers ids (bounded) so a repeat render or a second chart never re-fires them. */
export function freshAlerts(alerts, storage = null, memory = new Set()) {
  let seen = memory;
  if (storage) { try { seen = new Set(JSON.parse(storage.getItem(SEEN_KEY) || '[]')); } catch { seen = new Set(); } }
  const out = alerts.filter((a) => !seen.has(a.id));
  out.forEach((a) => seen.add(a.id));
  if (storage && out.length) { try { storage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-400))); } catch { /* ignore */ } }
  return out;
}
