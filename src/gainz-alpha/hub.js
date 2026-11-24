// Shared intelligence hub: ONE engine run per (symbol, exchange, timeframe, settings) no matter how many charts
// subscribe. Handles signal registry, outcome tracking, learning loop, events, persistence and diagnostics.
import { analyzeGainzAlpha, toAlphaEvidence } from './engine.js';
import { PRESETS, resolvePreset, MODEL_VERSION } from './presets.js';
import { createModel, adaptModel, rollbackModel, evaluateOutcome, signalToRecord, summarize } from './learning.js';
import { normalizeCandles, splitClosed, timeframeMs } from './indicators.js';

export const SCHEMA = 1, STORAGE_KEY = 'jpti.gainz-alpha.v1';
export const EVENT_TYPES = ['GAINZ_ALPHA_SIGNAL', 'GAINZ_ALPHA_SETUP', 'GAINZ_ALPHA_SWEEP', 'GAINZ_ALPHA_RECLAIM', 'GAINZ_ALPHA_DISPLACEMENT', 'GAINZ_ALPHA_CONFIRMATION', 'GAINZ_ALPHA_INVALIDATION', 'GAINZ_ALPHA_OUTCOME', 'GAINZ_ALPHA_LEARNING_UPDATE', 'GAINZ_ALPHA_MODEL_CHANGE'];

export const DEFAULT_SETTINGS = {
  enabled: true, preset: 'balanced', overrides: {}, intrabarPreview: true, closedCandleConfirmation: true, adaptiveLearning: true,
  outcomeWindow: 24, historyWindow: 400, profiles: {},
  overlays: { liquidity: true, setup: true, fvg: true, signal: true, risk: true, structure: false, equalLevels: true }
};

export function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return { ok: false, errors: ['event must be an object'] };
  if (!EVENT_TYPES.includes(e.type)) errors.push('unknown type');
  if (typeof e.id !== 'string' || !e.id) errors.push('missing id');
  if (!Number.isFinite(e.ts)) errors.push('missing ts');
  if (!e.symbol || !e.timeframe) errors.push('missing symbol/timeframe');
  if (e.schema !== SCHEMA) errors.push('bad schema');
  if (!e.payload || typeof e.payload !== 'object') errors.push('missing payload');
  return { ok: !errors.length, errors };
}

export function migrate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const v = Number(raw.schema || 0);
  if (v > SCHEMA) return { ...raw, _readOnly: true };
  const base = { schema: SCHEMA, settings: { ...DEFAULT_SETTINGS }, model: createModel(), outcomes: [], pending: [], recent: [] };
  // v0 (unversioned) stored outcomes/settings at the top level with the same field names.
  return { ...base, ...raw, schema: SCHEMA, settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}), overlays: { ...DEFAULT_SETTINGS.overlays, ...(raw.settings?.overlays || {}) } }, model: raw.model?.schema ? raw.model : createModel(), outcomes: Array.isArray(raw.outcomes) ? raw.outcomes : [], pending: Array.isArray(raw.pending) ? raw.pending : [], recent: Array.isArray(raw.recent) ? raw.recent : [] };
}

export function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input || {}) };
  if (!PRESETS[String(s.preset).toLowerCase()]) s.preset = 'balanced';
  s.preset = String(s.preset).toLowerCase();
  s.overlays = { ...DEFAULT_SETTINGS.overlays, ...(input?.overlays || {}) };
  s.outcomeWindow = Math.round(Math.min(200, Math.max(3, Number(s.outcomeWindow) || 24)));
  s.historyWindow = Math.round(Math.min(1500, Math.max(120, Number(s.historyWindow) || 400)));
  s.overrides = s.overrides && typeof s.overrides === 'object' ? s.overrides : {};
  s.profiles = s.profiles && typeof s.profiles === 'object' ? s.profiles : {};
  return s;
}

export function createHub({ storage = null, now = () => Date.now(), maxContexts = 48, maxOutcomes = 5000, learnEvery = 10 } = {}) {
  let state = migrate({}), status = { persistence: storage ? { ok: true } : { ok: false, error: 'no storage available (memory only)' }, loadedFromStorage: false };
  const settingsHandlers = new Set(), listeners = new Map(), cache = new Map(), seenEvents = new Set(), eventLog = [], eventHandlers = new Set();
  let version = 0, outcomesSinceLearn = 0, dispatching = false, remote = null, unsynced = [], flushing = false;

  if (storage) {
    try { const raw = storage.getItem(STORAGE_KEY); if (raw) { const m = migrate(JSON.parse(raw)); if (m) { state = m; status.loadedFromStorage = true; } } }
    catch (e) { status.persistence = { ok: false, error: 'load failed: ' + e.message }; }
  }
  state.settings = sanitizeSettings(state.settings);

  function persist() {
    if (!storage || state._readOnly) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, outcomes: state.outcomes.slice(-maxOutcomes) })); status.persistence = { ok: true }; }
    catch (e) { status.persistence = { ok: false, error: 'save failed: ' + e.message }; }
  }

  async function flushRemote() {
    if (!remote || flushing || !unsynced.length) return;
    flushing = true;
    const batch = unsynced.slice(0, 200);
    try { await remote.save(batch); unsynced = unsynced.filter((r) => !batch.includes(r)); status.remote = { ok: true, lastSyncedAt: now(), pending: unsynced.length }; }
    catch (e) { status.remote = { ok: false, error: e.message, pending: unsynced.length }; }
    finally { flushing = false; }
  }
  function mergeOutcomes(records) {
    const have = new Set(state.outcomes.map((r) => r.id)); let added = 0;
    for (const r of records) if (r && r.id && !have.has(r.id)) { state.outcomes.push(r); have.add(r.id); added++; }
    if (added) { state.outcomes.sort((a, b) => a.candleTs - b.candleTs); state.outcomes = state.outcomes.slice(-maxOutcomes); version++; persist(); }
    return added;
  }

  function emit(type, ctx, payload, idPart) {
    const e = { type, id: [type, ctx.symbol, ctx.timeframe, idPart].join('|'), ts: now(), symbol: ctx.symbol, timeframe: ctx.timeframe, exchange: ctx.exchange, schema: SCHEMA, payload };
    if (seenEvents.has(e.id) || !validateEvent(e).ok) return false;
    seenEvents.add(e.id); if (seenEvents.size > 8000) seenEvents.delete(seenEvents.values().next().value);
    eventLog.push(e); if (eventLog.length > 500) eventLog.shift();
    if (!dispatching) { dispatching = true; try { eventHandlers.forEach((h) => { try { h(e); } catch { /* isolate handler errors */ } }); } finally { dispatching = false; } }
    return true;
  }

  function trackSetupEvents(r, ctx) {
    const s = r.setup;
    if (!s || r.provisional) return;
    const map = { SWEEP_DETECTED: 'GAINZ_ALPHA_SWEEP', RECLAIM_CONFIRMED: 'GAINZ_ALPHA_RECLAIM', DISPLACEMENT_CONFIRMED: 'GAINZ_ALPHA_DISPLACEMENT', ENTRY_READY: 'GAINZ_ALPHA_CONFIRMATION', INVALIDATED: 'GAINZ_ALPHA_INVALIDATION' };
    for (const t of s.trace) if (map[t.state]) emit(map[t.state], ctx, { setupId: s.id, state: t.state, index: t.index, note: t.note || null }, s.id + '|' + t.state);
    emit('GAINZ_ALPHA_SETUP', ctx, { setupId: s.id, state: s.state, direction: s.direction }, s.id + '|' + s.state);
  }

  function resolvePending(ctx, closed) {
    const still = [];
    for (const p of state.pending) {
      if (p.symbol !== ctx.symbol || p.timeframe !== ctx.timeframe || p.exchange !== ctx.exchange) { still.push(p); continue; }
      const future = closed.filter((c) => c[0] > p.candleTs);
      const out = evaluateOutcome({ signal: p.signal, riskPlan: p.riskPlan }, future, { window: state.settings.outcomeWindow, costPct: (p.riskPlan.costs?.spreadPct || 0) + (p.riskPlan.costs?.slippagePct || 0) });
      if (out.status !== 'resolved') { still.push(p); continue; }
      const rec = { ...p.record, ...out, recordedAt: now() };
      state.outcomes.push(rec); if (state.outcomes.length > maxOutcomes) state.outcomes.shift();
      if (remote) unsynced.push(rec);
      emit('GAINZ_ALPHA_OUTCOME', ctx, { id: rec.id, outcome: rec.outcome, returnR: rec.returnR, falseSignal: rec.falseSignal }, rec.id);
      outcomesSinceLearn++; version++;
    }
    state.pending = still;
    if (remote && unsynced.length) flushRemote();
    if (state.settings.adaptiveLearning && outcomesSinceLearn >= learnEvery) {
      outcomesSinceLearn = 0;
      const res = adaptModel(state.model, state.outcomes);
      emit('GAINZ_ALPHA_LEARNING_UPDATE', ctx, { changed: res.changed, n: res.n, reason: res.reason || null, deltas: res.deltas || {} }, 'learn|' + state.model.version + '|' + res.n);
      if (res.changed) { state.model = res.model; version++; emit('GAINZ_ALPHA_MODEL_CHANGE', ctx, { version: state.model.version, drifting: res.drifting }, 'model|' + state.model.version); }
    }
  }

  function ingest({ chartId = 'default', exchange = 'unknown', symbol, timeframe, candles, higherTimeframes = [] }) {
    const s = state.settings, ctx = { exchange, symbol, timeframe };
    if (!s.enabled) return { enabled: false };
    if (!symbol || !timeframe) return { error: 'symbol and timeframe are required' };
    const rows = normalizeCandles(candles).slice(-s.historyWindow);
    const t = now(), { closed, forming } = splitClosed(rows, timeframe, t);
    const lastClosed = closed.length ? closed[closed.length - 1][0] : 0;
    const sHash = JSON.stringify([s.preset, s.overrides]);
    const key = [exchange, symbol, timeframe, sHash, state.model.version, version, lastClosed].join('|');
    let confirmed = cache.get(key);
    let fresh = false;
    if (!confirmed) {
      fresh = true;
      try {
        confirmed = analyzeGainzAlpha(rows, { symbol, exchange, timeframe, now: t, mode: 'confirmed', preset: s.preset, overrides: s.overrides, outcomes: state.outcomes, model: state.model, recentSignals: state.recent, higherTimeframes });
      } catch (e) { confirmed = { status: 'error', reason: e.message, signal: 'WAIT', confirmed: false, provisional: false, blockers: ['engine error: ' + e.message], explanation: { positives: [], negatives: ['engine error'] }, factors: [] }; }
      cache.set(key, confirmed); if (cache.size > maxContexts) cache.delete(cache.keys().next().value);
      if (confirmed.status === 'ready') {
        resolvePending(ctx, closed);
        trackSetupEvents(confirmed, ctx);
        if (['BUY', 'SELL'].includes(confirmed.signal)) {
          const rec = signalToRecord(confirmed); rec.tfMs = timeframeMs(timeframe);
          if (!state.recent.some((x) => x.setupId === confirmed.setupId && x.direction === confirmed.signal && x.candleTs === confirmed.asOf)) {
            state.recent = [...state.recent, { setupId: confirmed.setupId, direction: confirmed.signal, symbol, timeframe, candleTs: confirmed.asOf }].slice(-300);
            state.pending.push({ symbol, timeframe, exchange, candleTs: confirmed.asOf, signal: confirmed.signal, riskPlan: confirmed.riskPlan, record: rec }); state.pending = state.pending.slice(-300);
            emit('GAINZ_ALPHA_SIGNAL', ctx, { signal: confirmed.signal, confidence: confirmed.confidence, score: confirmed.score, setupId: confirmed.setupId, riskPlan: confirmed.riskPlan }, rec.id);
          }
        }
        persist();
      }
    }
    let preview = null;
    if (s.intrabarPreview && forming) {
      try { preview = analyzeGainzAlpha(rows, { symbol, exchange, timeframe, now: t, mode: 'preview', preset: s.preset, overrides: s.overrides, outcomes: state.outcomes, model: state.model, higherTimeframes }); } catch { preview = null; }
    }
    const out = { chartId, confirmed, preview, alphaEvidence: toAlphaEvidence(confirmed), fresh, settings: s };
    if (fresh) listeners.forEach((l, id) => { if (id !== chartId && l.key === [exchange, symbol, timeframe].join('|')) { try { l.fn(out); } catch { /* isolate */ } } });
    return out;
  }

  return {
    async attachRemote(adapter, scope = {}) {
      remote = adapter;
      try {
        const records = await adapter.load(scope); const added = mergeOutcomes(records);
        const known = new Set(records.map((r) => r.id));
        unsynced = state.outcomes.filter((r) => !known.has(r.id));
        status.remote = { ok: true, loaded: records.length, added, pending: unsynced.length };
        if (unsynced.length) await flushRemote();
      } catch (e) { status.remote = { ok: false, error: e.message, pending: unsynced.length }; }
      return status.remote;
    },
    flushRemote,
    ingest, status: () => ({ ...status }), getState: () => state,
    subscribe(chartId, ctxKey, fn) { listeners.set(chartId, { key: ctxKey, fn }); return () => listeners.delete(chartId); },
    release(chartId) { listeners.delete(chartId); },
    onEvent(fn) { eventHandlers.add(fn); return () => eventHandlers.delete(fn); },
    events: () => eventLog.slice(), listenerCount: () => listeners.size, cacheSize: () => cache.size,
    getSettings: () => state.settings,
    onSettingsChange(fn) { settingsHandlers.add(fn); return () => settingsHandlers.delete(fn); },
    updateSettings(patch) { state.settings = sanitizeSettings({ ...state.settings, ...patch, overlays: { ...state.settings.overlays, ...(patch?.overlays || {}) } }); version++; persist(); settingsHandlers.forEach((h) => { try { h(state.settings); } catch { /* isolate */ } }); return state.settings; },
    resetSettings() { state.settings = sanitizeSettings(null); version++; persist(); settingsHandlers.forEach((h) => { try { h(state.settings); } catch { /* isolate */ } }); return state.settings; },
    saveProfile(name, profile) { state.settings.profiles = { ...state.settings.profiles, [name]: { preset: state.settings.preset, overrides: state.settings.overrides, ...(profile || {}) } }; persist(); },
    loadProfile(name) { const p = state.settings.profiles[name]; if (!p) return null; return this.updateSettings({ preset: p.preset, overrides: p.overrides }); },
    exportSettings: () => JSON.stringify({ kind: 'jpti-gainz-alpha-settings', schema: SCHEMA, settings: state.settings }),
    importSettings(text) { try { const o = JSON.parse(text); if (o.kind !== 'jpti-gainz-alpha-settings' || o.schema > SCHEMA) return { ok: false, error: 'not a compatible settings export' }; this.updateSettings(o.settings); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    expectancy: (filter) => summarize(state.outcomes, filter),
    rollbackModel() { const r = rollbackModel(state.model); if (r.rolledBack) { state.model = r.model; version++; persist(); } return r; },
    diagnose(result, env = {}) { return diagnose(result, { ...env, status, state, hubLoaded: true }); }
  };
}

/** Per-subsystem diagnostics. One failing subsystem never hides behind an overall "ok". */
export function diagnose(result, env = {}) {
  const r = result?.confirmed || result || {}, ready = r.status === 'ready';
  const check = (id, ok, detail) => ({ id, ok: !!ok, detail });
  const checks = [
    check('engine-loaded', env.hubLoaded !== false && typeof analyzeGainzAlpha === 'function', 'core module present'),
    check('candle-input', env.candleCount > 0, env.candleCount > 0 ? env.candleCount + ' valid candles' : 'no valid candles'),
    check('enough-history', ready || r.status === undefined ? ready : false, ready ? 'history sufficient' : r.reason || 'insufficient history'),
    check('timeframe-recognized', !!timeframeMs(env.timeframe), String(env.timeframe)),
    check('symbol-recognized', !!env.symbol && env.symbol !== 'unknown', String(env.symbol)),
    check('live-data-current', env.lastCandleTs != null && env.now != null && env.timeframe ? env.now - env.lastCandleTs <= 3 * (timeframeMs(env.timeframe) || 0) : false, env.lastCandleTs ? 'last candle ' + new Date(env.lastCandleTs).toISOString() : 'no candle timestamp'),
    check('indicators-computed', ready && !!r.market && Number.isFinite(r.market.atr), ready ? 'ATR/RSI/MACD/EMA ok' : 'not computed'),
    check('sweep-detection', ready && r.structure != null, ready ? 'liquidity scan active' : 'inactive'),
    check('setup-classifier', ready && 'stage' in r, ready ? 'stage ' + r.stage : 'inactive'),
    check('alpha-connection', ready && env.alphaConsumer === true, env.alphaConsumer === true ? 'Alpha evidence consumer attached' : 'no Alpha consumer attached to this chart'),
    check('historical-memory', env.state ? Array.isArray(env.state.outcomes) : false, env.state ? env.state.outcomes.length + ' outcomes stored' : 'unavailable'),
    check('learning-engine', env.state ? !!env.state.model && env.state.settings?.adaptiveLearning : false, env.state ? 'model v' + env.state.model.version + (env.state.settings.adaptiveLearning ? '' : ' (learning disabled)') : 'unavailable'),
    check('risk-model', ready && (r.riskPlan !== undefined), ready ? (r.riskPlan ? 'plan computed' : 'no directional plan (WAIT)') : 'inactive'),
    check('overlays-loaded', env.overlaysLoaded === true, env.overlaysLoaded ? 'overlay layer mounted' : 'overlay layer not mounted'),
    check('backend-sync', env.status?.remote ? env.status.remote.ok : true, env.status?.remote ? (env.status.remote.ok ? 'backend memory synced (' + (env.status.remote.pending || 0) + ' pending)' : 'backend sync failing: ' + env.status.remote.error) : 'backend sync not attached (local-only memory)'),
    check('persistence', env.status?.persistence?.ok, env.status?.persistence?.ok ? 'storage writable' : env.status?.persistence?.error || 'unavailable')
  ];
  const failed = checks.filter((c) => !c.ok);
  return { overall: failed.length === 0 ? 'operational' : failed.length <= 3 ? 'degraded' : 'impaired', failed: failed.map((c) => c.id), checks, modelVersion: MODEL_VERSION };
}

let singleton = null;
export function getHub() {
  if (!singleton) {
    let storage = null;
    try { if (typeof localStorage !== 'undefined') { localStorage.setItem('jpti.ga.probe', '1'); localStorage.removeItem('jpti.ga.probe'); storage = localStorage; } } catch { storage = null; }
    singleton = createHub({ storage });
  }
  return singleton;
}
export { resolvePreset };
