import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BarChart3, Bell, Camera, CandlestickChart, Check, ChevronDown, CircleCheck, Clock as ClockIcon, Globe2, Landmark, Layers,
  LayoutDashboard, Menu, Newspaper, Pencil, PieChart, Radar, Settings, Settings2, ShieldAlert, ShieldCheck, TrendingUp, TriangleAlert, Wallet, X
} from 'lucide-react';
import TerminalChart from './TerminalChart.jsx';
import { apiFetch } from './lib/api.js';
import {
  buildSessionStrip, compactSymbol, earningsRows, formatCompact, formatDuration, formatPrice, fundingLabel, imbalanceLabel,
  instrumentProfile, journalPerformance, keyInsights, liquidityRanges, macroRows, newsAndSpeakers, sessionAnalyticsRows,
  sizeTicket, splitSymbol, systemStatus, ticketLevels, toPips, upcomingCalendar, utcClock, volatilityRiskView
} from './terminal-dashboard-data.js';
import './TerminalDashboard.css';

/* ------------------------------------------------------------------ utils */
const store = {
  get(key, fallback) { try { const v = window.localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
};
const TIMEFRAMES = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['1d', '1D']];
const SYMBOL_PRESETS = ['EUR/USDT', 'GBP/USDT', 'AUD/USDT', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'DOGE/USDT', 'LINK/USDT'];
const DEFAULT_OVERLAYS = { smc: false, sessions: true, institutional: false, bands: false, liquidity: true };
const FLAGS = { USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', JPY: '🇯🇵', AUD: '🇦🇺', NZD: '🇳🇿', CAD: '🇨🇦', CHF: '🇨🇭', CNY: '🇨🇳' };
const SESSION_COLOR = { sydney: '#9b8cf6', tokyo: '#4a9bf5', london: '#a767ee', 'new-york': '#f0a848' };

async function getJson(path, signal) {
  const response = await apiFetch(path, { cache: 'no-store', signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed (HTTP ' + response.status + ')');
  return data;
}

function usePoll(loader, deps, intervalMs, enabled = true) {
  const [state, setState] = useState({ data: null, error: '', loading: enabled, at: null });
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  useEffect(() => {
    if (!enabled) { setState((s) => ({ ...s, loading: false })); return undefined; }
    let alive = true;
    const controller = new AbortController();
    const run = async () => {
      try {
        const data = await loaderRef.current(controller.signal);
        if (alive) setState({ data, error: '', loading: false, at: Date.now() });
      } catch (error) {
        if (alive && error.name !== 'AbortError') setState((s) => ({ ...s, error: error.message || 'Request failed', loading: false }));
      }
    };
    setState({ data: null, error: '', loading: true, at: null });
    run();
    const timer = intervalMs ? setInterval(run, intervalMs) : null;
    return () => { alive = false; controller.abort(); if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, intervalMs]);
  return state;
}

function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const Dash = () => <span className="td-dash">—</span>;
const val = (v) => (v === null || v === undefined || v === '' ? <Dash/> : v);

function CoinBadge({ code }) {
  const flag = FLAGS[code];
  return <span className={'td-coin' + (flag ? ' flag' : '')} title={code}>{flag || code.slice(0, 2)}</span>;
}

class SectionBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('JPTI classic overview failed:', error); }
  render() { return this.state.error ? <p className="td-note bad" role="alert">The classic overview could not render ({this.state.error.message}). The terminal dashboard above is unaffected.</p> : this.props.children; }
}

/* ---------------------------------------------------------------- header */
function Clock() {
  const now = useNow(1000);
  const c = utcClock(now);
  return <div className="td-clock"><b>{c.time}</b><small>{c.date}</small></div>;
}

function Header({ page, onNavigate, onOpenMenu, online, bellCount, onBell }) {
  const tabs = [
    { label: 'Dashboard', page: 'Overview', icon: LayoutDashboard },
    { label: 'Market Intelligence', page: 'Institutional Market Intelligence', icon: Radar },
    { label: 'Analysis', page: 'Alpha Signal Engine', icon: BarChart3 },
    { label: 'Trading', page: 'Institutional Terminal', icon: CandlestickChart },
    { label: 'Risk', page: 'Risk Management', icon: ShieldAlert },
    { label: 'Portfolio', page: 'Portfolio & Ledger', icon: PieChart },
    { label: 'Settings', page: 'Connection Settings', icon: Settings }
  ];
  return <header className="td-header">
    <div className="td-brand">
      <svg viewBox="0 0 40 40" width="34" height="34" aria-hidden="true"><defs><linearGradient id="tdg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5fb2ff"/><stop offset="1" stopColor="#2d6bff"/></linearGradient></defs>
        <path d="M20 2 36 8v11c0 10-6.6 16.6-16 19C10.6 35.6 4 29 4 19V8z" fill="none" stroke="url(#tdg)" strokeWidth="2.4"/>
        <path d="M13 24l5-6 4 4 6-8" fill="none" stroke="#7fd0ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <div><b>JPTI</b><small>Just Perfect Trading Intelligence</small></div>
    </div>
    <nav className="td-tabs" aria-label="Primary">
      {tabs.map(({ label, page: target, icon: Icon }) => <button key={label} type="button" className={page === target ? 'active' : ''} aria-current={page === target ? 'page' : undefined} onClick={() => onNavigate(target)}><Icon size={15}/>{label}</button>)}
    </nav>
    <div className="td-header-right">
      <span className={'td-live' + (online ? '' : ' off')}><i/>{online ? 'Live' : 'Offline'}</span>
      <Clock/>
      <button type="button" className="td-icon-btn" aria-label={bellCount ? bellCount + ' high-impact events within the hour' : 'Notifications'} title={bellCount ? bellCount + ' high-impact event(s) within the hour' : 'News & events'} onClick={onBell}><Bell size={17}/>{bellCount > 0 && <em>{bellCount}</em>}</button>
      <button type="button" className="td-icon-btn" aria-label="All workspaces" title="All workspaces" onClick={onOpenMenu}><Menu size={18}/></button>
    </div>
  </header>;
}

/* ------------------------------------------------------- sessions strip */
function SessionsStrip({ profile, quote, symbol }) {
  const now = useNow(1000);
  const strip = useMemo(() => buildSessionStrip(now), [now]);
  const { overlap, killzone } = strip;
  const { base, quote: quoteCcy } = splitSymbol(symbol);
  const kz = killzone.active || killzone.next;
  return <section className="td-row td-sessions-row" aria-label="Trading sessions">
    <div className="td-panel td-sessions">
      <div className="td-panel-title"><Globe2 size={14}/><b>Trading Sessions</b><span className="td-livetag"><i/>Live</span></div>
      <div className="td-session-grid">
        {strip.sessions.map((s) => <article key={s.id} className={s.active ? 'active' : ''} style={{ '--c': SESSION_COLOR[s.id] }}>
          <div className="td-session-head"><span className="td-flag">{s.flag}</span><b>{s.name}</b></div>
          <div className="td-session-time">{s.utcLabel.replace(' – ', ' - ')}</div>
          <div className="td-session-bar"><i style={{ width: (s.active ? s.progressPercent : 0) + '%' }}/><span>{s.active ? Math.round(s.progressPercent) + '%' : s.phase === 'pre-open' ? 'Soon' : 'Closed'}</span></div>
        </article>)}
      </div>
    </div>
    <div className={'td-panel td-mini' + (overlap?.active ? ' active' : '')}>
      <div className="td-mini-title">London-New York<br/>Overlap</div>
      <div className="td-rings" aria-hidden="true"><i/><i/></div>
      <div className="td-mini-body">
        <b>{overlap ? overlap.label.replace(' – ', ' - ') : '—'}</b>
        <small className={overlap?.active ? 'good' : ''}>{!overlap ? 'No overlap' : overlap.active ? '(Active · ' + formatDuration(overlap.remainingMinutes) + ' left)' : '(Opens in ' + formatDuration(overlap.startsInMinutes) + ')'}</small>
      </div>
    </div>
    <div className={'td-panel td-mini td-kill' + (killzone.active ? ' active' : '')}>
      <div className="td-mini-title">{killzone.active ? 'Active Killzone' : 'Next Killzone'}</div>
      <div className="td-kill-icon" aria-hidden="true"><svg viewBox="0 0 32 32" width="30" height="30"><circle cx="16" cy="16" r="12" fill="none" stroke="#f0a848" strokeWidth="1.6"/><circle cx="16" cy="16" r="6" fill="none" stroke="#f0a848" strokeWidth="1.6"/><circle cx="16" cy="16" r="1.8" fill="#f0a848"/></svg></div>
      <div className="td-mini-body">
        <b className="td-kill-name">{kz ? kz.name : '—'}</b>
        <small>{kz ? kz.label.replace(' – ', ' - ') + ' UTC' : ''}</small>
        <small className={killzone.active ? 'good' : ''}>{killzone.active ? '(Active · ' + formatDuration(killzone.active.remainingMinutes) + ' left)' : kz ? '(In ' + formatDuration(kz.startsInMinutes) + ')' : ''}</small>
      </div>
    </div>
    <div className="td-panel td-quote">
      <div className="td-quote-top"><span className="td-pair"><CoinBadge code={base}/><CoinBadge code={quoteCcy.replace(/^USDT$|^USDC$/, 'USD')}/></span><b>{compactSymbol(symbol)}</b></div>
      <div className="td-quote-price">{quote.last == null ? <Dash/> : formatPrice(quote.last, profile)}</div>
      <div className={'td-quote-change ' + (Number(quote.change) >= 0 ? 'up' : 'down')}>{quote.change == null ? '' : (quote.change >= 0 ? '+' : '') + formatPrice(quote.change, profile) + ' (' + (quote.pct >= 0 ? '+' : '') + Number(quote.pct).toFixed(2) + '%)'}</div>
    </div>
  </section>;
}

/* ------------------------------------------------------------- left col */
function MarketIntelligence({ context, loading, error, profile, price, ticker }) {
  const [tab, setTab] = useState('overview');
  const ranges = liquidityRanges(context?.liquidity, price);
  const imb = imbalanceLabel(context?.liquidity?.visibleDepth?.imbalancePct);
  const macro = macroRows(context?.macro, context?.calendar || []);
  const pools = (context?.liquidity?.pools || []).slice(0, 6);
  const walls = (context?.liquidity?.visibleDepth?.walls || []).slice(0, 3);
  const range = (r) => (r ? formatPrice(r.low, profile) + (r.high !== r.low ? ' - ' + formatPrice(r.high, profile) : '') : null);
  return <section className="td-panel td-intel" aria-label="Market intelligence">
    <div className="td-panel-title"><Layers size={14}/><b>Market Intelligence</b><span className={'td-livetag' + (context ? '' : ' idle')}><i/>{context ? 'Live' : loading ? 'Loading' : 'Offline'}</span></div>
    <div className="td-subtabs" role="tablist">
      {[['overview', 'Overview'], ['liquidity', 'Liquidity'], ['macro', 'Macro'], ['news', 'News']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {error && !context && <p className="td-note bad" role="alert">{error}</p>}
    {tab === 'overview' && <div className="td-kv-block">
      <div className="td-kv-title">Liquidity Pools</div>
      <div className="td-kv"><span>Buy-Side:</span><b className="down">{val(range(ranges.buySide))}</b></div>
      <div className="td-kv"><span>Sell-Side:</span><b className="up">{val(range(ranges.sellSide))}</b></div>
      <div className="td-kv"><span>Order Book Imbalance</span><b className={imb.tone}>{imb.text}</b></div>
      <div className="td-kv"><span>Funding Rate</span><b>{context && context.market?.fundingRate == null ? <span title="Spot markets have no funding rate">n/a</span> : val(fundingLabel(context?.market?.fundingRate) === '—' ? null : fundingLabel(context?.market?.fundingRate))}</b></div>
      <div className="td-kv"><span>Open Interest</span><b>{context && context.market?.openInterest == null ? <span title="Spot markets have no open interest">n/a</span> : val(formatCompact(context?.market?.openInterest) === '—' ? null : formatCompact(context?.market?.openInterest))}</b></div>
    </div>}
    {tab === 'liquidity' && <div className="td-list">
      {pools.map((p, i) => <div key={i} className="td-list-row"><span className={p.side === 'buy-side' ? 'down' : 'up'}>{p.side === 'buy-side' ? 'Buy-side' : 'Sell-side'}</span><b>{formatPrice(p.level, profile)}</b><small>{p.touches > 1 ? p.touches + ' touches' : 'swing'}{price ? ' · ' + (toPips(Math.abs(p.level - price), profile) ?? 0).toFixed(0) + ' ' + profile.unit : ''}</small></div>)}
      {walls.map((w, i) => <div key={'w' + i} className="td-list-row"><span>{w.side === 'bid' ? 'Bid wall' : 'Ask wall'}</span><b>{formatPrice(w.price, profile)}</b><small>{w.multipleOfMedian}× median depth</small></div>)}
      {!pools.length && !walls.length && <p className="td-note">No confirmed pools or depth walls yet.</p>}
      {context?.liquidity?.limitations?.[0] && <p className="td-foot">{context.liquidity.limitations[0]}</p>}
    </div>}
    {tab === 'macro' && <div className="td-list">
      {macro.rows.map((r) => <div key={r.id} className="td-list-row"><span>{r.label}</span><b>{r.value}</b><small>{r.date || ''}</small></div>)}
      {!macro.configured && <p className="td-note">Macro data needs a FRED key (JPTI_FRED_API_KEY).</p>}
    </div>}
    {tab === 'news' && <div className="td-list">
      {(context?.news || []).slice(0, 5).map((n) => <a key={n.id} className="td-news-link" href={n.url} target="_blank" rel="noreferrer"><b>{n.title}</b><small>{n.domain}</small></a>)}
      {!(context?.news || []).length && <p className="td-note">No headlines returned for this instrument.</p>}
    </div>}
  </section>;
}

function MacroPanel({ context, calendar, onNavigate }) {
  const macro = macroRows(context?.macro, calendar);
  return <section className="td-panel td-macro" aria-label="Macro and central banks">
    <div className="td-panel-title"><Landmark size={14}/><b>Macro &amp; Central Banks</b></div>
    {macro.rows.map((r) => <div className="td-kv" key={r.id}><span>{r.label}</span><b>{r.value === '—' ? <Dash/> : r.value}</b></div>)}
    <div className="td-kv"><span>Next FOMC:</span><b className="td-next">{macro.nextFomc ? macro.nextFomc.label : <Dash/>}</b></div>
    {context && !macro.configured && <button type="button" className="td-link" onClick={() => onNavigate('Financial & On-chain')}>Connect FRED for live macro values →</button>}
  </section>;
}

function CalendarPanel({ events, symbol, sources, error }) {
  const now = useNow(30000);
  const rows = upcomingCalendar(events, symbol, now, 3);
  const feed = (sources || []).find((s) => /forex factory/i.test(s.name || ''));
  return <section className="td-panel td-calendar" aria-label="Economic calendar">
    <div className="td-panel-title"><ClockIcon size={14}/><b>Economic Calendar</b></div>
    {rows.map((r) => <div key={r.id} className={'td-cal-row' + (r.past ? ' past' : '')}>
      <span className="td-cal-time">{r.time}</span><span className="td-cal-flag">{FLAGS[r.currency] || '🌐'}</span><b title={r.title}>{r.title}</b>
      <em className={r.impact}>{r.impact === 'high' ? 'High' : 'Med'}</em></div>)}
    {!rows.length && <p className="td-note">{error ? error : feed && feed.status !== 'live' ? 'Calendar feed unavailable right now.' : 'No high or medium impact events in the next 36 hours.'}</p>}
  </section>;
}

/* ------------------------------------------------------------- right col */
function SessionAnalytics({ rows, profile, ready }) {
  return <section className="td-panel td-analytics" aria-label="Session analytics">
    <div className="td-panel-title"><TrendingUp size={14}/><b>Session Analytics</b></div>
    {rows.map((r) => <div className="td-an-row" key={r.id} style={{ '--c': SESSION_COLOR[r.id] }}>
      <span>{r.name}</span>
      <div className="td-an-bar" role="img" aria-label={r.name + (r.active ? ' ' + r.percent + '% elapsed' : ' closed')}><i style={{ width: r.percent + '%' }}/><b>{r.active ? r.percent + '%' : '—'}</b></div>
      <small>{r.avg == null ? (ready ? 'Avg: —' : '…') : 'Avg: ' + Math.round(r.avg) + ' ' + profile.unit}</small>
    </div>)}
    <p className="td-foot">Averages use up to 20 prior sessions of exchange candles.</p>
  </section>;
}

function VolatilityRisk({ view, profile }) {
  return <section className={'td-panel td-vol tone-' + view.state.tone} aria-label="Volatility risk">
    <div className="td-panel-title"><ShieldCheck size={14}/><b>Volatility Risk</b></div>
    <div className="td-vol-head"><span className="td-vol-icon"><TriangleAlert size={20}/></span><b>{view.state.label}</b></div>
    <div className="td-kv"><span>ATR (14):</span><b>{view.atr == null ? <Dash/> : view.atr.toFixed(profile.digits)}</b></div>
    <div className="td-kv"><span>Spread:</span><b>{view.spreadPips == null ? <Dash/> : view.spreadPips.toFixed(1) + ' ' + profile.unit}</b></div>
    <div className="td-kv"><span>Relative Volume:</span><b>{view.relativeVolume == null ? <Dash/> : view.relativeVolume.toFixed(1) + 'x'}</b></div>
    <div className="td-kv" title={view.nextEvent ? 'Next: ' + view.nextEvent.title : undefined}><span>Event Risk:</span><b className={view.eventRisk === 'High' ? 'down' : view.eventRisk === 'Medium' ? 'warn' : view.eventRisk === 'None' ? 'up' : ''}>{view.eventRisk}</b></div>
  </section>;
}

function TradingControls({ symbol, profile, ticker, atrPips, health, onResult }) {
  const [risk, setRisk] = useState(1);
  const [sl, setSl] = useState(30);
  const [tp, setTp] = useState(100);
  const [touched, setTouched] = useState(false);
  const [side, setSide] = useState(null);
  useEffect(() => { if (touched) return; if (profile.fx) { setSl(30); setTp(100); } else if (atrPips) { const s = Math.max(1, Math.ceil(atrPips * 1.5)); setSl(s); setTp(Math.ceil(s * 3.3)); } }, [symbol, profile.fx, atrPips, touched]);
  const locked = health?.liveTradingEnabled !== true;
  return <section className="td-panel td-controls" aria-label="Trading controls">
    <div className="td-panel-title"><Activity size={14}/><b>Trading Controls</b></div>
    <div className="td-buysell">
      <button type="button" className="buy" onClick={() => setSide('buy')}>Buy</button>
      <button type="button" className="sell" onClick={() => setSide('sell')}>Sell</button>
    </div>
    <label className="td-field"><span>Risk per Trade:</span>
      <select value={risk} onChange={(e) => setRisk(Number(e.target.value))}>{[0.25, 0.5, 1, 2].map((r) => <option key={r} value={r}>{r}%</option>)}</select></label>
    <div className="td-sltp">
      <label><span>SL:</span><input type="number" min="1" step="1" value={sl} onChange={(e) => { setTouched(true); setSl(e.target.value); }}/><small>{profile.unit}</small></label>
      <label><span>TP:</span><input type="number" min="1" step="1" value={tp} onChange={(e) => { setTouched(true); setTp(e.target.value); }}/><small>{profile.unit}</small></label>
    </div>
    <p className="td-foot lock"><ShieldCheck size={11}/> {locked ? 'Live orders locked — tickets run the pre-trade risk gate only.' : 'Live execution is gated server-side; this panel never submits orders.'}</p>
    {side && <TradeTicket side={side} symbol={symbol} profile={profile} ticker={ticker} risk={risk} sl={Number(sl)} tp={Number(tp)} onClose={() => setSide(null)} onResult={onResult}/>}
  </section>;
}

function TradeTicket({ side, symbol, profile, ticker, risk, sl, tp, onClose, onResult }) {
  const { quote } = splitSymbol(symbol);
  const [equity, setEquity] = useState('');
  const [dailyPnl, setDailyPnl] = useState('0');
  const [maxRisk, setMaxRisk] = useState(2);
  const [maxConc, setMaxConc] = useState(100);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const entry = side === 'buy' ? ticker?.ask ?? ticker?.last : ticker?.bid ?? ticker?.last;
  const size = sizeTicket({ equity, riskPercent: risk, stopPips: sl, profile, price: entry });
  const levels = ticketLevels({ side, price: entry, stopPips: sl, targetPips: tp, profile });
  useEffect(() => { ref.current?.querySelector('input')?.focus(); const esc = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc); }, [onClose]);

  const run = async () => {
    setBusy(true); setError(''); setResult(null);
    try {
      const body = {
        account: { equity: Number(equity), currency: quote, dailyPnl: Number(dailyPnl), exposures: [] },
        order: { symbol, side, quantity: size.quantity, referencePrice: entry, stopPrice: levels.stop, quoteTimestamp: ticker?.timestamp ? new Date(ticker.timestamp).toISOString() : null },
        limits: { maxOrderNotional: Number(equity) * Math.max(1, Number(maxConc) / 100), maxGrossExposure: Number(equity) * Math.max(1, Number(maxConc) / 100), maxRiskPercent: Number(maxRisk), maxSymbolConcentrationPercent: Number(maxConc), maxDailyLoss: Number(equity) * 0.05, maxQuoteAgeMs: 15000 }
      };
      const response = await apiFetch('/api/risk/preflight', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 401 ? 'The pre-trade gate needs your JPTI API token — add it in Connection Settings.' : data.error || 'Pre-trade check failed.');
      setResult(data); onResult?.(data);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return <div className="td-modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <div className="td-modal" role="dialog" aria-modal="true" aria-label={'Pre-trade ticket ' + side} ref={ref}>
      <div className="td-modal-head"><b className={side === 'buy' ? 'up' : 'down'}>{side.toUpperCase()} {compactSymbol(symbol)}</b><button type="button" className="td-icon-btn" aria-label="Close" onClick={onClose}><X size={16}/></button></div>
      <p className="td-foot">Pre-trade risk check only. No order is placed, reserved or authorised from this window.</p>
      <div className="td-ticket-grid">
        <label><span>Account equity ({quote})</span><input type="number" min="0" inputMode="decimal" value={equity} onChange={(e) => setEquity(e.target.value)} placeholder="e.g. 10000"/></label>
        <label><span>Realized PnL today</span><input type="number" inputMode="decimal" value={dailyPnl} onChange={(e) => setDailyPnl(e.target.value)}/></label>
        <label><span>Max risk % of equity</span><input type="number" min="0.1" step="0.1" value={maxRisk} onChange={(e) => setMaxRisk(e.target.value)}/></label>
        <label><span>Max concentration %</span><input type="number" min="1" step="1" value={maxConc} onChange={(e) => setMaxConc(e.target.value)}/></label>
      </div>
      <div className="td-ticket-sum">
        <div><span>Entry (ref.)</span><b>{formatPrice(entry, profile)}</b></div>
        <div><span>Stop ({sl} {profile.unit})</span><b>{levels ? formatPrice(levels.stop, profile) : '—'}</b></div>
        <div><span>Target ({tp} {profile.unit})</span><b>{levels ? formatPrice(levels.target, profile) : '—'}</b></div>
        <div><span>Reward : Risk</span><b>{levels?.rewardRisk ? levels.rewardRisk.toFixed(2) + ' : 1' : '—'}</b></div>
        <div><span>Risk amount</span><b>{size ? size.riskAmount.toFixed(2) + ' ' + quote : '—'}</b></div>
        <div><span>Position size</span><b>{size ? size.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}</b></div>
      </div>
      <button type="button" className="td-run" disabled={busy || !size || !levels} onClick={run}>{busy ? 'Checking…' : 'Run pre-trade check'}</button>
      {!size && <p className="td-note">Enter account equity to size the position.</p>}
      {error && <p className="td-note bad" role="alert">{error}</p>}
      {result && <div className="td-checks" role="status">
        <div className={'td-decision ' + (result.decision === 'blocked' ? 'bad' : 'ok')}>{result.decision === 'blocked' ? 'Blocked by pre-trade gate' : 'Eligible for paper intent'}<small>Live execution authorised: no · orders created: {result.permissions?.ordersCreated ?? 0}</small></div>
        {result.checks.map((c) => <div key={c.id} className={'td-check ' + (c.passed ? 'pass' : 'fail')}>{c.passed ? <Check size={13}/> : <X size={13}/>}<span><b>{c.id.replaceAll('_', ' ')}</b><small>{c.detail}</small></span></div>)}
      </div>}
    </div>
  </div>;
}

/* ---------------------------------------------------------------- bottom */
function Insights({ items }) {
  return <section className="td-panel td-insights" aria-label="Key insights">
    <div className="td-panel-title"><Activity size={14}/><b>Key Insights</b></div>
    <ul>{items.map((i, n) => <li key={n} className={i.tone}><i/>{i.text}</li>)}{!items.length && <li className="idle"><i/>Waiting for market data…</li>}</ul>
  </section>;
}

function Earnings() {
  const [list, setList] = useState(() => store.get('jpti.terminal.earnings', ['AAPL', 'MSFT', 'GOOGL']));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const state = usePoll(async (signal) => {
    const results = await Promise.all(list.map(async (symbol) => {
      try { const d = await getJson('/api/institutional/earnings?symbol=' + encodeURIComponent(symbol), signal); return { symbol, events: d.events || [], status: d.sources?.[0]?.status }; }
      catch { return { symbol, events: [], status: 'unavailable' }; }
    }));
    return results;
  }, [list.join(',')], 600000);
  const rows = earningsRows(state.data || []);
  const status = (state.data || [])[0]?.status;
  const save = () => { const next = draft.toUpperCase().split(/[\s,]+/).filter((s) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(s)).slice(0, 6); if (next.length) { setList(next); store.set('jpti.terminal.earnings', next); } setEditing(false); };
  return <section className="td-panel td-earnings" aria-label="Earnings calendar">
    <div className="td-panel-title"><BarChart3 size={14}/><b>Earnings Calendar</b><button type="button" className="td-icon-btn sm" aria-label="Edit earnings watchlist" onClick={() => { setDraft(list.join(', ')); setEditing((v) => !v); }}><Pencil size={12}/></button></div>
    {editing && <div className="td-inline-edit"><input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} aria-label="Tickers separated by commas"/><button type="button" onClick={save}>Save</button></div>}
    {rows.map((r) => <div className="td-earn-row" key={r.symbol}><b>{r.symbol}</b><span>{r.date}</span><em>{r.timing}</em></div>)}
    {!rows.length && <p className="td-note">{state.loading ? 'Loading…' : status === 'not-configured' ? 'Needs a Finnhub key (JPTI_FINNHUB_API_KEY).' : 'No upcoming earnings found for the watchlist.'}</p>}
  </section>;
}

function NewsSpeakers({ items, loading }) {
  return <section className="td-panel td-news" aria-label="News and speakers">
    <div className="td-panel-title"><Newspaper size={14}/><b>News &amp; Speakers</b></div>
    {items.map((n) => <a key={n.id} className="td-news-row" href={n.url || undefined} target="_blank" rel="noreferrer"><span className={'td-news-dot ' + n.kind}/><b title={n.title}>{n.title}</b><small>{n.ago}</small></a>)}
    {!items.length && <p className="td-note">{loading ? 'Loading…' : 'No recent headlines or central-bank speeches.'}</p>}
  </section>;
}

function Performance({ perf, loading, unavailable }) {
  return <section className="td-panel td-perf" aria-label="JPTI performance">
    <div className="td-panel-title"><Activity size={14}/><b>JPTI Performance</b></div>
    <div className="td-perf-grid">
      <div><b className="up">{perf.winRate == null ? '—' : perf.winRate.toFixed(1) + '%'}</b><span>Win Rate</span></div>
      <div><b>{perf.profitFactor == null ? '—' : perf.profitFactor.toFixed(2)}</b><span>Profit Factor</span></div>
      <div><b className="down">{perf.maxDrawdownR == null ? '—' : perf.maxDrawdownR.toFixed(1) + 'R'}</b><span>Max Drawdown</span></div>
    </div>
    <p className="td-foot">{perf.trades ? 'From ' + perf.trades + ' journaled trade' + (perf.trades === 1 ? '' : 's') + ' (R-multiples).' : unavailable ? 'Session journal unavailable.' : loading ? 'Loading…' : 'No journaled outcomes yet — record them in Spot & Markets → session memory.'}</p>
  </section>;
}

function StatusBar({ status, lastUpdate }) {
  const c = lastUpdate ? utcClock(lastUpdate).time.replace(' UTC', '') : null;
  return <section className={'td-panel td-status tone-' + status.tone} role="status" aria-live="polite">
    <CircleCheck size={22}/><div><b>{status.label}</b><small>Last Update: {c ? c + ' UTC' : 'pending'}</small>{status.tone !== 'ok' && <small className="detail">{status.detail}</small>}</div>
  </section>;
}

/* -------------------------------------------------------------- the page */
export default function TerminalDashboard({ page, onNavigate, onOpenMenu, onSymbolChange, health, operations, loadError, lastRefresh, children }) {
  const [exchange, setExchangeState] = useState(() => store.get('jpti.terminal.exchange', 'binance'));
  const [symbol, setSymbolState] = useState(() => store.get('jpti.terminal.symbol', 'EUR/USDT'));
  const [timeframe, setTimeframeState] = useState(() => store.get('jpti.terminal.timeframe', '15m'));
  const [marketType, setMarketTypeState] = useState(() => store.get('jpti.terminal.marketType', 'spot'));
  const [marketSide, setMarketSide] = useState(() => store.get('jpti.terminal.marketSide', 'buy'));
  const [overlays, setOverlays] = useState(() => ({ ...DEFAULT_OVERLAYS, ...store.get('jpti.terminal.overlays', {}) }));
  const [live, setLive] = useState(true);
  const [classicOpen, setClassicOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const [symbolDraft, setSymbolDraft] = useState(symbol);
  const svgRef = useRef(null);
  const setExchange = (v) => { setExchangeState(v); store.set('jpti.terminal.exchange', v); if (v !== 'bitget' && marketType !== 'spot') setMarketType('spot'); };
  const setTimeframe = (v) => { setTimeframeState(v); store.set('jpti.terminal.timeframe', v); };
  const setMarketType = (v) => { setMarketTypeState(v); store.set('jpti.terminal.marketType', v); };
  useEffect(() => { if (exchange !== 'bitget' && marketType !== 'spot') setMarketType('spot'); }, [exchange, marketType]);
  const setSymbol = useCallback((raw) => {
    const input = String(raw || '').trim().toUpperCase();
    const next = marketType === 'cfd' ? input : input.replace('-', '/');
    const valid = marketType === 'cfd'
      ? /^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(next)
      : /^[A-Z0-9._]{2,20}\/[A-Z0-9._]{2,20}(?::[A-Z0-9._]{2,20})?$/.test(next);
    if (!valid) return false;
    setSymbolState(next); setSymbolDraft(next); store.set('jpti.terminal.symbol', next); onSymbolChange?.(next); return true;
  }, [onSymbolChange, marketType]);
  const toggleOverlay = (key) => setOverlays((o) => { const next = { ...o, [key]: !o[key] }; store.set('jpti.terminal.overlays', next); return next; });

  const pair = encodeURIComponent(symbol.replace('/', '-'));
  const exchanges = usePoll((s) => getJson('/api/exchanges', s), [], 0);
  const marketCatalog = usePoll((s) => getJson('/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(marketType), s), [exchange, marketType], 300000, live);
  const selectedMarket = (marketCatalog.data?.markets || []).find((market) => market.symbol === symbol);
  const instrumentQuery = selectedMarket?.id ? '&instrumentId=' + encodeURIComponent(selectedMarket.id) : '';
  const sideQuery = marketType === 'cfd' ? '&side=' + encodeURIComponent(marketSide) : '';
  const candlesState = usePoll((s) => getJson('/api/exchanges/' + exchange + '/ohlcv/' + pair + '?timeframe=' + timeframe + '&limit=300&type=' + encodeURIComponent(marketType) + instrumentQuery + sideQuery, s), [exchange, pair, timeframe, marketType, instrumentQuery, sideQuery], 20000, live);
  const tickerState = usePoll((s) => getJson('/api/exchanges/' + exchange + '/ticker/' + pair + '?type=' + encodeURIComponent(marketType) + instrumentQuery, s), [exchange, pair, marketType, instrumentQuery], 10000, live);
  const contextState = usePoll((s) => getJson('/api/institutional/context/' + exchange + '/' + pair + '?timeframe=' + timeframe + '&type=' + encodeURIComponent(marketType), s), [exchange, pair, timeframe, marketType], 60000, live);
  const historyState = usePoll((s) => getJson('/api/exchanges/' + exchange + '/ohlcv/' + pair + '?timeframe=1h&limit=500&type=' + encodeURIComponent(marketType) + instrumentQuery + sideQuery, s), [exchange, pair, marketType, instrumentQuery, sideQuery], 300000, live);
  const calendarState = usePoll((s) => getJson('/api/institutional/calendar?symbol=' + encodeURIComponent(compactSymbol(symbol)), s), [symbol], 120000, live);
  const journalState = usePoll((s) => getJson('/api/session/memory', s), [], 60000, live);

  const candles = candlesState.data?.candles || [];
  const ticker = tickerState.data;
  const context = contextState.data;
  const last = candles.at(-1)?.[4];
  const price = ticker?.last ?? last ?? null;
  const profile = useMemo(() => instrumentProfile(symbol, price), [symbol, price]);

  const quote = useMemo(() => {
    const pct = ticker?.percentage;
    const change = ticker?.last != null && pct != null && pct > -100 ? ticker.last - ticker.last / (1 + pct / 100) : null;
    return { last: ticker?.last ?? null, pct: pct ?? null, change };
  }, [ticker]);

  const tick = useNow(15000);
  const strip = useMemo(() => buildSessionStrip(tick), [tick]);
  const calendarEvents = calendarState.data?.events || context?.calendar || [];
  const calendarSources = calendarState.data?.sources || context?.sources || [];
  const vol = useMemo(() => volatilityRiskView({ eventRisk: context?.eventRisk, ticker, candles, profile, sources: context?.sources || calendarSources }), [context, ticker, candles, profile, calendarSources]);
  const analytics = useMemo(() => sessionAnalyticsRows(historyState.data?.candles || candles, tick, profile), [historyState.data, candles, tick, profile]);
  const insights = useMemo(() => keyInsights({ strip, context, price, profile, symbol }), [strip, context, price, profile, symbol]);
  const feed = useMemo(() => newsAndSpeakers({ news: context?.news || [], calendar: calendarEvents }, tick, 3), [context, calendarEvents, tick]);
  const perf = useMemo(() => journalPerformance(journalState.data?.records || []), [journalState.data]);
  const status = systemStatus({ health, operations, loadError });
  const bell = useMemo(() => upcomingCalendar(calendarEvents, symbol, tick, 20).filter((e) => e.impact === 'high' && !e.past && Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3)) - (new Date(tick).getUTCHours() * 60 + new Date(tick).getUTCMinutes()) <= 60).length, [calendarEvents, symbol, tick]);

  const exportPng = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = svg.clientWidth * 2; canvas.height = svg.clientHeight * 2;
      const ctx = canvas.getContext('2d'); ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => { if (!blob) return; const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = compactSymbol(symbol) + '-' + timeframe + '-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') + '.png'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); });
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };

  useEffect(() => { if (!menu) return undefined; const close = (e) => { if (!e.target.closest?.('.td-menu-wrap')) setMenu(null); }; const esc = (e) => e.key === 'Escape' && setMenu(null); window.addEventListener('mousedown', close); window.addEventListener('keydown', esc); return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); }; }, [menu]);

  const online = Boolean(health) && !loadError;
  const exchangeList = exchanges.data?.exchanges?.length ? exchanges.data.exchanges : [{ id: 'binance', name: 'Binance' }];
  const catalogSymbols = (marketCatalog.data?.markets || []).map((market) => market.symbol).filter(Boolean);
  const symbolOptions = [...new Set([symbol, ...catalogSymbols, ...(marketType === 'cfd' ? [] : SYMBOL_PRESETS)])];
  useEffect(() => {
    const markets = marketCatalog.data?.markets || [];
    if (markets.length && !markets.some((market) => market.symbol === symbol)) setSymbol(markets[0].symbol);
  }, [marketCatalog.data, symbol, setSymbol]);
  useEffect(() => {
    const frames = marketCatalog.data?.timeframes || [];
    if (frames.length && !frames.includes(timeframe)) setTimeframe(frames.includes('1h') ? '1h' : frames[0]);
  }, [marketCatalog.data, timeframe]);

  return <div className="td-root">
    <Header page={page} onNavigate={onNavigate} onOpenMenu={onOpenMenu} online={online} bellCount={bell} onBell={() => onNavigate('News & Events')}/>
    <div className="td-body">
      <SessionsStrip profile={profile} quote={quote} symbol={symbol}/>
      <div className="td-main">
        <div className="td-col td-left">
          <MarketIntelligence context={context} loading={contextState.loading} error={contextState.error} profile={profile} price={price} ticker={ticker}/>
          <MacroPanel context={context} calendar={calendarEvents} onNavigate={onNavigate}/>
          <CalendarPanel events={calendarEvents} symbol={symbol} sources={calendarSources} error={calendarState.error}/>
        </div>
        <section className="td-panel td-chart-panel" aria-label="Market chart">
          <div className="td-toolbar">
            <form className="td-symbol" onSubmit={(e) => { e.preventDefault(); if (!setSymbol(symbolDraft)) setSymbolDraft(symbol); }}>
              <input list="td-symbols" value={symbolDraft} onChange={(e) => setSymbolDraft(e.target.value)} onBlur={() => { if (!setSymbol(symbolDraft)) setSymbolDraft(symbol); }} aria-label="Market symbol" spellCheck="false"/>
              <datalist id="td-symbols">{symbolOptions.map((s) => <option key={s} value={s}/>)}</datalist><ChevronDown size={13}/>
            </form>
            <label className="td-market-product"><span>Product</span><select aria-label="Market product" value={marketType} onChange={(e) => setMarketType(e.target.value)}><option value="spot">Spot</option><option value="margin" disabled={exchange !== 'bitget'}>Margin</option><option value="futures" disabled={exchange !== 'bitget'}>USDT-M Futures</option><option value="coin-futures" disabled={exchange !== 'bitget'}>Coin-M Futures</option><option value="usdc-futures" disabled={exchange !== 'bitget'}>USDC-M Futures</option><option value="cfd" disabled={exchange !== 'bitget'}>CFD · UTA read-only key required</option></select></label>
            {marketType === 'cfd' && <label className="td-market-product"><span>CFD side</span><select aria-label="CFD candle side" value={marketSide} onChange={(e) => { setMarketSide(e.target.value); store.set('jpti.terminal.marketSide', e.target.value); }}><option value="buy">Buy / Ask</option><option value="sell">Sell / Bid</option></select></label>}
            <span className="td-tf-current" aria-hidden="true">{timeframe.replace(/m$/, '')}</span>
            <div className="td-tfs" role="group" aria-label="Timeframe">{TIMEFRAMES.filter(([v]) => exchange !== 'bitget' || (marketCatalog.data?.timeframes || (marketType === 'cfd' ? ['1m','15m','1h','4h','1d'] : ['1m','3m','5m','15m','30m','1h','4h','6h','12h','1d'])).includes(v)).map(([v, label]) => <button key={v} type="button" className={timeframe === v ? 'active' : ''} aria-pressed={timeframe === v} onClick={() => setTimeframe(v)}>{label}</button>)}</div>
            <div className="td-menu-wrap">
              <button type="button" className="td-ghost" aria-expanded={menu === 'ind'} onClick={() => setMenu(menu === 'ind' ? null : 'ind')}>Indicators <ChevronDown size={12}/></button>
              {menu === 'ind' && <div className="td-menu" role="menu">{[['sessions', 'Sessions'], ['institutional', 'Institutional Liquidity'], ['bands', 'Volatility Bands'], ['liquidity', 'Liquidity Pools']].map(([k, label]) => <label key={k}><input type="checkbox" checked={overlays[k]} onChange={() => toggleOverlay(k)}/>{label}</label>)}</div>}
            </div>
            <div className="td-toolbar-right">
              <button type="button" className="td-icon-btn" aria-label="Save chart image" title="Save chart as PNG" onClick={exportPng}><Camera size={15}/></button>
              <div className="td-menu-wrap">
                <button type="button" className="td-icon-btn" aria-label="Chart settings" aria-expanded={menu === 'set'} title="Chart settings" onClick={() => setMenu(menu === 'set' ? null : 'set')}><Settings2 size={15}/></button>
                {menu === 'set' && <div className="td-menu right" role="menu"><label className="col"><span>Exchange</span><select value={exchange} onChange={(e) => setExchange(e.target.value)}>{exchangeList.map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}</select></label>
                  <p className="td-foot">Candles, ticker and market pairs follow the selected exchange and product. Bitget supports Spot, Margin, USDT-M, Coin-M and USDC-M public markets. CFD charts use the authenticated Cloudflare UTA read-only feed; CFD candle history is side-specific and does not include traded volume.</p></div>}
              </div>
              <button type="button" className={'td-realtime' + (live ? '' : ' paused')} aria-pressed={live} onClick={() => setLive((v) => !v)} title={live ? 'Click to pause auto-refresh' : 'Click to resume auto-refresh'}><i/>{live ? 'Real-Time' : 'Paused'}</button>
            </div>
          </div>
          <div className="td-chart-area">
            <TerminalChart exchange={exchange} marketType={marketType} symbol={symbol} timeframe={timeframe} candles={candles} profile={profile} context={context} strip={strip}
              loading={candlesState.loading} error={candlesState.error} svgRef={svgRef} overlays={overlays} onOverlayChange={toggleOverlay}/>
          </div>
        </section>
        <div className="td-col td-right">
          <SessionAnalytics rows={analytics} profile={profile} ready={Boolean(historyState.data)}/>
          <VolatilityRisk view={vol} profile={profile}/>
          <TradingControls symbol={symbol} profile={profile} ticker={ticker} atrPips={vol.atrPips} health={health}/>
        </div>
      </div>
      <div className="td-bottom">
        <Insights items={insights}/>
        <Earnings/>
        <NewsSpeakers items={feed} loading={contextState.loading}/>
        <Performance perf={perf} loading={journalState.loading} unavailable={Boolean(journalState.error)}/>
        <StatusBar status={status} lastUpdate={lastRefresh ? Date.parse(lastRefresh) : null}/>
      </div>
      {children && <details className="td-classic" onToggle={(e) => setClassicOpen(e.currentTarget.open)}><summary><Wallet size={14}/> Classic overview, provider consensus &amp; scanners</summary><div className="td-classic-body">{classicOpen ? <SectionBoundary>{children}</SectionBoundary> : null}</div></details>}
      <footer className="td-footer"><span>© 2026 JOPEARL TRADING INTELLIGENCE</span><span>MARKET DATA IS NOT A TRADE RECOMMENDATION</span><span>LIVE EXECUTION LOCKED BY DEFAULT</span></footer>
    </div>
  </div>;
}
