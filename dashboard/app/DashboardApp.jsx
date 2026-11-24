import React, { useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Bell, CheckCircle2, Clock3, Crosshair, Gauge, RefreshCw, ShieldCheck, Sparkles, Target, TrendingUp, Zap } from 'lucide-react';
import LiveCandlestickChart from '../../src/LiveCandlestickChart.jsx';
import { useSignalIntelligence } from './hooks/useSignalIntelligence.js';
import './styles/signal-dashboard.css';

const fmt = (value, digits = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });
const percent = (value) => value == null ? '—' : (Number(value) > 0 ? '+' : '') + Number(value).toFixed(2) + '%';

function Metric({ label, value, note, icon: Icon, tone = '' }) {
  return <article className="si-metric"><span>{label}<Icon size={16}/></span><strong className={tone}>{value}</strong><small>{note}</small></article>;
}
function SignalCard({ signal, onSelect }) {
  const long = signal.direction === 'long';
  return <button type="button" className="si-signal-card" onClick={() => onSelect(signal.symbol)}>
    <div><span className={'si-direction ' + (long ? 'long' : 'short')}>{long ? 'LONG' : 'SHORT'}</span><b>{signal.symbol}</b><span className="si-score">{signal.score}/100</span></div>
    <p>{signal.signalType.replaceAll('-', ' ')} · {signal.scoreLabel}</p>
    <div className="si-level-row"><span>Entry <b>{fmt(signal.referencePrice, 6)}</b></span><span>Stop <b>{fmt(signal.stopLoss, 6)}</b></span></div>
    <small>{signal.reasons.slice(0, 2).join(' · ') || 'Awaiting confluence'}</small>
  </button>;
}

export default function DashboardApp({ initialSymbol = 'BTC/USDT' }) {
  const state = useSignalIntelligence({ initialSymbol });
  const [showHistory, setShowHistory] = useState(false);
  const selectedSignal = state.selected?.signal;
  const selectedTicker = state.selected?.ticker;
  const activeCount = state.topSignals.length;
  const marketRegime = useMemo(() => {
    const active = state.signals.filter((item) => item.score >= 40);
    if (!active.length) return 'Unclear';
    const bullish = active.filter((item) => item.direction === 'long').length;
    const bearish = active.filter((item) => item.direction === 'short').length;
    return bullish > bearish ? 'Bullish' : bearish > bullish ? 'Bearish' : 'Mixed';
  }, [state.signals]);
  const avgScore = state.signals.length ? state.signals.reduce((sum, item) => sum + item.score, 0) / state.signals.length : null;
  const onSelectSymbol = (pair) => state.setSymbol(pair);

  return <div className="signal-intelligence-app">
    <header className="si-header"><div className="si-brand"><span className="si-brand-mark"><TrendingUp size={21}/></span><span><b>JPTI</b><small>JOPEARL TRADING INTELLIGENCE</small></span></div><nav><span className="active">Signal Intelligence</span><span>Market Analysis</span><span>Opportunity Radar</span><span>Risk Intelligence</span></nav><div className="si-live"><i/> {state.loading ? 'UPDATING' : 'LIVE MONITOR'}</div></header>
    <div className="si-titlebar"><div><span className="si-eyebrow"><Activity size={14}/> QUANTITATIVE RESEARCH / SIGNAL ENGINE</span><h2>Signal Intelligence</h2><p>Live opportunity detection, transparent evidence and risk-aware trade planning.</p></div><div className="si-title-actions"><span className="si-updated">{state.lastUpdated ? 'Updated ' + new Date(state.lastUpdated).toLocaleTimeString() : 'Awaiting market data'}</span><button onClick={state.refresh} disabled={state.loading}><RefreshCw size={14}/> Refresh</button></div></div>
    <section className="si-toolbar">
      <label>Exchange<select value={state.exchange} onChange={(e) => state.setExchange(e.target.value)}>{state.exchanges.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}</select></label>
      <label>Market<select value={state.marketType} onChange={(e) => state.setMarketType(e.target.value)}>{state.marketTypes.map((x) => <option key={x} value={x}>{x === 'futures' ? 'USDT-M Futures' : x === 'coin-futures' ? 'Coin-M Futures' : x === 'usdc-futures' ? 'USDC-M Futures' : x}</option>)}</select></label>
      <label>Symbol<select value={state.symbol} onChange={(e) => state.setSymbol(e.target.value)}>{[...new Set([...state.watchlist, ...Object.keys(state.snapshots)])].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label>Timeframe<select value={state.timeframe} onChange={(e) => state.setTimeframe(e.target.value)}>{['5m','15m','1h','4h','1d'].map((x) => <option key={x}>{x}</option>)}</select></label>
      <label className="si-auto"><input type="checkbox" checked={state.autoRefresh} onChange={(e) => state.setAutoRefresh(e.target.checked)}/> Auto-refresh 30s</label>
    </section>
    {state.error && <div className="si-error"><AlertTriangle size={15}/>{state.error}</div>}
    <section className="si-metrics">
      <Metric label="Market Regime" value={marketRegime} note="Derived from current scanned pairs" icon={Activity} tone={marketRegime.toLowerCase()}/>
      <Metric label="Active Signals" value={activeCount} note="Developing and confirmed candidates" icon={Zap}/>
      <Metric label="Average Evidence" value={avgScore == null ? '—' : Math.round(avgScore) + '/100'} note="Heuristic score, not win probability" icon={Gauge}/>
      <Metric label="Markets Scanned" value={Object.keys(state.snapshots).length} note="Live exchange data received" icon={Crosshair}/>
      <Metric label="Signal Records" value={state.history.length} note="Browser-persisted observations" icon={ShieldCheck}/>
    </section>
    <section className="si-main-grid">
      <div className="si-chart-panel">
        <div className="si-panel-head"><div><b>{state.symbol} · {state.exchange.toUpperCase()} · {state.marketType.toUpperCase()}</b><small>{selectedTicker?.last == null ? 'Awaiting quote' : fmt(selectedTicker.last, 8) + ' ' + (selectedTicker.quoteVolume ? '· 24h volume ' + fmt(selectedTicker.quoteVolume, 0) : '')}</small></div><span className="si-market-change">{percent(selectedTicker?.percentage)}</span></div>
        <div className="si-chart-host"><LiveCandlestickChart exchange={state.exchange} symbol={state.symbol} onSymbolChange={state.setSymbol} initialTimeframe={state.timeframe} initialMarketType={state.marketType} onTimeframeChange={state.setTimeframe} onMarketTypeChange={state.setMarketType} onExchangeChange={state.setExchange} alphaLevels={selectedSignal?.stopLoss == null ? [] : [{ label: 'STOP', price: selectedSignal.stopLoss, color: '#fb7185' }, ...selectedSignal.targets.map((price, index) => ({ label: 'TP' + (index + 1), price, color: '#34d399' }))]}/></div>
      </div>
      <aside className="si-opportunities"><div className="si-panel-head"><div><b><Sparkles size={15}/> Top Trading Opportunities</b><small>Ranked on observed market evidence</small></div><span>{state.topSignals.length} candidates</span></div>
        {state.topSignals.length ? state.topSignals.map((signal) => <SignalCard key={signal.signalId} signal={signal} onSelect={onSelectSymbol}/>) : <div className="si-empty">No qualifying signal yet. The scanner will show a candidate when completed candles support one.</div>}
      </aside>
    </section>
    <section className="si-lower-grid">
      <article className="si-panel"><div className="si-panel-head"><b><Gauge size={15}/> Signal Strength</b><span>{avgScore == null ? '—' : Math.round(avgScore) + '/100'}</span></div><div className="si-score-list">{(selectedSignal?.evidence || []).map((item) => <div key={item.key}><span>{item.label}</span><b>{item.contribution}/{item.key === 'trend' || item.key === 'structure' ? 15 : item.key === 'momentum' || item.key === 'volume' || item.key === 'follow-through' ? 10 : 5}</b><i><em style={{width: (item.contribution / 15 * 100) + '%'}}/></i></div>)}</div><small>Scores represent weighted rule evidence, not a calibrated probability of profit.</small></article>
      <article className="si-panel"><div className="si-panel-head"><b><Sparkles size={15}/> Signal Intelligence — Key Insights</b><span>Evidence report</span></div><ul className="si-insights">{(selectedSignal?.evidence || []).map((item) => <li key={item.key}><CheckCircle2 size={14}/><span><b>{item.label}</b><small>{item.detail}</small></span></li>)}</ul>{selectedSignal && <p className="si-invalidation"><ShieldCheck size={14}/> Invalidation: {selectedSignal.invalidation}</p>}</article>
      <article className="si-panel"><div className="si-panel-head"><b><Target size={15}/> Trade Plan</b><span>{selectedSignal?.status || 'No setup'}</span></div><div className="si-trade-levels"><div><span>Reference entry</span><b>{fmt(selectedSignal?.referencePrice, 8)}</b></div><div><span>Stop loss</span><b className="negative">{fmt(selectedSignal?.stopLoss, 8)}</b></div>{(selectedSignal?.targets || []).map((target, index) => <div key={target}><span>Target {index + 1}</span><b className="positive">{fmt(target, 8)}</b></div>)}</div><small>Reference prices are research levels. Validate spread, slippage, fees and position risk before any trade.</small></article>
      <article className="si-panel"><div className="si-panel-head"><b><Clock3 size={15}/> Session Insights</b><span>UTC</span></div><div className="si-session"><b>{new Intl.DateTimeFormat('en', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())} UTC</b><span>Session context is linked to the selected market chart.</span><small>Session boundaries and overlap are calculated in the chart intelligence workspace.</small></div><div className="si-regime-note">Regime: <b>{marketRegime}</b> · Signals: <b>{state.signals.length}</b></div></article>
    </section>
    <section className="si-panel si-live-table"><div className="si-panel-head"><b><Activity size={15}/> Live Signals</b><button onClick={() => setShowHistory((value) => !value)}>{showHistory ? 'Show current signals' : 'Signal history'}</button></div>
      <div className="si-table-scroll"><table><thead><tr><th>Pair</th><th>Type</th><th>Direction</th><th>Score</th><th>Entry</th><th>Stop</th><th>Targets</th><th>Status</th><th>Updated</th></tr></thead><tbody>{(showHistory ? state.history : state.signals).slice(0, 30).map((signal) => <tr key={signal.signalId}><td><b>{signal.symbol}</b></td><td>{signal.signalType}</td><td className={signal.direction === 'long' ? 'positive' : signal.direction === 'short' ? 'negative' : ''}>{signal.direction.toUpperCase()}</td><td>{signal.score ?? '—'}/100</td><td>{fmt(signal.referencePrice, 6)}</td><td>{fmt(signal.stopLoss, 6)}</td><td>{signal.targets?.map((value) => fmt(value, 6)).join(' / ') || '—'}</td><td>{signal.status}</td><td>{new Date(signal.observedAt || signal.generatedAt).toLocaleTimeString()}</td></tr>)}</tbody></table></div>
    </section>
    <div className="si-disclaimer"><ShieldCheck size={14}/> Research and decision support only. Signal scores are heuristic evidence weights, not predicted win rates. Live order execution is not connected to this dashboard.</div>
  </div>;
}
