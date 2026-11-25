import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import { DESK_AGENTS, buildFleetEvidence, fleetEvents, initialDeskState, normalizeCandles, paperEvents, reduceDesk } from './agent-desk-engine.js';
import { drawCandles, drawLine } from './desk-charts.js';
import './AgentDeskLive.css';

const EXCHANGES = ['bitget', 'binance', 'bybit', 'okx'];
const SYMBOL = /^[A-Z0-9]{2,15}[/-][A-Z0-9]{2,15}$/;
const POLL_MS = 30000, STEP_MS = 420, STORE_KEY = 'jpti.agentDesk.equityHistory.v1';
const money = (v) => (Number.isFinite(v) ? v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—');
const reducedMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

async function getJson(path) {
  const response = await apiFetch(path, { cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || 'Request failed (' + response.status + ')');
  return data;
}
function nodeClass(agent) {
  if (!agent) return 'idle';
  if (agent.status === 'blocked_stale_evidence') return 'blocked';
  if (agent.status !== 'evaluated') return 'missing';
  return agent.score > 0.15 ? 'bull' : agent.score < -0.15 ? 'bear' : 'flat';
}

export default function AgentDeskLive() {
  const [state, dispatch] = useReducer(reduceDesk, undefined, initialDeskState);
  const [candles, setCandles] = useState([]);
  const [exchange, setExchange] = useState('bitget');
  const [draft, setDraft] = useState('BTC/USDT');
  const [symbol, setSymbol] = useState('BTC/USDT');
  const [busy, setBusy] = useState(false);
  const [marketError, setMarketError] = useState('');
  const [paperError, setPaperError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const seen = useRef(new Set()), timers = useRef([]), alive = useRef(true), runId = useRef(0);
  const candleCanvas = useRef(null), curveCanvas = useRef(null);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const animate = useCallback(() => {
    clearTimers();
    if (reducedMotion()) { dispatch({ type: 'activate', data: { id: null } }); return; }
    DESK_AGENTS.forEach((agent, i) => timers.current.push(setTimeout(() => alive.current && dispatch({ type: 'activate', data: { id: agent.id } }), i * STEP_MS)));
    timers.current.push(setTimeout(() => alive.current && dispatch({ type: 'activate', data: { id: null } }), DESK_AGENTS.length * STEP_MS + 600));
  }, []);

  const load = useCallback(async () => {
    const mine = ++runId.current, pair = symbol.replace('/', '-'), base = '/api/exchanges/' + exchange + '/ohlcv/' + pair + '?limit=200&type=spot&timeframe=';
    setBusy(true);
    const [paper, c5, c15, c1h, ctx] = await Promise.allSettled([
      getJson('/api/paper/overview'), getJson(base + '5m'), getJson(base + '15m'), getJson(base + '1h'),
      getJson('/api/intelligence/market/' + exchange + '/' + pair + '/context?timeframe=5m&type=spot')
    ]);
    if (!alive.current || mine !== runId.current) return;
    if (paper.status === 'fulfilled') { setPaperError(''); paperEvents(paper.value, seen.current).forEach((e) => dispatch(e)); setUpdatedAt(paper.value?.updatedAt || null); }
    else setPaperError(paper.reason?.message || 'Paper ledger unavailable.');
    if (c5.status === 'fulfilled') {
      const series = { '5m': c5.value?.candles };
      if (c15.status === 'fulfilled') series['15m'] = c15.value?.candles;
      if (c1h.status === 'fulfilled') series['1h'] = c1h.value?.candles;
      const market = ctx.status === 'fulfilled' ? ctx.value?.market || ctx.value?.body?.market || null : null;
      setCandles(normalizeCandles(c5.value?.candles).slice(-60));
      const built = buildFleetEvidence(series, market, Date.now());
      if (built.evidence) { setMarketError(''); fleetEvents(symbol, built.evidence, Date.now()).events.forEach((e) => dispatch(e)); animate(); }
      else setMarketError(built.reason || 'Not enough candles to evaluate the fleet.');
    } else setMarketError(c5.reason?.message || 'Market data unavailable.');
    setBusy(false);
  }, [exchange, symbol, animate]);

  useEffect(() => {
    alive.current = true;
    try { const saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || 'null'); if (saved) dispatch({ type: 'restore', data: { history: saved } }); } catch { /* storage is best effort */ }
    return () => { alive.current = false; clearTimers(); };
  }, []);
  useEffect(() => {
    if (state.history.length < 2) return;
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state.history.slice(-240))); } catch { /* quota or private mode */ }
  }, [state.history]);
  useEffect(() => {
    load();
    const tick = () => { if (typeof document === 'undefined' || !document.hidden) load(); };
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [load]);
  useEffect(() => {
    const draw = () => { drawCandles(candleCanvas.current, candles); drawLine(curveCanvas.current, state.history.map((p) => p.v)); };
    draw();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(draw);
    [candleCanvas.current, curveCanvas.current].forEach((c) => c && observer.observe(c));
    return () => observer.disconnect();
  }, [candles, state.history]);

  const submit = (event) => {
    event.preventDefault();
    const next = draft.trim().toUpperCase();
    if (!SYMBOL.test(next)) { setMarketError('Use a pair such as BTC/USDT.'); return; }
    setMarketError(''); setSymbol(next.replace('-', '/'));
  };
  const ratio = state.balance !== null && state.start ? state.balance / state.start : null;
  const activeIndex = DESK_AGENTS.findIndex((a) => a.id === state.active);
  const pos = (i) => { const a = (i / DESK_AGENTS.length) * Math.PI * 2 - Math.PI / 2; return { x: 50 + 39 * Math.cos(a), y: 50 + 39 * Math.sin(a) }; };
  const c = state.consensus;

  return <section className="glass-panel detail-workspace adl" aria-label="Agent Desk Live">
    <header className="section-heading ops-title">
      <div><span className="eyebrow">LIVE AGENT DESK · REAL MARKET DATA / VIRTUAL EXECUTION</span><h3>Agent Desk Live</h3>
        <p>The ten JPTI specialist agents score live candles and context on the orbit; the ledger below is the real paper-trading fleet. Nothing here can place an order.</p></div>
      <span className="paper-chip"><Lock size={13} /> {state.mode === 'PAPER' ? 'PAPER ONLY · LIVE ORDERS DISABLED' : 'LEDGER UNVERIFIED'}</span>
    </header>
    <form className="adl-controls" onSubmit={submit}>
      <label>Exchange<select value={exchange} onChange={(e) => setExchange(e.target.value)}>{EXCHANGES.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select></label>
      <label>Pair<input value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck="false" autoCapitalize="characters" aria-describedby="adl-err" /></label>
      <button type="submit" className="small-refresh" disabled={busy}>Apply</button>
      <button type="button" className="small-refresh" onClick={load} disabled={busy}><RefreshCw size={14} />{busy ? 'Updating…' : 'Refresh'}</button>
    </form>
    <p id="adl-err" role="alert" className="quote-error">{marketError}{marketError && paperError ? ' · ' : ''}{paperError && 'Paper ledger: ' + paperError}</p>
    <div className="adl-stats">
      <div><span>FLEET PAPER EQUITY</span><b>{money(state.balance)}</b><small>{ratio === null ? '—' : ratio.toFixed(3) + 'x of ' + money(state.start)}</small></div>
      <div><span>CLOSED TRADES</span><b>{state.trades}</b><small>{state.wins}W / {state.losses}L</small></div>
      <div><span>FLEET CONSENSUS</span><b className={c?.blocked ? 'down' : ''}>{c ? c.action.replace(/_/g, ' ') : '—'}</b><small>{c ? c.evaluated + '/' + c.total + ' agents evaluated' : 'awaiting first evaluation'}</small></div>
      <div><span>UPDATED</span><b>{updatedAt ? new Date(updatedAt).toLocaleTimeString() : '—'}</b><small>{symbol} · {exchange.toUpperCase()}</small></div>
    </div>
    <div className="adl-grid">
      <div className="adl-orbit" role="group" aria-label="Specialist agent orbit">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <circle cx="50" cy="50" r="39" className="ring" />
          {activeIndex >= 0 && <line key={state.active} x1="50" y1="50" x2={pos(activeIndex).x} y2={pos(activeIndex).y} className="spoke" />}
        </svg>
        <div className="core" aria-hidden="true">JPTI<br />CORE</div>
        <ul>{DESK_AGENTS.map((agent, i) => { const a = state.agents[agent.id], p = pos(i);
          return <li key={agent.id} className={'node ' + nodeClass(a) + (state.active === agent.id ? ' on' : '')} style={{ left: p.x + '%', top: p.y + '%' }}
            title={a?.rationale || agent.name} aria-label={agent.name + ': ' + (a ? (a.status === 'evaluated' ? 'score ' + a.score : a.status.replace(/_/g, ' ')) : 'waiting')}>
            <b>{agent.id}</b><small>{a ? (a.status === 'evaluated' ? (a.score > 0 ? '+' : '') + a.score.toFixed(2) : a.status === 'blocked_stale_evidence' ? 'stale' : 'no data') : '…'}</small></li>; })}</ul>
      </div>
      <div className="adl-charts">
        <h4>{symbol} · 5m</h4><canvas ref={candleCanvas} className="adl-canvas" role="img" aria-label={'Candlestick chart for ' + symbol} />
        <h4>Fleet paper equity</h4><canvas ref={curveCanvas} className="adl-canvas short" role="img" aria-label="Fleet paper equity curve" />
        {!candles.length && <p className="subtle-note">Waiting for candles…</p>}
      </div>
    </div>
    <div className="adl-terminal">
      <table><caption>Desk roster · paper fleet</caption><thead><tr><th>Agent</th><th>Role</th><th>Win %</th><th>Open</th><th>Status</th></tr></thead>
        <tbody>{state.seats.length ? state.seats.map((s) => <tr key={s.id}><th scope="row">{s.name}</th><td>{s.role}</td><td>{s.winRatePct.toFixed(1)}</td><td><i className="bar"><em style={{ width: s.loadPct + '%' }} /></i> {s.open}</td><td>{s.tier === 'LIVE_READY' ? 'LIVE READY · REVIEW' : s.status.toUpperCase()}</td></tr>) : <tr><td colSpan="5">No agents loaded yet.</td></tr>}</tbody></table>
      <table><caption>Trade recap · closed paper trades</caption><thead><tr><th>Pair</th><th>Agent</th><th>Entry</th><th>Exit</th><th>% chg</th><th>P&amp;L</th></tr></thead>
        <tbody>{state.tickets.length ? state.tickets.map((t) => <tr key={t.key} className={t.pnl >= 0 ? 'up' : 'down'}><th scope="row">{t.symbol}</th><td>{t.agent}</td><td>{t.entry.toFixed(4)}</td><td>{t.exit.toFixed(4)}</td><td>{(t.pct * 100).toFixed(2)}%</td><td>{money(t.pnl)}</td></tr>) : <tr><td colSpan="6">No closed paper trades yet.</td></tr>}</tbody></table>
    </div>
    <ol className="adl-tape" aria-live="polite" aria-label="Desk log">{state.log.length ? state.log.map((l, i) => <li key={i} className={'k-' + l.kind.toLowerCase()}><time>{l.time}</time><b>{l.kind}</b><span>{l.symbol} · {l.text}</span>{Number.isFinite(l.pnl) && <em className={l.pnl >= 0 ? 'up' : 'down'}>{money(l.pnl)}</em>}</li>) : <li>Waiting for the first evaluation…</li>}</ol>
    <p className="paper-footnote"><ShieldCheck size={13} /> Agent scores come from the deterministic specialist fleet on supplied evidence; agents without data say so instead of guessing. Equity and trades are the virtual paper ledger. Research display only, not an order instruction or a performance claim.</p>
  </section>;
}
