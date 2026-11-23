import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Clock3, RefreshCw, Globe2, BarChart3, Radio } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import { analyzeSessionCandles, formatDuration, getSessionSnapshot, TRADING_SESSIONS } from './session-intelligence.js';

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1d'];
const EXCHANGES = ['binance', 'bitget', 'bybit', 'okx'];

const number = value => value == null || !Number.isFinite(Number(value))
  ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
const percent = value => value == null || !Number.isFinite(Number(value))
  ? '—' : (Number(value) > 0 ? '+' : '') + Number(value).toFixed(2) + '%';

function SessionCard({ session, stats, history }) {
  const data = stats?.today?.[session.id];
  const average = history?.history?.[session.id];
  return <article className={'session-card session-' + session.color + (session.active ? ' is-active' : '')}>
    <div className="session-card-top"><span className="session-orb"><i/></span><span className={'session-state ' + (session.active ? 'open' : '')}>{session.active ? 'LIVE NOW' : session.phase.replace('-', ' ')}</span></div>
    <div className="session-title-row"><h3>{session.name}</h3><span className="session-local-clock">{session.localTime}</span></div>
    <p className="session-hours">{session.open}–{session.close} local time · {session.timezone}</p>
    <div className="session-progress"><i style={{ width: session.progressPercent + '%' }}/></div>
    <div className="session-progress-label"><span>{session.active ? formatDuration(session.elapsedMinutes) + ' elapsed' : 'Opens ' + session.open}</span><span>{session.active ? formatDuration(session.remainingMinutes) + ' left' : session.focus}</span></div>
    <div className="session-stat-grid">
      <div><small>SESSION HIGH</small><b>{number(data?.high)}</b></div>
      <div><small>SESSION LOW</small><b>{number(data?.low)}</b></div>
      <div><small>RANGE</small><b>{number(data?.range)}</b></div>
      <div><small>OPEN → LAST</small><b className={data?.changePercent > 0 ? 'session-up' : data?.changePercent < 0 ? 'session-down' : ''}>{percent(data?.changePercent)}</b></div>
    </div>
    <div className="session-history-line"><span>Prior-session avg range</span><b>{number(average?.averageRange)}</b><span>Samples {average?.observations ?? 0}</span></div>
  </article>;
}

export default function CalendarSessions({ symbol: initialSymbol = 'BTC/USDT', onSymbolChange }) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [exchange, setExchange] = useState('binance');
  const [timeframe, setTimeframe] = useState('1h');
  const requestVersion = useRef(0);
  const [candles, setCandles] = useState([]);
  const [clock, setClock] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => { if (initialSymbol && initialSymbol !== symbol) setSymbol(initialSymbol); }, [initialSymbol]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    const normalized = symbol.trim().toUpperCase();
    if (!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(normalized)) {
      setError('Enter a valid BASE/QUOTE market symbol, for example BTC/USDT.');
      return;
    }
    const requestId = ++requestVersion.current;
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(normalized.replace('/', '-')) + '?timeframe=' + timeframe + '&limit=500', { cache: 'no-store' });
      const data = await response.json();
      if (requestId !== requestVersion.current) return;
      if (!response.ok) throw new Error(data.error || 'Session candle history is unavailable for this exchange and pair.');
      const rows = (data.candles || []).filter(row => Array.isArray(row) && row.length >= 6).map(row => row.map(Number));
      setCandles(rows);
      setLastUpdated(new Date().toISOString());
      if (onSymbolChange) onSymbolChange(normalized);
    } catch (requestError) {
      if (requestId === requestVersion.current) setError(requestError.message || 'Session analysis failed.');
    } finally {
      if (requestId === requestVersion.current) setLoading(false);
    }
  }, [exchange, symbol, timeframe, onSymbolChange]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => { clearInterval(timer); requestVersion.current += 1; };
  }, [load]);

  const snapshot = useMemo(() => getSessionSnapshot(clock), [clock]);
  const sessionDateKey = snapshot.sessions.map(session => session.localDate).join('|');
  const analytics = useMemo(() => analyzeSessionCandles(candles, clock), [candles, sessionDateKey]);
  const activeSessions = snapshot.sessions.filter(session => session.active);
  const overlap = snapshot.londonNewYorkOverlap;
  const marketTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  return <div className="session-workspace">
    <section className="session-hero">
      <div><span className="eyebrow">GLOBAL MARKET HOURS · DST AWARE</span><h2>Trading session intelligence</h2><p>Live session states, market overlaps, session ranges and historical behaviour, calculated from IANA timezone rules.</p></div>
      <div className="session-utc-clock"><small>YOUR DEVICE TIME</small><b>{new Date(clock).toLocaleTimeString()}</b><span>{marketTimezone}</span><small>UTC {new Date(clock).toISOString().slice(11, 19)}</small></div>
    </section>

    <section className="session-overview-grid">
      <article><span><Globe2 size={14}/> ACTIVE SESSIONS</span><b>{activeSessions.length}</b><small>{activeSessions.length ? activeSessions.map(item => item.name).join(' · ') : 'No major session currently open'}</small></article>
      <article><span><Activity size={14}/> SESSION OVERLAP</span><b>{snapshot.overlap ? 'YES' : 'NO'}</b><small>{snapshot.overlapName || 'Single-session or quiet period'}</small></article>
      <article><span><Radio size={14}/> LONDON × NEW YORK</span><b>{overlap ? 'ACTIVE' : 'INACTIVE'}</b><small>Overlap is computed from local DST-aware clocks</small></article>
      <article><span><Clock3 size={14}/> ACTIVE KILLZONES</span><b>{snapshot.killzones.length}</b><small>{snapshot.killzones.join(' · ') || 'No configured killzone active'}</small></article>
    </section>

    <div className="session-section-heading"><div><span className="eyebrow">LIVE SESSION MONITOR</span><h3>Global trading hours</h3></div><span className="session-updated"><i/> CLOCK LIVE · REFRESH 1S</span></div>
    <div className="session-card-grid">{snapshot.sessions.map(session => <SessionCard key={session.id} session={session} stats={analytics} history={analytics}/>)}</div>

    <section className="glass-panel session-market-panel">
      <div className="panel-title"><div><span className="eyebrow">EXCHANGE CANDLE ANALYTICS</span><h3>Session range & performance lab</h3></div><span className="live-tag">{candles.length} CANDLES LOADED</span></div>
      <p className="subtle-note">Session highs, lows, ranges and directional changes are calculated from actual OHLCV candles. Historical averages use up to 20 prior-date samples per session; the observed sample count is shown. Data availability depends on the selected exchange and instrument.</p>
      <div className="session-controls">
        <label>Exchange<select value={exchange} onChange={event => setExchange(event.target.value)}>{EXCHANGES.map(id => <option key={id} value={id}>{id.toUpperCase()}</option>)}</select></label>
        <label>Market<input value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase())} onBlur={() => onSymbolChange?.(symbol.trim().toUpperCase())}/></label>
        <label>Timeframe<select value={timeframe} onChange={event => setTimeframe(event.target.value)}>{TIMEFRAMES.map(frame => <option key={frame} value={frame}>{frame}</option>)}</select></label>
        <button type="button" onClick={load} disabled={loading}><RefreshCw size={14}/>{loading ? 'Loading…' : 'Refresh analysis'}</button>
      </div>
      {error && <p className="quote-error">{error}</p>}
      <div className="scanner-table session-scanner-table">
        <div><span>SESSION</span><span>HIGH</span><span>LOW</span><span>RANGE</span><span>CHANGE</span><span>AVG RANGE</span><span>SAMPLES</span></div>
        {TRADING_SESSIONS.map(session => {
          const today = analytics.today[session.id];
          const historic = analytics.history[session.id];
          return <div key={session.id}><b>{session.name}</b><strong>{number(today?.high)}</strong><span>{number(today?.low)}</span><span>{number(today?.range)}</span><strong className={today?.changePercent >= 0 ? 'up' : 'down'}>{percent(today?.changePercent)}</strong><span>{number(historic.averageRange)}</span><span>{historic.observations}</span></div>;
        })}
      </div>
      <div className="session-history-grid">
        {TRADING_SESSIONS.map(session => <article key={session.id}><h4>{session.name} · recent samples</h4>{analytics.history[session.id].lastSessions.length ? analytics.history[session.id].lastSessions.map(item => <div key={item.date}><span>{item.date}</span><b>{number(item.range)}</b><strong className={item.changePercent >= 0 ? 'up' : 'down'}>{percent(item.changePercent)}</strong></div>) : <p>No completed session samples in the loaded candle window.</p>}</article>)}
      </div>
      <p className="subtle-note">Last successful candle refresh: {lastUpdated ? new Date(lastUpdated).toLocaleString() : 'Awaiting exchange data'}. {analytics.methodology}</p>
    </section>
    <p className="subtle-note">Session hours are local financial-centre hours. Forex session conventions differ between providers; crypto trades continuously, so these are analytical activity windows, not exchange closures. Killzones are predefined research windows, not guaranteed high-probability entries. This module does not place orders.</p>
  </div>;
}
