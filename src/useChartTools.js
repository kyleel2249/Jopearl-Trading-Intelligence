import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, getApiSource } from './lib/api.js';
import {
  atrOf, createAlert, defaultPosition, drawingsKey, evaluateAlerts, loadJson, MAX_ALERTS, MAX_DRAWINGS, newDrawingId,
  replayIntervalMs, replaySlice, replayStart, replayStep, REPLAY_SPEEDS, sanitizeAlerts, sanitizeDrawings, saveJson
} from './chart-tools.js';
import { higherTimeframe, htfLevels, summarizeBook, summarizeDerivatives } from './chart-market.js';
import { publishCrosshair, shouldMirror, subscribeCrosshair } from './chart-sync.js';
import { backoffMs, decodeStreamMessage, STREAM_FRESH_MS, streamIsFresh, streamPlan } from './chart-stream.js';

const PREFS_KEY = 'jpti.chart.prefs.v2';
const DEFAULT_PREFS = { scaleMode: 'linear', showProfile: false, showMtf: false, showDepth: false, link: true, stream: true, sound: false, account: { accountSize: 10000, riskPct: 1 } };
const FUTURES = ['futures', 'coin-futures', 'usdc-futures'];
const EMPTY = [];
const storage = () => { try { return typeof window !== 'undefined' ? window.localStorage : null; } catch { return null; } };
const apiMode = () => getApiSource().mode;

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = 880; gain.gain.value = 0.05; osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.18); osc.onended = () => ctx.close();
  } catch { /* audio is optional */ }
}

function notify(title, body) {
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body }); } catch { /* optional */ }
}

/**
 * One tool-state hook for every live chart: drawing tools, alerts, replay, scale mode, range lock, live tick stream,
 * higher-timeframe levels, order-book depth, derivatives context and the crosshair link. The chart supplies geometry
 * and renders; all rules live in the pure modules (chart-tools, chart-scale, chart-market, chart-stream, chart-sync).
 */
export function useChartTools({ exchange, marketType = 'spot', symbol, timeframe, candles, livePrice, instrumentId, pip, sourceId }) {
  const selfId = useRef(sourceId || 'chart-' + Math.random().toString(36).slice(2, 9)).current;
  const marketKey = [exchange, marketType, symbol].join('|');

  /* ---- persisted preferences ---- */
  const [prefs, setPrefs] = useState(() => ({ ...DEFAULT_PREFS, ...loadJson(storage(), PREFS_KEY, {}), account: { ...DEFAULT_PREFS.account, ...(loadJson(storage(), PREFS_KEY, {}).account || {}) } }));
  useEffect(() => { saveJson(storage(), PREFS_KEY, prefs); }, [prefs]);
  const setPref = useCallback((key, value) => setPrefs((p) => ({ ...p, [key]: value })), []);

  /* ---- drawings and alerts, persisted per market ---- */
  // Stored state is tagged with the market it belongs to. While the market has just changed and the new market's
  // data has not been loaded yet, nothing is shown and, crucially, nothing is saved (no cross-market overwrite).
  const [data, setData] = useState({ key: null, drawings: EMPTY, alerts: EMPTY });
  const keyRef = useRef(marketKey);
  keyRef.current = marketKey;
  const drawings = data.key === marketKey ? data.drawings : EMPTY;
  const alerts = data.key === marketKey ? data.alerts : EMPTY;
  const patch = useCallback((field, update) => setData((d) => (d.key !== keyRef.current ? d : { ...d, [field]: typeof update === 'function' ? update(d[field]) : update })), []);
  const setDrawings = useCallback((update) => patch('drawings', update), [patch]);
  const setAlerts = useCallback((update) => patch('alerts', update), [patch]);
  useEffect(() => {
    const saved = loadJson(storage(), drawingsKey(exchange, marketType, symbol), {});
    setData({ key: marketKey, drawings: sanitizeDrawings(saved.drawings), alerts: sanitizeAlerts(saved.alerts) });
  }, [marketKey]);
  useEffect(() => { if (data.key === marketKey) saveJson(storage(), drawingsKey(exchange, marketType, symbol), { drawings: data.drawings, alerts: data.alerts }); }, [data, marketKey]);

  /* ---- tool state ---- */
  const [tool, setToolState] = useState('cursor');
  const [pending, setPending] = useState(null);
  const [measure, setMeasure] = useState(null);
  const setTool = useCallback((next) => { setToolState((cur) => (cur === next ? 'cursor' : next)); setPending(null); }, []);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') { setPending(null); setMeasure(null); setToolState('cursor'); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { setPending(null); setMeasure(null); }, [marketKey]);

  const [toasts, setToasts] = useState([]);
  const pushToast = useCallback((text, kind = 'info') => {
    const id = newDrawingId();
    setToasts((list) => [...list.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 9000);
  }, []);

  const lastClose = candles && candles.length ? candles[candles.length - 1][4] : null;
  const atr = useMemo(() => atrOf(candles || [], 14), [candles]);
  const refPrice = Number(livePrice) > 0 ? Number(livePrice) : lastClose;

  const addDrawing = useCallback((d) => setDrawings((list) => [...list, { id: newDrawingId(), ...d }].slice(-MAX_DRAWINGS)), []);
  const updateDrawing = useCallback((id, patch) => setDrawings((list) => list.map((d) => (d.id === id ? { ...d, ...patch } : d))), []);
  const removeDrawing = useCallback((id) => setDrawings((list) => list.filter((d) => d.id !== id)), []);
  const clearAll = useCallback(() => { setDrawings([]); setAlerts([]); setPending(null); setMeasure(null); }, []);
  const removeAlert = useCallback((id) => setAlerts((list) => list.filter((a) => a.id !== id)), []);

  /** Pointer events from the chart: point = { ts, price, inPlot }. Tools place on click; two-point tools take two clicks. */
  const handlePointer = useCallback((kind, point) => {
    if (!point || !Number.isFinite(point.price) || !Number.isFinite(point.ts)) return;
    if (kind === 'move') { if (pending) setPending((p) => (p ? { ...p, b: { ts: point.ts, price: point.price } } : p)); return; }
    if (kind !== 'click' || tool === 'cursor') return;
    const a = { ts: point.ts, price: point.price };
    if (tool === 'hline') { addDrawing({ kind: 'hline', price: point.price }); setToolState('cursor'); return; }
    if (tool === 'trend' || tool === 'fib' || tool === 'measure') {
      if (!pending) { setPending({ tool, a, b: a }); if (tool === 'measure') setMeasure(null); return; }
      if (tool === 'measure') setMeasure({ a: pending.a, b: a });
      else addDrawing({ kind: tool, t1: pending.a.ts, p1: pending.a.price, t2: a.ts, p2: a.price });
      setPending(null); setToolState('cursor'); return;
    }
    if (tool === 'long' || tool === 'short') {
      const pos = defaultPosition(tool, point.price, { pip, atr });
      if (pos) addDrawing({ kind: 'rr', side: pos.side, t: point.ts, entry: pos.entry, stop: pos.stop, target: pos.target });
      setToolState('cursor'); return;
    }
    if (tool === 'alert') {
      if (alerts.filter((x) => !x.triggeredAt).length >= MAX_ALERTS) { pushToast('Alert limit reached (' + MAX_ALERTS + '). Remove one first.', 'warn'); return; }
      const alert = createAlert({ price: point.price, lastPrice: refPrice });
      if (!alert) { pushToast('Pick a price away from the current price to set an alert.', 'warn'); return; }
      setAlerts((list) => [...list, alert]);
      try { if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission(); } catch { /* optional */ }
      setToolState('cursor');
    }
  }, [tool, pending, pip, atr, alerts, refPrice, addDrawing, pushToast]);

  /* ---- replay ---- */
  const [replay, setReplay] = useState(null);
  const total = candles ? candles.length : 0;
  replayActiveRef.current = Boolean(replay && replay.active);
  useEffect(() => { setReplay(null); }, [marketKey, timeframe]);
  useEffect(() => {
    if (!replay || !replay.active || !replay.playing) return undefined;
    const timer = setInterval(() => setReplay((r) => replayStep(r, total, 1)), replayIntervalMs(replay.speed));
    return () => clearInterval(timer);
  }, [replay && replay.active, replay && replay.playing, replay && replay.speed, total]);
  const replayControls = useMemo(() => ({
    start: (back = 60) => setReplay(replayStart(total, back)),
    stop: () => setReplay(null),
    toggle: () => setReplay((r) => (r && r.active ? { ...r, playing: !r.playing && r.index < total - 1 } : r)),
    step: (d) => setReplay((r) => replayStep(r, total, d)),
    seek: (index) => setReplay((r) => (r && r.active ? replayStep({ ...r, playing: false }, total, Number(index) - r.index) : r)),
    setSpeed: (speed) => setReplay((r) => (r && REPLAY_SPEEDS.includes(speed) ? { ...r, speed } : r))
  }), [total]);
  const applyReplay = useCallback((list) => replaySlice(list, replay), [replay]);

  /* ---- range lock ---- */
  const [lockedRange, setLockedRange] = useState(null);
  useEffect(() => { setLockedRange(null); }, [marketKey]);

  /* ---- live tick stream (public exchange WebSocket, REST polling stays as the fallback) ---- */
  const plan = useMemo(() => (prefs.stream ? streamPlan({ exchange, symbol, marketType, instrumentId }) : null), [prefs.stream, exchange, symbol, marketType, instrumentId]);
  const [stream, setStream] = useState({ status: 'off', price: null, bid: null, ask: null, updatedAt: null });
  useEffect(() => {
    if (!plan || typeof WebSocket === 'undefined') { setStream({ status: prefs.stream ? 'polling' : 'off', price: null, bid: null, ask: null, updatedAt: null }); return undefined; }
    let closed = false, socket = null, attempt = 0, retry = null, heartbeat = null, watchdog = null, throttle = null, latest = null;
    setStream({ status: 'connecting', price: null, bid: null, ask: null, updatedAt: null });
    const flush = () => { throttle = null; if (latest && !closed) setStream({ status: 'live', price: latest.price, bid: latest.bid, ask: latest.ask, updatedAt: Date.now() }); };
    const open = () => {
      if (closed) return;
      try { socket = new WebSocket(plan.url); } catch { setStream((s) => ({ ...s, status: 'polling' })); return; }
      socket.onopen = () => {
        attempt = 0;
        if (plan.subscribe) socket.send(JSON.stringify(plan.subscribe));
        if (plan.heartbeat) heartbeat = setInterval(() => { try { socket.send(typeof plan.heartbeat === 'string' ? plan.heartbeat : JSON.stringify(plan.heartbeat)); } catch { /* reconnect handles it */ } }, 20000);
      };
      socket.onmessage = (event) => {
        const tick = decodeStreamMessage(plan, typeof event.data === 'string' ? event.data : '');
        if (!tick) return;
        latest = tick;
        if (!throttle) throttle = setTimeout(flush, 250);
      };
      const lost = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (closed) return;
        setStream((s) => ({ ...s, status: 'polling' }));
        retry = setTimeout(open, backoffMs(attempt++));
      };
      socket.onerror = () => { try { socket.close(); } catch { /* already closed */ } };
      socket.onclose = lost;
    };
    open();
    // A socket that stays silent is as bad as a closed one: fall back to polling until ticks resume.
    watchdog = setInterval(() => setStream((s) => (s.status === 'live' && !streamIsFresh(s.updatedAt) ? { ...s, status: 'polling' } : s)), STREAM_FRESH_MS / 2);
    return () => { closed = true; clearTimeout(retry); clearTimeout(throttle); clearInterval(heartbeat); clearInterval(watchdog); try { socket && socket.close(); } catch { /* ignore */ } };
  }, [plan]);
  const streamFresh = stream.status === 'live' && streamIsFresh(stream.updatedAt);

  /* ---- alert evaluation on every live price ---- */
  const prevPrice = useRef(null);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  useEffect(() => { prevPrice.current = null; }, [marketKey]);
  const replayActiveRef = useRef(false);
  const effectivePrice = streamFresh ? stream.price : livePrice;
  useEffect(() => {
    const price = Number(effectivePrice);
    if (!(price > 0) || replayActiveRef.current) return;
    const { alerts: next, fired } = evaluateAlerts(alertsRef.current, prevPrice.current, price);
    prevPrice.current = price;
    if (!fired.length) return;
    setAlerts(next);
    for (const a of fired) {
      const text = symbol + ' crossed ' + (a.direction === 'above' ? 'above ' : 'below ') + a.price;
      pushToast(text, 'alert'); notify('JPTI price alert', text);
    }
    if (prefs.sound) beep();
  }, [effectivePrice]);


  /* ---- higher-timeframe levels ---- */
  const htf = higherTimeframe(timeframe);
  const [mtf, setMtf] = useState({ status: 'off', data: null });
  useEffect(() => {
    if (!prefs.showMtf) { setMtf({ status: 'off', data: null }); return undefined; }
    if (!htf) { setMtf({ status: 'unavailable', data: null, note: 'No higher timeframe above ' + timeframe + '.' }); return undefined; }
    if (marketType === 'cfd') { setMtf({ status: 'unavailable', data: null, note: 'Higher-timeframe levels are not loaded for CFD.' }); return undefined; }
    let active = true;
    const run = async () => {
      try {
        const instrument = exchange === 'bitget' && instrumentId ? '&instrumentId=' + encodeURIComponent(instrumentId) : '';
        const response = await apiFetch('/api/exchanges/' + exchange + '/ohlcv/' + symbol.replace('/', '-') + '?timeframe=' + htf + '&limit=6&type=' + encodeURIComponent(marketType) + instrument);
        const body = await response.json();
        if (!active) return;
        const levels = response.ok ? htfLevels(body.candles, htf) : null;
        setMtf(levels ? { status: 'ready', data: levels } : { status: 'unavailable', data: null, note: (body && body.error) || 'Higher-timeframe candles unavailable.' });
      } catch (error) { if (active) setMtf({ status: 'unavailable', data: null, note: error.message || 'Higher-timeframe candles unavailable.' }); }
    };
    run();
    const timer = setInterval(run, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [prefs.showMtf, htf, exchange, symbol, marketType, instrumentId, timeframe]);

  /* ---- order-book depth (full API only; the edge and browser-direct adapters expose no depth) ---- */
  const [book, setBook] = useState({ status: 'off', summary: null });
  const depthSupported = apiMode() === 'api';
  useEffect(() => {
    if (!prefs.showDepth) { setBook({ status: 'off', summary: null }); return undefined; }
    if (!depthSupported) { setBook({ status: 'unavailable', summary: null, note: 'Order-book depth needs the full JPTI API (not Cloudflare edge or browser-direct mode).' }); return undefined; }
    if (marketType === 'cfd') { setBook({ status: 'unavailable', summary: null, note: 'No order book for CFD.' }); return undefined; }
    let active = true, inFlight = false;
    const run = async () => {
      if (inFlight || (typeof document !== 'undefined' && document.hidden)) return;
      inFlight = true;
      try {
        const response = await apiFetch('/api/advanced/orderbook/' + exchange + '/' + symbol.replace('/', '-') + '?limit=100');
        const body = await response.json();
        if (!active) return;
        const summary = response.ok ? summarizeBook({ bids: body.bids, asks: body.asks }, { pip }) : null;
        setBook(summary ? { status: 'ready', summary, sampledAt: body.sampledAt } : { status: 'unavailable', summary: null, note: (body && body.error) || 'Order book unavailable for this market.' });
      } catch (error) { if (active) setBook({ status: 'unavailable', summary: null, note: error.message || 'Order book unavailable.' }); } finally { inFlight = false; }
    };
    run();
    const timer = setInterval(run, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [prefs.showDepth, depthSupported, exchange, symbol, marketType, pip]);

  /* ---- derivatives context (funding, mark, open interest, liquidations when the venue reports them) ---- */
  const [derivs, setDerivs] = useState({ status: 'off', data: null });
  const isFutures = FUTURES.includes(marketType);
  useEffect(() => {
    if (!isFutures) { setDerivs({ status: 'off', data: null }); return undefined; }
    if (!depthSupported) { setDerivs({ status: 'unavailable', data: null, note: 'Funding and open interest need the full JPTI API.' }); return undefined; }
    let active = true;
    const run = async () => {
      try {
        const response = await apiFetch('/api/advanced/derivatives/' + exchange + '/' + symbol.replace('/', '-'));
        const body = await response.json();
        if (!active) return;
        const data = response.ok ? summarizeDerivatives(body) : null;
        setDerivs(data ? { status: 'ready', data } : { status: 'unavailable', data: null, note: (body && body.error) || 'The venue reported no funding, mark or open-interest data for this contract.' });
      } catch (error) { if (active) setDerivs({ status: 'unavailable', data: null, note: error.message || 'Derivatives data unavailable.' }); }
    };
    run();
    const timer = setInterval(run, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [isFutures, depthSupported, exchange, symbol, marketType]);

  /* ---- spread: depth book when loaded, otherwise the stream's top of book ---- */
  const spread = useMemo(() => {
    if (book.summary) return { bestBid: book.summary.bestBid, bestAsk: book.summary.bestAsk, spread: book.summary.spread, spreadPips: book.summary.spreadPips, spreadPct: book.summary.spreadPct, source: 'book' };
    if (streamFresh && stream.bid > 0 && stream.ask >= stream.bid) {
      const s = stream.ask - stream.bid;
      return { bestBid: stream.bid, bestAsk: stream.ask, spread: s, spreadPips: pip > 0 ? Number((s / pip).toFixed(2)) : null, spreadPct: (s / ((stream.ask + stream.bid) / 2)) * 100, source: 'stream' };
    }
    return null;
  }, [book.summary, streamFresh, stream.bid, stream.ask, pip]);

  /* ---- crosshair link ---- */
  const [ghost, setGhost] = useState(null);
  useEffect(() => {
    if (!prefs.link) { setGhost(null); return undefined; }
    return subscribeCrosshair((event) => {
      if (shouldMirror(event, { source: selfId, symbol, marketType })) setGhost(event.ts === null ? null : { ts: event.ts, price: event.price });
    });
  }, [prefs.link, selfId, symbol, marketType]);
  const lastPublish = useRef(0);
  const broadcastCrosshair = useCallback((point) => {
    if (!prefs.link) return;
    const now = Date.now();
    if (point && now - lastPublish.current < 40) return;
    lastPublish.current = now;
    publishCrosshair({ source: selfId, symbol, marketType, ts: point ? point.ts : null, price: point ? point.price : null });
  }, [prefs.link, selfId, symbol, marketType]);

  return {
    selfId, prefs, setPref, tool, setTool, pending, measure, setMeasure,
    drawings, addDrawing, updateDrawing, removeDrawing, alerts, removeAlert, clearAll, handlePointer,
    toasts, pushToast, replay, replayControls, applyReplay, replaying: Boolean(replay && replay.active), total,
    lockedRange, setLockedRange, stream, streamFresh, streamPlan: plan, mtf, book, depthSupported, derivs, isFutures, spread,
    ghost, broadcastCrosshair, atr, refPrice, price: effectivePrice
  };
}
