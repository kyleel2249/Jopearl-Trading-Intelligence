import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ExchangeConnectivity from './ExchangeConnectivity.jsx';
import { apiFetch, getApiSource, subscribeApiSource } from './lib/api.js';
import { getSessionSnapshot, analyzeSessionCandles } from './session-intelligence.js';
import { detectSessionLiquiditySweeps } from './session-trading-intelligence.js';
import {
  Activity, BarChart3, CalendarDays, CircleAlert, Crosshair, Globe2, Layers3, LayoutDashboard, Newspaper,
  RefreshCw, Settings2, ShieldCheck, TrendingUp, Wallet, Zap
} from 'lucide-react';
import {
  MACRO_SERIES, atrRatio, averageTrueRange, chartLevelsFromPools, cleanCandles, eventRisk, formatPrice, liquidityPools,
  macroReading, nextMatchingEvent, performanceSummary, priceChange, relativeVolume, sessionRangeRows, spreadPercent, systemsStatus,
  timeAgo, toNumber, tradePlan, upcomingEvents, utcClock, volatilityRisk
} from './dashboard-data.js';
import './DashboardPro.css';

const NO_LEVELS = [];
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 });

const NAV_TABS = [
  { label: 'Dashboard', page: 'Overview', icon: LayoutDashboard },
  { label: 'Market Intelligence', page: 'Institutional Market Intelligence', icon: Layers3 },
  { label: 'Analysis', page: 'AI Intelligence', icon: TrendingUp },
  { label: 'Trading', page: 'Spot & Markets', icon: BarChart3 },
  { label: 'Risk', page: 'Risk Management', icon: ShieldCheck },
  { label: 'Portfolio', page: 'Portfolio & Ledger', icon: Wallet },
  { label: 'Settings', page: 'Connection Settings', icon: Settings2 }
];

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(timer); }, [intervalMs]);
  return now;
}

// Polls a JSON endpoint. Failures surface as a readable message and never as fabricated data.
function useApi(path, { intervalMs = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: '', loading: Boolean(path && enabled) });
  useEffect(() => {
    if (!path || !enabled) { setState({ data: null, error: '', loading: false }); return undefined; }
    let active = true;
    const run = async () => {
      try {
        const response = await apiFetch(path, { cache: 'no-store' });
        const data = await response.json().catch(() => null);
        if (!active) return;
        if (!response.ok) setState({ data: null, error: (data && data.error) || 'Request failed (' + response.status + ')', loading: false });
        else setState({ data, error: '', loading: false });
      } catch (error) {
        if (active) setState({ data: null, error: error.message || 'Request failed', loading: false });
      }
    };
    run();
    const timer = intervalMs > 0 ? setInterval(run, intervalMs) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [path, enabled, intervalMs]);
  return state;
}

function Flag({ id }) {
  const common = { width: 22, height: 15, viewBox: '0 0 22 15', className: 'dp-flag', 'aria-hidden': true };
  if (id === 'tokyo') return <svg {...common}><rect width="22" height="15" fill="#fff"/><circle cx="11" cy="7.5" r="4.2" fill="#bc002d"/></svg>;
  if (id === 'new-york') return <svg {...common}><rect width="22" height="15" fill="#fff"/>{[0, 2, 4, 6, 8, 10, 12].map(i => <rect key={i} y={i * 15 / 13} width="22" height={15 / 13} fill="#b22234"/>)}<rect width="10" height="8" fill="#3c3b6e"/></svg>;
  if (id === 'london') return <svg {...common}><rect width="22" height="15" fill="#012169"/><path d="M0 0L22 15M22 0L0 15" stroke="#fff" strokeWidth="3"/><path d="M0 0L22 15M22 0L0 15" stroke="#c8102e" strokeWidth="1"/><path d="M11 0V15M0 7.5H22" stroke="#fff" strokeWidth="5"/><path d="M11 0V15M0 7.5H22" stroke="#c8102e" strokeWidth="3"/></svg>;
  return <svg {...common}><rect width="22" height="15" fill="#012169"/><path d="M0 0L11 7.5M11 0L0 7.5" stroke="#fff" strokeWidth="1.6"/><path d="M5.5 0V7.5M0 3.75H11" stroke="#fff" strokeWidth="2.4"/><path d="M5.5 0V7.5M0 3.75H11" stroke="#c8102e" strokeWidth="1.2"/>{[[16.5, 3], [16.5, 11.5], [12.5, 7.5], [20, 7], [16.5, 7.7]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="0.9" fill="#fff"/>)}</svg>;
}

function Panel({ title, icon: Icon, action, children, className = '', label }) {
  return <section className={'dp-panel ' + className} aria-label={label || title}>
    <div className="dp-panel-head"><span>{Icon && <Icon size={14} aria-hidden="true"/>}<b>{title}</b></span>{action}</div>
    {children}
  </section>;
}

function Row({ label, value, tone, hint }) {
  return <div className="dp-row" title={hint || undefined}><span>{label}</span><b className={tone ? 'dp-' + tone : undefined}>{value}</b></div>;
}

function TopBar({ activeNav, now, live, direct, refresh, navigation }) {
  const clock = utcClock(now);
  return <div className="dp-topbar">
    <div className="dp-brand">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="7" fill="#12305c"/><path d="M8 20V12M15 22V8M22 18V11" stroke="#3b9cff" strokeWidth="2.6" strokeLinecap="round"/></svg>
      <span><b>JPTI</b><small>Just Perfect Trading Intelligence</small></span>
    </div>
    <nav className="dp-tabs" aria-label="Primary sections">{NAV_TABS.map(tab => {
      const Icon = tab.icon;
      return <button type="button" key={tab.label} className={'dp-tab' + (tab.page === 'Overview' ? ' on' : '')} aria-current={tab.page === 'Overview' ? 'page' : undefined} onClick={() => tab.page !== 'Overview' && activeNav(tab.page)}><Icon size={14} aria-hidden="true"/>{tab.label}</button>;
    })}</nav>
    <div className="dp-top-right">
      {Array.isArray(navigation) && navigation.length > 0 && <label className="dp-allnav"><span className="dp-sr">All sections</span>
        <select aria-label="Go to any section" value="" onChange={e => { if (e.target.value) activeNav(e.target.value); }}>
          <option value="">All sections…</option>
          {[...new Set(navigation.map(n => n.group))].map(group => <optgroup key={group} label={group}>{navigation.filter(n => n.group === group).map(n => <option key={n.label} value={n.label}>{n.label}</option>)}</optgroup>)}
        </select></label>}
      <span className={'dp-live-chip ' + (direct ? 'warn' : live ? 'good' : 'bad')} title={direct ? 'JPTI API unreachable: showing public exchange data directly from your browser. Ledger, trading and analytics need the API.' : undefined}><i/>{direct ? 'Direct data' : live ? 'Live' : 'Offline'}</span>
      {typeof refresh === 'function' && <button type="button" className="dp-icon-btn" onClick={refresh} title="Refresh system data" aria-label="Refresh system data"><RefreshCw size={14} aria-hidden="true"/></button>}
      <span className="dp-user" title="Local operator"><i>JP</i>Operator</span>
      <span className="dp-clock"><b>{clock.time}</b><small>{clock.date}</small></span>
    </div>
  </div>;
}

function SessionStrip({ snapshot, symbol, ticker }) {
  const last = toNumber(ticker.data?.last);
  const pct = toNumber(ticker.data?.percentage);
  const change = priceChange(ticker.data || {});
  const up = (pct ?? 0) >= 0;
  return <div className="dp-sessions">
    <Panel title="Trading Sessions" icon={Globe2} className="dp-session-panel" action={<span className="dp-live-chip good"><i/>Live</span>}>
      <div className="dp-session-cards">{snapshot.sessions.map(session => <article key={session.id} className={'dp-session' + (session.active ? ' active' : '')}>
        <div className="dp-session-top"><Flag id={session.id}/><b>{session.name}</b></div>
        <div className="dp-session-mid"><span>{session.open} – {session.close}</span><strong>{session.active ? Math.round(session.progressPercent) + '%' : session.phase.replace('-', ' ')}</strong></div>
        <div className="dp-bar" role="progressbar" aria-label={session.name + ' session progress'} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(session.progressPercent)}><i style={{ width: session.progressPercent + '%' }}/></div>
        <small>{session.localTime} local</small>
      </article>)}</div>
    </Panel>
    <Panel title={snapshot.londonNewYorkOverlap ? 'London–New York Overlap' : 'Session Overlap'} className="dp-center-card">
      <svg className="dp-overlap-mark" width="46" height="30" viewBox="0 0 46 30" aria-hidden="true"><circle cx="16" cy="15" r="11" fill="none" stroke="#35d07f" strokeWidth="2.4"/><circle cx="30" cy="15" r="11" fill="none" stroke="#35d07f" strokeWidth="2.4"/></svg>
      <strong className={snapshot.overlap ? 'dp-good' : 'dp-muted'}>{snapshot.overlap ? snapshot.overlapName : 'None active'}</strong>
      <small>{snapshot.overlap ? 'Overlapping sessions open' : 'Single or no session open'}</small>
    </Panel>
    <Panel title="Active Killzone" icon={Crosshair} className="dp-center-card">
      <strong className={snapshot.killzones.length ? 'dp-warn' : 'dp-muted'}>{snapshot.killzones.length ? snapshot.killzones.join(' · ') + ' Open' : 'None active'}</strong>
      <small>First 3 hours of the session (heuristic window)</small>
    </Panel>
    <Panel title={symbol} className="dp-ticker-card" label="Selected market ticker">
      <strong className="dp-price">{last == null ? '—' : formatPrice(last)}</strong>
      <span className={up ? 'dp-good' : 'dp-bad'}>{change != null ? (change >= 0 ? '+' : '') + formatPrice(change) + ' ' : ''}{pct == null ? (ticker.error ? 'Feed unavailable' : '') : '(' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)'}</span>
    </Panel>
  </div>;
}

function MarketIntelPanel({ symbol, pools, orderbook, derivs, calendarEvents, now, news, watchlist, activeNav }) {
  const [tab, setTab] = useState('overview');
  const tabs = [['overview', 'Overview'], ['liquidity', 'Liquidity'], ['macro', 'Macro'], ['news', 'News']];
  const imbalance = toNumber(orderbook.data?.depthImbalance);
  const funding = toNumber(derivs.data?.funding?.fundingRate);
  const oi = toNumber(derivs.data?.openInterest?.openInterestValue) ?? toNumber(derivs.data?.openInterest?.openInterestAmount);
  const zone = side => !side ? '—' : (side.low === side.high ? formatPrice(side.price) : formatPrice(side.low) + ' – ' + formatPrice(side.high));
  const walls = Array.isArray(orderbook.data?.liquidityWalls) ? orderbook.data.liquidityWalls.slice(0, 6) : [];
  const events = upcomingEvents(calendarEvents, now, { limit: 5 });
  const articles = Array.isArray(news.data?.articles) ? news.data.articles.slice(0, 4) : [];
  const noDerivs = 'No funding / open-interest data for this market (spot markets have none).';
  return <Panel title="Market Intelligence" icon={Layers3} className="dp-intel" action={<span className="dp-live-chip good"><i/>Live</span>}>
    <div className="dp-subtabs" role="tablist" aria-label="Market intelligence views">{tabs.map(([id, label]) => <button type="button" role="tab" key={id} aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === 'overview' && <div className="dp-tabpane" role="tabpanel">
      <h4>Liquidity Pools</h4>
      <Row label="Buy-Side" tone="bad" value={zone(pools.buySide)} hint={pools.buySide ? pools.buySide.touches + ' equal-high touch(es) in the last ' + pools.lookback + ' bars (candle-derived)' : 'Needs 10+ candles'}/>
      <Row label="Sell-Side" tone="good" value={zone(pools.sellSide)} hint={pools.sellSide ? pools.sellSide.touches + ' equal-low touch(es) in the last ' + pools.lookback + ' bars (candle-derived)' : 'Needs 10+ candles'}/>
      <Row label="Order Book Imbalance" tone={imbalance == null ? undefined : imbalance >= 0 ? 'good' : 'bad'} value={imbalance == null ? '—' : (imbalance >= 0 ? '+' : '−') + Math.round(Math.abs(imbalance) * 100) + '% ' + (imbalance >= 0 ? 'Bid' : 'Ask')} hint={orderbook.error || 'Visible depth only'}/>
      <Row label="Funding Rate" tone={funding == null ? undefined : funding >= 0 ? 'good' : 'bad'} value={funding == null ? '—' : (funding >= 0 ? '+' : '') + (funding * 100).toFixed(4) + '%'} hint={funding == null ? noDerivs : undefined}/>
      <Row label="Open Interest" value={oi == null ? '—' : compact.format(oi)} hint={oi == null ? noDerivs : undefined}/>
      {watchlist.length > 0 && <div className="dp-mini-list" aria-label="Watchlist samples">{watchlist.map(m => <div key={m.exchange + m.symbol}><span>{m.symbol}</span><b>{formatPrice(m.last)}</b><em className={Number(m.percentage) >= 0 ? 'dp-good' : 'dp-bad'}>{m.percentage == null ? '—' : (Number(m.percentage) > 0 ? '+' : '') + Number(m.percentage).toFixed(2) + '%'}</em></div>)}</div>}
    </div>}
    {tab === 'liquidity' && <div className="dp-tabpane" role="tabpanel">
      <Row label="Bid depth" value={orderbook.data?.bidDepthNotional == null ? '—' : compact.format(orderbook.data.bidDepthNotional)}/>
      <Row label="Ask depth" value={orderbook.data?.askDepthNotional == null ? '—' : compact.format(orderbook.data.askDepthNotional)}/>
      <Row label="Pressure" value={orderbook.data?.pressure ? String(orderbook.data.pressure).replace('-', ' ') : '—'}/>
      <h4>Liquidity walls</h4>
      {walls.map((w, i) => <Row key={w.side + w.price + i} label={w.side.toUpperCase() + ' @ ' + formatPrice(w.price)} tone={w.side === 'bid' ? 'good' : 'bad'} value={compact.format(w.notional) + (w.multipleOfMedian ? ' · ' + w.multipleOfMedian.toFixed(1) + '×' : '')}/>)}
      {!walls.length && <p className="dp-empty">{orderbook.error || 'No walls above 5× median depth in the visible book.'}</p>}
    </div>}
    {tab === 'macro' && <div className="dp-tabpane" role="tabpanel">
      <h4>Next high / medium impact</h4>
      {events.map(e => <Row key={e.id} label={e.title} tone={e.impact === 'high' ? 'bad' : 'warn'} value={new Date(e.at).toISOString().slice(5, 16).replace('T', ' ')}/>)}
      {!events.length && <p className="dp-empty">No high or medium impact events in the next 48 hours.</p>}
      <button type="button" className="dp-link" onClick={() => activeNav('Financial & On-chain')}>Open macro workspace ↗</button>
    </div>}
    {tab === 'news' && <div className="dp-tabpane" role="tabpanel">
      {articles.map(a => <a key={a.id || a.url} className="dp-news-item" href={a.url} target="_blank" rel="noopener noreferrer"><b>{a.title}</b><small>{a.provider || 'News'} · {timeAgo(a.publishedAt)}</small></a>)}
      {!articles.length && <p className="dp-empty">{news.error || 'No headlines returned for ' + symbol + '.'}</p>}
    </div>}
  </Panel>;
}

function MacroPanel({ macro, calendarEvents, now, activeNav }) {
  const readings = MACRO_SERIES.map((series, i) => ({ series, reading: macroReading(series, macro[i].data?.observations) }));
  const firstError = macro.map(m => m.error).find(Boolean);
  const anyData = readings.some(r => r.reading);
  const fomc = nextMatchingEvent(calendarEvents, /FOMC|federal funds rate/i, now);
  return <Panel title="Macro & Central Banks" icon={BarChart3} className="dp-macro">
    {readings.map(({ series, reading }) => <Row key={series.id} label={series.label} value={reading ? reading.display : '—'} hint={reading ? 'FRED ' + series.id + ' · ' + reading.date : series.id}/>)}
    {!anyData && firstError && <p className="dp-note"><CircleAlert size={12} aria-hidden="true"/>{firstError}</p>}
    <div className="dp-next-event"><span>Next FOMC:</span><b>{fomc ? new Date(fomc.at).toISOString().slice(0, 10) : '—'}</b></div>
    <div className="dp-links"><button type="button" onClick={() => activeNav('News & Events')}><CalendarDays size={12} aria-hidden="true"/> Economic events</button><button type="button" onClick={() => activeNav('Institutional Market Intelligence')}><Zap size={12} aria-hidden="true"/> Market regime</button></div>
  </Panel>;
}

function CalendarPanel({ calendar, now, activeNav }) {
  const events = upcomingEvents(calendar.data?.events, now, { limit: 5 });
  const today = new Date(now).toISOString().slice(0, 10);
  return <Panel title="Economic Calendar" icon={CalendarDays} className="dp-calendar" action={<button type="button" className="dp-link" onClick={() => activeNav('News & Events')}>View all ↗</button>}>
    {events.map(e => {
      const iso = new Date(e.at).toISOString();
      return <div className="dp-event" key={e.id}><time dateTime={iso}>{iso.slice(0, 10) === today ? '' : iso.slice(5, 10) + ' '}{iso.slice(11, 16)}</time><span>{e.currency !== 'GLOBAL' ? e.currency + ' ' : ''}{e.title}</span><em className={'dp-badge ' + e.impact}>{e.impact === 'high' ? 'High' : 'Med'}</em></div>;
    })}
    {!events.length && <p className="dp-empty">{calendar.error || (calendar.loading ? 'Loading calendar…' : 'No high or medium impact events in the next 48 hours.')}</p>}
    <small className="dp-foot">Times in UTC · Third-party feed, verify with the issuing agency.</small>
  </Panel>;
}

function SessionAnalytics({ rows, activeNav }) {
  return <Panel title="Session Analytics" icon={BarChart3} action={<button type="button" className="dp-link" onClick={() => activeNav('Calendar & Sessions')}>Details ↗</button>}>
    {rows.map(r => <div className="dp-sa-row" key={r.id}>
      <span className={r.active ? 'on' : ''}>{r.name}</span>
      <div className="dp-bar" role="img" aria-label={r.name + ' relative average range'}><i className={'s-' + r.id} style={{ width: r.barPercent + '%' }}/></div>
      <b title={r.observations + ' prior sessions observed'}>{r.rangePercent == null ? '—' : r.rangePercent.toFixed(2) + '%'}</b>
    </div>)}
    <small className="dp-foot">Average session range as % of price (1h candles). Bars are relative.</small>
  </Panel>;
}

function VolatilityPanel({ regime, atr, atrPercent, spread, rvol, risk, ratio }) {
  const eventLabel = { high: 'High', medium: 'Medium', none: 'None', unknown: 'Unknown' }[risk.level];
  return <Panel title="Volatility Risk" icon={Activity}>
    <div className={'dp-regime ' + regime.tone}><CircleAlert size={22} aria-hidden="true"/><div><b>{regime.level}</b><small>{ratio == null ? 'Needs 65+ candles' : 'ATR is ' + ratio.toFixed(2) + '× its recent mean'}</small></div></div>
    <Row label="ATR (14)" value={atr == null ? '—' : formatPrice(atr) + (atrPercent == null ? '' : ' · ' + atrPercent.toFixed(2) + '%')}/>
    <Row label="Spread" value={spread == null ? '—' : spread.toFixed(3) + '%'} hint="Top-of-book bid/ask spread from the latest ticker"/>
    <Row label="Relative Volume" value={rvol == null ? '—' : rvol.toFixed(1) + '×'} hint="Latest bar volume vs. the prior 20-bar mean"/>
    <Row label="Event Risk" tone={risk.level === 'high' ? 'bad' : risk.level === 'medium' ? 'warn' : undefined} value={eventLabel} hint={risk.event ? risk.event.title : undefined}/>
    <small className="dp-foot">Heuristic regime on 15m candles, not a forecast.</small>
  </Panel>;
}

function TradingControls({ last, symbol, activeNav }) {
  const [side, setSide] = useState('buy');
  const [risk, setRisk] = useState('1');
  const [stop, setStop] = useState('1');
  const [target, setTarget] = useState('2');
  const [equity, setEquity] = useState('');
  const plan = useMemo(() => tradePlan({ side, entry: last, riskPercent: risk, stopPercent: stop, targetPercent: target, equity }), [side, last, risk, stop, target, equity]);
  return <Panel title="Trading Controls" icon={Zap} className="dp-controls">
    <div className="dp-sides" role="group" aria-label="Trade direction">
      <button type="button" className={'buy' + (side === 'buy' ? ' on' : '')} aria-pressed={side === 'buy'} onClick={() => setSide('buy')}>Buy</button>
      <button type="button" className={'sell' + (side === 'sell' ? ' on' : '')} aria-pressed={side === 'sell'} onClick={() => setSide('sell')}>Sell</button>
    </div>
    <div className="dp-fields">
      <label>Risk per Trade<select value={risk} onChange={e => setRisk(e.target.value)}>{['0.25', '0.5', '1', '2', '3'].map(v => <option key={v} value={v}>{v}%</option>)}</select></label>
      <label>SL (% from entry)<input type="number" min="0.01" step="0.1" inputMode="decimal" value={stop} onChange={e => setStop(e.target.value)}/></label>
      <label>TP (% from entry)<input type="number" min="0.01" step="0.1" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)}/></label>
      <label>Account equity (optional)<input type="number" min="0" step="any" inputMode="decimal" placeholder="e.g. 10000" value={equity} onChange={e => setEquity(e.target.value)}/></label>
    </div>
    {plan ? <div className="dp-plan" aria-live="polite">
      <Row label="Stop price" value={formatPrice(plan.stopPrice)} tone="bad"/>
      <Row label="Target price" value={formatPrice(plan.targetPrice)} tone="good"/>
      <Row label="Reward : Risk" value={plan.rewardRisk.toFixed(2) + ' : 1'}/>
      {plan.quantity != null && <Row label="Position size" value={plan.quantity.toLocaleString(undefined, { maximumSignificantDigits: 6 }) + ' (' + compact.format(plan.notional) + ')'} hint={'Risking ' + compact.format(plan.riskAmount)}/>}
    </div> : <p className="dp-empty">{last == null ? 'Waiting for a live price for ' + symbol + '.' : 'Enter positive risk, stop and target values.'}</p>}
    <p className="dp-foot"><ShieldCheck size={11} aria-hidden="true"/> Calculator only. Live orders are locked by default.</p>
    <button type="button" className="dp-wide" onClick={() => activeNav('Futures')}>Open paper trading desk ↗</button>
  </Panel>;
}

function BottomRow({ snapshot, pools, regime, ratio, risk, sweep, calendarEvents, calendar, news, now, performanceData, performanceError, loadTradePerformance, systems, activeNav, symbol }) {
  const perf = performanceSummary(performanceData);
  const earnings = upcomingEvents(calendarEvents, now, { limit: 3, windowHours: 24 * 7, impacts: ['high', 'medium', 'low', 'unspecified'] }).filter(e => e.category === 'earnings');
  const articles = Array.isArray(news.data?.articles) ? news.data.articles.slice(0, 3) : [];
  const insights = [];
  if (snapshot.activeSessionNames.length) insights.push((snapshot.overlap ? 'Overlap: ' : 'Active: ') + snapshot.activeSessionNames.join(' + ') + (snapshot.killzones.length ? ' (killzone)' : ''));
  else insights.push('No major session is open right now.');
  if (pools.status === 'ready') insights.push('Buy-side liquidity near ' + formatPrice(pools.buySide.price) + ', sell-side near ' + formatPrice(pools.sellSide.price) + '.');
  if (sweep) insights.push('Latest ' + String(sweep.side || 'liquidity').replaceAll('-', ' ') + ' sweep' + (Number.isFinite(Number(sweep.level)) ? ' @ ' + formatPrice(sweep.level) : '') + (sweep.session ? ' (' + sweep.session + ')' : '') + ' · ' + String(sweep.phase || 'detected').replaceAll('-', ' ') + '.');
  if (regime.level !== 'UNAVAILABLE') insights.push('Volatility regime ' + regime.level + (ratio == null ? '' : ' (ATR ' + ratio.toFixed(2) + '×)') + '.');
  if (risk.event) insights.push('Upcoming ' + risk.event.impact + ' impact: ' + risk.event.title + '.');
  return <div className="dp-bottom">
    <Panel title="Key Insights" icon={Activity}><ul className="dp-insights">{insights.slice(0, 4).map((text, i) => <li key={i}><i/>{text}</li>)}</ul></Panel>
    <Panel title="Earnings Calendar" icon={CalendarDays}>
      {earnings.map(e => <div className="dp-event" key={e.id}><span><b>{e.title}</b></span><time dateTime={new Date(e.at).toISOString()}>{new Date(e.at).toISOString().slice(5, 10)}</time></div>)}
      {!earnings.length && <p className="dp-empty">{calendar.error || 'No earnings in the next 7 days. Earnings map to listed equities only, not crypto.'}</p>}
    </Panel>
    <Panel title="News & Speakers" icon={Newspaper}>
      {articles.map(a => <a key={a.id || a.url} className="dp-news-item" href={a.url} target="_blank" rel="noopener noreferrer"><b>{a.title}</b><small>{a.provider || 'News'} · {timeAgo(a.publishedAt)}</small></a>)}
      {!articles.length && <p className="dp-empty">{news.error || 'No headlines returned for ' + symbol + '.'}</p>}
    </Panel>
    <Panel title="JPTI Performance" icon={TrendingUp} action={<button type="button" className="dp-link" onClick={() => activeNav('Portfolio & Ledger')}>Ledger ↗</button>}>
      {perf ? <>
        <Row label="Win Rate" tone="good" value={perf.winRate == null ? '—' : perf.winRate.toFixed(1) + '%'}/>
        <Row label="Profit Factor" value={perf.profitFactor == null ? '—' : perf.profitFactor.toFixed(2)}/>
        <Row label="Max Drawdown" tone="bad" value={perf.maxDrawdown == null ? '—' : compact.format(perf.maxDrawdown) + ' ' + (perf.quoteCurrency || '')}/>
        <small className="dp-foot">{perf.closed} closed exits · ledger-based</small>
      </> : <>
        <p className="dp-empty">{performanceError || 'No closed trades loaded. Metrics come only from your recorded ledger fills.'}</p>
        {typeof loadTradePerformance === 'function' && <button type="button" className="dp-wide" onClick={loadTradePerformance}>Load from ledger</button>}
      </>}
    </Panel>
    <section className={'dp-status ' + systems.tone} aria-label="System status" aria-live="polite">
      <ShieldCheck size={26} aria-hidden="true"/><b>{systems.label}</b><small>{systems.detail}</small><small>Last update: {new Date(systems.updatedAt).toISOString().slice(11, 19)} UTC</small>
    </section>
  </div>;
}

export default function ProDashboard({ symbol, onSymbolChange, health, operations, activeNav, refresh, navigation, performanceData, performanceError, loadTradePerformance, watchlist = [] }) {
  const now = useNow(1000);
  const minute = Math.floor(now / 60000);
  const [exchange, setExchange] = useState('binance');
  const [showLiquidity, setShowLiquidity] = useState(true);
  const handleExchange = useCallback(id => setExchange(id), []);
  const snapshot = useMemo(() => getSessionSnapshot(now), [now]);
  const path = String(symbol || 'BTC/USDT').replace('/', '-');

  const ticker = useApi('/api/exchanges/' + exchange + '/ticker/' + path, { intervalMs: 10000 });
  const candles15 = useApi('/api/exchanges/' + exchange + '/ohlcv/' + path + '?timeframe=15m&limit=200', { intervalMs: 30000 });
  const candles1h = useApi('/api/exchanges/' + exchange + '/ohlcv/' + path + '?timeframe=1h&limit=300', { intervalMs: 120000 });
  const orderbook = useApi('/api/advanced/orderbook/' + exchange + '/' + path + '?limit=50', { intervalMs: 15000 });
  const derivs = useApi('/api/advanced/derivatives/' + exchange + '/' + path, { intervalMs: 60000 });
  const calendar = useApi('/api/institutional/calendar?symbol=' + encodeURIComponent(symbol || ''), { intervalMs: 300000 });
  const news = useApi('/api/institutional/news?symbol=' + encodeURIComponent(symbol || ''), { intervalMs: 300000 });
  const macro = [
    useApi('/api/intelligence/macro/' + MACRO_SERIES[0].id + '?limit=14', { intervalMs: 3600000 }),
    useApi('/api/intelligence/macro/' + MACRO_SERIES[1].id + '?limit=14', { intervalMs: 3600000 }),
    useApi('/api/intelligence/macro/' + MACRO_SERIES[2].id + '?limit=14', { intervalMs: 3600000 }),
    useApi('/api/intelligence/macro/' + MACRO_SERIES[3].id + '?limit=14', { intervalMs: 3600000 })
  ];

  const c15 = useMemo(() => cleanCandles(candles15.data?.candles), [candles15.data]);
  const c1h = useMemo(() => cleanCandles(candles1h.data?.candles), [candles1h.data]);
  const last = toNumber(ticker.data?.last) ?? (c15.length ? c15[c15.length - 1][4] : null);
  const pools = useMemo(() => liquidityPools(c15), [c15]);
  const levels = useMemo(() => showLiquidity ? chartLevelsFromPools(pools) : NO_LEVELS, [pools, showLiquidity]);
  const atr = useMemo(() => averageTrueRange(c15), [c15]);
  const ratio = useMemo(() => atrRatio(c15), [c15]);
  const rvol = useMemo(() => relativeVolume(c15), [c15]);
  const calendarEvents = calendar.data?.events;
  const risk = useMemo(() => eventRisk(calendarEvents, minute * 60000), [calendarEvents, minute]);
  const regime = volatilityRisk({ ratio, eventLevel: risk.level });
  const analytics = useMemo(() => analyzeSessionCandles(c1h, minute * 60000), [c1h, minute]);
  const sessionRows = sessionRangeRows(snapshot.sessions, analytics, last);
  const sweeps = useMemo(() => detectSessionLiquiditySweeps(c15, { now: minute * 60000 }), [c15, minute]);
  const sweep = sweeps && Array.isArray(sweeps.events) && sweeps.events.length ? sweeps.events[sweeps.events.length - 1] : null;
  const systems = systemsStatus({ health, jobs: operations?.jobs, now });
  const [source, setSource] = useState(getApiSource);
  useEffect(() => subscribeApiSource(e => setSource(e.detail || getApiSource())), []);
  const direct = source.mode === 'direct' || Boolean(health?.directMode);
  const live = ticker.data != null && (health?.status === 'ok' || direct);

  return <div className="dp-root">
    <TopBar activeNav={activeNav} now={now} live={live} direct={direct} refresh={refresh} navigation={navigation}/>
    <SessionStrip snapshot={snapshot} symbol={symbol} ticker={ticker}/>
    <div className="dp-grid">
      <div className="dp-col dp-left" role="complementary" aria-label="Market context">
        <MarketIntelPanel symbol={symbol} pools={pools} orderbook={orderbook} derivs={derivs} calendarEvents={calendarEvents} now={now} news={news} watchlist={watchlist} activeNav={activeNav}/>
        <MacroPanel macro={macro} calendarEvents={calendarEvents} now={now} activeNav={activeNav}/>
        <CalendarPanel calendar={calendar} now={now} activeNav={activeNav}/>
      </div>
      <section className="dp-col dp-center" aria-label="Live chart">
        <section className="dp-chart">
          <div className="dp-chart-bar">
            <div className="dp-chart-title"><b>{symbol}</b><small>{String(exchange).toUpperCase()} · analytics on 15m candles</small></div>
            <div className="dp-chart-actions">
              <button type="button" className={'dp-toggle' + (showLiquidity ? ' on' : '')} aria-pressed={showLiquidity} onClick={() => setShowLiquidity(v => !v)} title="Draw candle-derived buy-side / sell-side liquidity levels on the chart">SMC · Liquidity</button>
              <span className={'dp-live-chip ' + (ticker.data ? 'good' : ticker.loading ? 'idle' : 'bad')} title="Ticker refreshes every 10 seconds"><i/>{ticker.data ? 'Live' : ticker.loading ? 'Connecting' : 'Offline'}</span>
            </div>
          </div>
          <div className="dp-chart-frame"><ExchangeConnectivity symbol={symbol} onSymbolChange={onSymbolChange} alphaLevels={levels} onExchangeChange={handleExchange} compact/></div>
          <div className="dp-legend" aria-label="Chart overlay legend"><span><i className="bad"/>Buy-side liquidity {pools.buySide ? formatPrice(pools.buySide.price) : '—'}</span><span><i className="good"/>Sell-side liquidity {pools.sellSide ? formatPrice(pools.sellSide.price) : '—'}</span><small>Levels are inferred from equal highs/lows, not from stop orders.</small></div>
        </section>
      </section>
      <div className="dp-col dp-right" role="complementary" aria-label="Session and risk">
        <SessionAnalytics rows={sessionRows} activeNav={activeNav}/>
        <VolatilityPanel regime={regime} atr={atr} atrPercent={atr != null && last ? atr / last * 100 : null} spread={spreadPercent(ticker.data)} rvol={rvol} risk={risk} ratio={ratio}/>
        <TradingControls last={last} symbol={symbol} activeNav={activeNav}/>
      </div>
    </div>
    <BottomRow snapshot={snapshot} pools={pools} regime={regime} ratio={ratio} risk={risk} sweep={sweep} calendarEvents={calendarEvents} calendar={calendar} news={news} now={now} performanceData={performanceData} performanceError={performanceError} loadTradePerformance={loadTradePerformance} systems={systems} activeNav={activeNav} symbol={symbol}/>
  </div>;
}
