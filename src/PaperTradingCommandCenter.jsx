import React,{useCallback,useEffect,useState} from 'react';
import {Activity,ShieldCheck,RefreshCw,PlayCircle,CalendarClock,TrendingUp,Lock,AlertTriangle,Award} from 'lucide-react';
import {apiFetch} from './lib/api.js';
import './PaperTradingCommandCenter.css';

const money=v=>Number(v||0).toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2});
const pct=v=>Number(v||0).toFixed(2)+'%';
const stamp=v=>v?new Date(v).toLocaleString():'—';

export default function PaperTradingCommandCenter(){
 const [data,setData]=useState(null),[reviews,setReviews]=useState([]),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const load=useCallback(async()=>{
  try{const [a,b]=await Promise.all([apiFetch('/api/paper/overview',{cache:'no-store'}),apiFetch('/api/paper/reviews',{cache:'no-store'})]);const x=await a.json(),y=await b.json();if(!a.ok)throw new Error(x.error||'Paper overview unavailable');setData(x);if(b.ok)setReviews(y.reviews||[]);setError('');}
  catch(e){setError(e.message||'Paper trading service unavailable.');}
 },[]);
 const action=useCallback(async(kind)=>{
  setBusy(kind);setError('');setNotice('');
  try{const path=kind==='cycle'?'/api/paper/cycle':'/api/paper/daily-review';const r=await apiFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:'BTCUSDT'})});const p=await r.json();if(!r.ok)throw new Error(p.error||'Paper operation failed');setNotice(kind==='cycle'?('Cycle complete · '+(p.opened?.length||0)+' entries · '+(p.closed?.length||0)+' exits'):'Daily performance review saved.');await load();}
  catch(e){setError(e.message||'Paper operation failed.');}
  finally{setBusy('');}
 },[load]);
 useEffect(()=>{load();const timer=setInterval(load,30000);return()=>clearInterval(timer);},[load]);
 const agents=data?.agents||[],totalTrades=agents.reduce((s,a)=>s+a.metrics.closedTrades,0),totalPnl=agents.reduce((s,a)=>s+a.metrics.netPnlUsd,0);
 return <section className="glass-panel detail-workspace paper-workspace">
  <header className="section-heading ops-title"><div><span className="eyebrow">AUTONOMOUS AGENT FLEET · LIVE DATA / SIMULATED EXECUTION</span><h3>Paper Trading Command Center</h3><p>Agents monitor Bitget USDT perpetual markets, simulate entries and exits, measure costs and compete under independent virtual ledgers.</p></div><span className="paper-chip"><Lock size={13}/> PAPER ONLY · LIVE ORDERS DISABLED</span></header>
  <div className="paper-safety"><ShieldCheck/><div><b>Hard exchange boundary</b><span>Market data is real. Every order, balance, fee and fill shown here is simulated. The paper service has no exchange order-submission capability.</span></div></div>
  <div className="paper-actions"><button className="refresh-button" onClick={()=>action('cycle')} disabled={!!busy}><PlayCircle size={15}/>{busy==='cycle'?'Running paper cycle…':'Run paper cycle now'}</button><button className="small-refresh" onClick={()=>action('review')} disabled={!!busy}><CalendarClock size={14}/>{busy==='review'?'Reviewing…':'Run daily review'}</button><button className="small-refresh" onClick={load} disabled={!!busy}><RefreshCw size={14}/>Refresh</button></div>
  {error&&<p className="quote-error">{error}</p>}{notice&&<p className="paper-notice">{notice}</p>}
  <div className="paper-kpi-grid">
   <div><span>VIRTUAL NET P&L</span><b>{money(totalPnl)}</b></div><div><span>CLOSED PAPER TRADES</span><b>{totalTrades.toLocaleString()}</b></div><div><span>ACTIVE AGENTS</span><b>{agents.length}</b></div><div><span>PRO TIER AGENTS</span><b>{agents.filter(a=>a.tier==='PRO').length}</b></div>
  </div>
  <div className="paper-policy"><div><b>98% win-rate target</b><span>Promotion target only. No profit or win-rate is guaranteed.</span></div><div><b>Capital protection</b><span>0.25% risk/trade · 2% daily loss stop · 5% max drawdown · 1x virtual leverage.</span></div><div><b>Promotion gates</b><span>200 trades · 90 days · PF 1.5 · expectancy 0.15R · Sharpe 0.8 · out-of-sample and regime coverage.</span></div></div>
  <div className="section-heading"><div><h4>Agent performance league</h4><p className="subtle-note">Promotion is automatic only after every gate passes. Missing evidence keeps the agent in research tier.</p></div></div>
  <div className="paper-agent-list">{agents.map(agent=><article className="paper-agent-card" key={agent.id}>
   <div className="paper-agent-heading"><div><span className="eyebrow">{agent.id.toUpperCase()} · {agent.tier} TIER</span><h4>{agent.name}</h4><p>{agent.edge}</p></div><span className={agent.tier==='PRO'?'paper-tier pro':'paper-tier'}>{agent.tier==='PRO'?<Award size={13}/>:<Activity size={13}/>} {agent.tier}</span></div>
   <div className="paper-agent-stats"><div><span>WIN RATE</span><b>{pct(agent.metrics.winRatePct)}</b></div><div><span>NET P&L</span><b>{money(agent.metrics.netPnlUsd)}</b></div><div><span>PROFIT FACTOR</span><b>{Number(agent.metrics.profitFactor||0).toFixed(2)}</b></div><div><span>MAX DRAWDOWN</span><b>{pct(agent.metrics.maxDrawdownPct)}</b></div><div><span>EXPECTANCY</span><b>{Number(agent.metrics.expectancyR||0).toFixed(3)}R</b></div><div><span>TRADES / DAYS</span><b>{agent.metrics.closedTrades} / {Math.floor(agent.metrics.observationDays)}</b></div></div>
   <div className="paper-gates"><b>{agent.kpi.eligibleForPromotion?'All KPI gates passed':'Promotion requirements'}</b><span>{agent.kpi.checks.filter(c=>!c.pass).map(c=>c.id).join(' · ')||'Ready for automatic paper-tier upgrade'}</span></div>
   <details><summary>View all KPI checks and resources</summary><div className="paper-checks">{agent.kpi.checks.map(c=><span key={c.id} className={c.pass?'pass':'fail'}>{c.pass?'✓':'○'} {c.id}: {Array.isArray(c.actual)?'coverage':Number(c.actual||0).toFixed(2)} / {c.target}</span>)}</div><p className="subtle-note">Resources: {agent.resources.join(' · ')}</p><p className="subtle-note">Open paper positions: {agent.openTrades.length} · Last promotion: {stamp(agent.promotedAt)}</p></details>
  </article>)}</div>
  <div className="section-heading"><div><h4>Open simulated positions</h4><p className="subtle-note">Mark-to-market exit checks run during each scheduler cycle.</p></div></div>
  {data?.openTrades?.length?<div className="scanner-table paper-table"><div><span>AGENT</span><span>MARKET / SIDE</span><span>ENTRY</span><span>STOP / TARGET</span><span>RISK</span></div>{data.openTrades.map(t=><div key={t.trade_id}><b>{t.agentName}</b><span>{t.symbol} · {t.direction}</span><span>{money(t.entry_price)}</span><span>{money(t.stop_price)} / {money(t.target_price)}</span><span>{money(t.risk_usd)}</span></div>)}</div>:<p className="subtle-note">No open simulated positions.</p>}
  <div className="section-heading"><div><h4>Daily performance reviews</h4><p className="subtle-note">UTC daily snapshots of agent KPIs, capital protection and data quality.</p></div></div>
  {reviews.length?reviews.map(r=><details className="paper-review" key={r.date}><summary>{r.date} · {r.agents?.length||0} agents reviewed</summary><p>{r.dataQuality}</p>{r.agents?.map(a=><span key={a.agentId}>{a.name}: {pct(a.metrics.winRatePct)} win rate · {money(a.metrics.netPnlUsd)} · {a.kpi.status}</span>)}</details>):<p className="subtle-note">No daily review stored yet. The scheduler creates one at 00:05 UTC; you can also run one now.</p>}
  <p className="paper-footnote"><AlertTriangle size={13}/> Simulated performance is not evidence of future returns. Paper fills approximate fees, spread and slippage; real fills can differ materially. Last dashboard refresh: {stamp(data?.updatedAt)}.</p>
 </section>;
}
