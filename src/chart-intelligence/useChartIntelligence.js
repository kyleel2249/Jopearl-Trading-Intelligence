import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { normalizeCandles, splitClosed, timeframeMs } from '../gainz-alpha/indicators.js';
import { analyzeChartIntelligence, createMemoryLedger, createStorageLedger } from './engine.js';
import { createSettingsStore, freshAlerts } from './settings.js';

const HTF = { '1m': ['15m', '1h'], '3m': ['15m', '1h'], '5m': ['1h', '4h'], '15m': ['1h', '4h'], '30m': ['4h', '1d'], '1h': ['4h', '1d'], '2h': ['4h', '1d'], '4h': ['1d', '1w'], '6h': ['1d', '1w'], '8h': ['1d', '1w'], '12h': ['1d', '1w'], '1d': ['1w'], '3d': ['1w'], '1w': [], '1M': [] };
export const higherTimeframesFor = (tf) => HTF[tf] || [];

let store = null, ledger = null;
function safeStorage() { try { if (typeof localStorage !== 'undefined') { localStorage.setItem('jpti.ci.probe', '1'); localStorage.removeItem('jpti.ci.probe'); return localStorage; } } catch { /* none */ } return null; }
export function getStore() { if (!store) store = createSettingsStore(safeStorage()); return store; }
function getLedger() { if (!ledger) { const s = safeStorage(); ledger = s ? createStorageLedger(s) : createMemoryLedger(); } return ledger; }

const shared = new Map(), htfCache = new Map(), memorySeen = new Set();
const HTF_TTL = 60e3;

async function loadHtf(exchange, symbol, timeframe, marketType, signal) {
  const out = [];
  for (const tf of higherTimeframesFor(timeframe)) {
    const key = [exchange, symbol, tf, marketType].join('|'), hit = htfCache.get(key);
    if (hit && Date.now() - hit.at < HTF_TTL) { out.push({ timeframe: tf, candles: hit.rows }); continue; }
    try {
      const res = await apiFetch('/api/exchanges/' + exchange + '/ohlcv/' + symbol.replace('/', '-') + '?timeframe=' + tf + '&limit=120&type=' + encodeURIComponent(marketType || 'spot'), { signal });
      if (!res.ok) continue;
      const data = await res.json(), rows = (data.candles || []).filter((r) => r.length >= 6).map((r) => r.map(Number));
      htfCache.set(key, { at: Date.now(), rows }); out.push({ timeframe: tf, candles: rows });
    } catch { /* MTF stays unavailable for this timeframe and the engine reports it */ }
  }
  return out;
}

/** One hook per chart. Charts on the same exchange/symbol/timeframe share one computed result object. */
export function useChartIntelligence({ exchange, symbol, timeframe, marketType = 'spot', candles, ga, externalLevels, institutionalContext = null, chainDexContext = null, sessionContext = null, clock }) {
  const st = getStore();
  const [settings, setSettings] = useState(() => st.get());
  const [htf, setHtf] = useState({ key: '', data: [] });
  const [alerts, setAlerts] = useState([]);
  const idRef = useRef(null);
  useEffect(() => st.subscribe((s) => setSettings(s)), [st]);

  useEffect(() => {
    if (!settings.enabled || !exchange || !symbol || !timeframe) return undefined;
    const ctl = new AbortController(), key = [exchange, symbol, timeframe, marketType].join('|');
    loadHtf(exchange, symbol, timeframe, marketType, ctl.signal).then((data) => { if (!ctl.signal.aborted) setHtf({ key, data }); });
    const timer = setInterval(() => loadHtf(exchange, symbol, timeframe, marketType, ctl.signal).then((data) => { if (!ctl.signal.aborted) setHtf({ key, data }); }), HTF_TTL);
    return () => { ctl.abort(); clearInterval(timer); };
  }, [exchange, symbol, timeframe, marketType, settings.enabled]);

  const lastClosed = useMemo(() => {
    const { closed } = splitClosed(normalizeCandles(candles), timeframe, clock || Date.now());
    return closed.length ? closed[closed.length - 1][0] : 0;
  }, [candles, timeframe, clock]);

  const extHash = useMemo(() => JSON.stringify((externalLevels || []).map((l) => [l.label, Number(l.price)])), [externalLevels]);
  const institutionalHash = useMemo(() => JSON.stringify(institutionalContext ? [institutionalContext.generatedAt, institutionalContext.score?.score, institutionalContext.market?.priceChangePct, institutionalContext.market?.orderBookImbalancePct, institutionalContext.market?.fundingRate, institutionalContext.broadContext?.globalMarketCapChange24hPct, institutionalContext.sources?.map((s) => [s.name, s.status])] : null), [institutionalContext]);
  const chainDexHash = useMemo(() => JSON.stringify(chainDexContext ? [chainDexContext.generatedAt, chainDexContext.status, chainDexContext.flow, chainDexContext.pools?.map(p=>[p.chainId,p.pairAddress,p.liquidityUsd,p.volume24hUsd]), chainDexContext.trades?.length, chainDexContext.sources?.map(x=>[x.name,x.status])] : null), [chainDexContext]);
  const sessionHash = useMemo(() => JSON.stringify(sessionContext ? [sessionContext.generatedAt, sessionContext.status, sessionContext.directionalBias, sessionContext.sessions?.map(x=>[x.id,x.forecast?.high,x.forecast?.low,x.confidence]), sessionContext.liquidity24h?.levels?.high?.price, sessionContext.liquidity24h?.levels?.low?.price] : null), [sessionContext]);
  const gaAsOf = ga && ga.result && ga.result.confirmed ? ga.result.confirmed.asOf : null;
  const gaSignal = ga && ga.result && ga.result.confirmed ? ga.result.confirmed.signal : null;
  const result = useMemo(() => {
    if (!settings.enabled || !candles || !candles.length || !lastClosed) return null;
    const htfOk = htf.key === [exchange, symbol, timeframe, marketType].join('|') ? htf.data : [];
    const key = [exchange, symbol, timeframe, marketType, lastClosed, gaAsOf, gaSignal, htfOk.length, extHash, institutionalHash, chainDexHash, sessionHash, ga && ga.settings ? JSON.stringify([ga.settings.preset, ga.settings.overrides]) : '', settings.historyBars].join('|');
    const hit = shared.get(key); if (hit) return hit;
    let out;
    try {
      const gs = ga && ga.hub ? ga.hub.getState() : null;
      out = analyzeChartIntelligence(candles, { exchange, symbol, timeframe, now: clock || Date.now(), gainz: ga && ga.result && !ga.result.error ? ga.result : null, higherTimeframes: htfOk, outcomes: gs ? gs.outcomes : [], externalLevels: externalLevels || [], institutionalContext, chainDexContext, sessionContext, ledger: getLedger(), historyBars: settings.historyBars, preset: ga && ga.settings ? ga.settings.preset : undefined, overrides: ga && ga.settings ? ga.settings.overrides : undefined });
    } catch (error) { out = { status: 'error', reason: error.message, layers: {}, alerts: [], provenance: [] }; }
    shared.set(key, out); if (shared.size > 48) shared.delete(shared.keys().next().value);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.enabled, settings.historyBars, exchange, symbol, timeframe, marketType, lastClosed, gaAsOf, gaSignal, htf, extHash, institutionalHash, chainDexHash, sessionHash]);

  useEffect(() => {
    if (!result || result.status !== 'ready' || !result.alerts.length) return;
    const tf = timeframeMs(timeframe) || 0, fresh = freshAlerts(result.alerts, safeStorage(), memorySeen);
    if (!fresh.length) return;
    setAlerts((prev) => [...fresh, ...prev].slice(0, 20));
    const recent = Date.now() - result.asOf <= tf * 2.5;
    if (settings.alerts.notify && recent && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      fresh.filter((a) => a.severity !== 'info').slice(0, 3).forEach((a) => { try { new Notification('JPTI ' + symbol + ' ' + timeframe, { body: a.message, tag: a.id }); } catch { /* unsupported */ } });
    }
  }, [result, settings.alerts.notify, symbol, timeframe]);

  const requestNotifications = async () => {
    if (typeof Notification === 'undefined') return 'unsupported';
    const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    st.update({ alerts: { notify: p === 'granted' } });
    return p;
  };
  if (idRef.current === null) idRef.current = 'ci-' + Math.random().toString(36).slice(2, 8);
  return { result, settings, update: (patch) => st.update(patch), reset: () => st.reset(), alerts, clearAlerts: () => setAlerts([]), requestNotifications, htfLoaded: htf.data.length, chartId: idRef.current };
}
