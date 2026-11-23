import React, { useEffect, useMemo, useState } from 'react';
import ProDashboard from './DashboardPro.jsx';
import { getSessionSnapshot } from './session-intelligence.js';
import { Activity, BarChart3, Globe2, Layers3, Newspaper, ShieldCheck } from 'lucide-react';
import './Dashboard.css';

const formatNumber = (value, digits = 4) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const sessionColors = { Sydney: 'dash-sydney', Tokyo: 'dash-tokyo', London: 'dash-london', 'New York': 'dash-newyork' };

function SessionBoard() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const snapshot = useMemo(() => getSessionSnapshot(now), [now]);
  return <section className="dash-sessions">
    <div className="dash-section-title"><div><Globe2 size={15}/><b>TRADING SESSIONS</b><span className="dash-live-dot"/>LIVE</div><small>{snapshot.overlap ? snapshot.overlapName + ' overlap' : snapshot.activeSessionNames.join(', ') || 'No active major session'}</small></div>
    <div className="dash-session-grid">{snapshot.sessions.map(session => <article className={sessionColors[session.name]} key={session.id}>
      <div className="dash-session-top"><span className="dash-session-mark">{session.name === 'Sydney' ? '🇦🇺' : session.name === 'Tokyo' ? '🇯🇵' : session.name === 'London' ? '🇬🇧' : '🇺🇸'}</span><b>{session.name}</b><span className={session.active ? 'dash-session-active' : 'dash-session-idle'}>{session.active ? 'OPEN' : session.phase.toUpperCase()}</span></div>
      <strong className="dash-session-clock">{session.localTime}</strong><small>{session.open} – {session.close} local</small>
      <div className="dash-progress"><i style={{width: session.progressPercent + '%'}}/></div>
      <div className="dash-session-foot"><span>{session.active ? session.progressPercent.toFixed(0) + '% elapsed' : session.focus}</span><span>{session.active ? Math.floor(session.remainingMinutes / 60) + 'h ' + session.remainingMinutes % 60 + 'm left' : session.timezone.split('/').pop().replace('_',' ')}</span></div>
    </article>)}</div>
  </section>;
}

export default function Dashboard({ symbol, onSymbolChange, refresh, health, operations, providers, ledger, events, lastRefresh, activeNav, quoteSymbol, setQuoteSymbol, quoteConsensus, quoteLoading, quoteError, loadQuoteConsensus, crossVenueSymbol, setCrossVenueSymbol, crossVenueData, crossVenueLoading, crossVenueError, loadCrossVenue, performanceData, performanceError, loadTradePerformance, navigation }) {
  const configured = (providers?.providers || []).filter(p => p.configured).length;
  const totalProviders = providers?.providers?.length || 0;
  const jobs = operations?.jobs || [];
  const marketJob = jobs.find(j => j.id === 'market-monitor');
  const snapshots = marketJob?.lastSnapshot || [];
  const recentEvents = (events || []).slice(0, 4);
  const topMarkets = snapshots.slice(0, 5);
  const marketCount = snapshots.length;
  const gateway = health?.status === 'ok';
  return <div className="jpti-dashboard">
    <ProDashboard symbol={symbol} onSymbolChange={onSymbolChange} health={health} operations={operations} activeNav={activeNav} refresh={refresh} navigation={navigation} performanceData={performanceData} performanceError={performanceError} loadTradePerformance={loadTradePerformance} watchlist={topMarkets}/>
    <details className="dp-workbench" open>
      <summary><span>Workbench &amp; diagnostics</span><small>Detailed sessions · system events · ledger · quote validation · venue scanner · providers</small></summary>
      <div className="dp-workbench-body">
        <SessionBoard/>
        <div className="dp-wb-grid">
          <div className="dp-wb-col">
        <section className="dash-panel">
          <div className="dash-panel-head"><div><Layers3 size={15}/><b>MARKET INTELLIGENCE</b></div><button onClick={() => activeNav('Institutional Market Intelligence')}>Open IMI ↗</button></div>
          <div className="dash-intel-metrics"><div><small>WATCHLIST SAMPLES</small><b>{marketCount || '—'}</b></div><div><small>DATA SOURCES</small><b>{configured} / {totalProviders || '—'}</b></div></div>
          <div className="dash-market-list">{topMarkets.map(m => <div key={m.exchange + m.symbol}><span><b>{m.symbol}</b><small>{m.exchange}</small></span><strong>{formatNumber(m.last, 8)}</strong><em className={Number(m.percentage) >= 0 ? 'positive' : 'negative'}>{m.percentage == null ? '—' : (Number(m.percentage) > 0 ? '+' : '') + Number(m.percentage).toFixed(2) + '%'}</em></div>)}{!topMarkets.length && <p className="dash-empty">No scheduled watchlist data yet. Configure the market monitor to populate this panel.</p>}</div>
          <div className="dash-footnote">Snapshots reflect the most recent completed monitor cycle.</div>
        </section>
        <section className="dash-panel">
          <div className="dash-panel-head"><div><Newspaper size={15}/><b>RECENT SYSTEM EVENTS</b></div><button onClick={() => activeNav('System Diagnostics')}>Diagnostics ↗</button></div>
          <div className="dash-event-list">{recentEvents.map(ev => <div key={ev.id}><span className="dash-event-bullet"/><div><b>{ev.kind === 'market-monitor-snapshot' ? 'Market monitor snapshot' : ev.eventType || ev.kind || 'System event'}</b><small>{ev.source || (ev.markets ? ev.markets.length + ' market(s)' : 'Event recorded')} · {ev.occurredAt ? new Date(ev.occurredAt).toLocaleString() : 'Timestamp unavailable'}</small></div></div>)}{!recentEvents.length && <p className="dash-empty">Event ledger is quiet. New recorded activity will appear here.</p>}</div>
        </section>
          </div>
          <div className="dp-wb-col">
        <section className="dash-panel dash-risk"><div className="dash-panel-head"><div><ShieldCheck size={15}/><b>VOLATILITY / RISK</b></div><span className="dash-protected">SAFE MODE</span></div><div className="dash-risk-state"><i/><b>EXECUTION PROTECTED</b></div><p>Live orders are gated. Paper and research functions remain separate from order authorization.</p><div className="dash-risk-lines"><span>Gateway <b>{gateway ? 'Connected' : 'Unavailable'}</b></span><span>Trading mode <b>{health?.mode?.toUpperCase() || '—'}</b></span><span>Scheduler <b>{operations?.schedulerEnabled ? 'Enabled' : 'Inactive'}</b></span></div><button className="dash-wide-action" onClick={() => activeNav('Pre-trade Gate')}>Review trading safeguards</button></section>
        <section className="dash-panel dash-ops"><div className="dash-panel-head"><div><Activity size={15}/><b>OPERATIONAL STATUS</b></div><button onClick={() => activeNav('System Diagnostics')}>Full status ↗</button></div>{jobs.slice(0,4).map(job => <div className="dash-job-row" key={job.id}><span>{job.label}</span><b className={job.status === 'live' || job.status === 'ok' ? 'positive' : 'dash-job-neutral'}>{String(job.status || 'unknown').replaceAll('-', ' ')}</b></div>)}<small className="dash-updated">Last refresh: {lastRefresh ? new Date(lastRefresh).toLocaleTimeString() : 'pending'}</small></section>
      <section className="dash-panel"><div className="dash-panel-head"><div><BarChart3 size={15}/><b>PORTFOLIO / PERFORMANCE</b></div><button onClick={() => activeNav('Portfolio & Ledger')}>Portfolio ↗</button></div><div className="dash-ledger-stat"><b>{formatNumber(ledger?.eventCount, 0)}</b><span>Persisted ledger events<br/>This count is activity, not profit/loss.</span></div><button className="dash-wide-action" onClick={() => activeNav('Portfolio & Ledger')}>Open ledger and performance workspace</button></section>
          </div>
        </div>
    <div className="dash-extra-grid">
      <section className="dash-panel dash-extra"><div className="dash-panel-head"><div><BarChart3 size={15}/><b>PROVIDER QUOTE CONSENSUS</b></div><span className="dash-protected">READ-ONLY</span></div>
        <form className="dash-query-form" onSubmit={loadQuoteConsensus}><input value={quoteSymbol} onChange={e => setQuoteSymbol(e.target.value)} placeholder="Ticker e.g. AAPL"/><button disabled={quoteLoading || !quoteSymbol.trim()}>{quoteLoading ? 'Checking…' : 'Validate quote'}</button></form>
        {quoteError && <p className="dash-error">{quoteError}</p>}
        {quoteConsensus && <div className="dash-consensus-results"><div><small>CONSENSUS PRICE</small><b>{quoteConsensus.consensusPrice == null ? 'Unavailable' : formatNumber(quoteConsensus.consensusPrice, 6) + (quoteConsensus.currency ? ' ' + quoteConsensus.currency : '')}</b></div><div><small>VALID SOURCES</small><b>{quoteConsensus.sourceCount ?? '—'}</b></div><div><small>DISPERSION</small><b>{quoteConsensus.spreadPercent == null ? '—' : Number(quoteConsensus.spreadPercent).toFixed(3)+'%'}</b></div><div><small>CONFIDENCE</small><b>{String(quoteConsensus.confidence || 'Unavailable').replaceAll('-', ' ')}</b></div></div>}
      </section>
      <section className="dash-panel dash-extra"><div className="dash-panel-head"><div><Layers3 size={15}/><b>CROSS-EXCHANGE SCANNER</b></div><span className="dash-protected">INDICATIVE</span></div>
        <form className="dash-query-form" onSubmit={loadCrossVenue}><input value={crossVenueSymbol} onChange={e => setCrossVenueSymbol(e.target.value)} placeholder="Market e.g. BTC/USDT"/><button disabled={crossVenueLoading || !crossVenueSymbol.trim()}>{crossVenueLoading ? 'Scanning…' : 'Scan venues'}</button></form>
        {crossVenueError && <p className="dash-error">{crossVenueError}</p>}
        {crossVenueData && <><div className="dash-consensus-results"><div><small>VENUES RESPONDING</small><b>{crossVenueData.venueCount ?? '—'}</b></div><div><small>MEDIAN PRICE</small><b>{formatNumber(crossVenueData.medianLast, 6)}</b></div><div><small>PRICE DISPERSION</small><b>{crossVenueData.lastPriceSpreadPercent == null ? '—' : Number(crossVenueData.lastPriceSpreadPercent).toFixed(3)+'%'}</b></div><div><small>GROSS EDGE</small><b>{crossVenueData.bestIndicativeTopOfBook?.grossEdgePercent == null ? '—' : Number(crossVenueData.bestIndicativeTopOfBook.grossEdgePercent).toFixed(3)+'%'}</b></div></div><p className="dash-footnote">Fees, liquidity depth and execution risk are not included in the indicative edge.</p></>}
      </section>
    </div>
    <section className="dash-panel dash-provider-panel"><div className="dash-panel-head"><div><Globe2 size={15}/><b>CONNECTED INTELLIGENCE PROVIDERS</b></div><button onClick={() => activeNav('Financial & On-chain')}>Provider settings ↗</button></div><div className="dash-provider-list">{(providers?.providers || []).slice(0,12).map(provider => <div key={provider.id}><i className={provider.configured ? 'dash-provider-ready' : ''}/><span>{provider.name}</span><b>{provider.configured ? 'Configured' : 'Not configured'}</b></div>)}{!providers?.providers?.length && <p className="dash-empty">Provider registry loading or unavailable.</p>}</div><p className="dash-footnote">Configured credentials do not imply a successful live request or an active subscription.</p></section>
      </div>
    </details>
  </div>;
}
