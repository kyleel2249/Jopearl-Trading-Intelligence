import React,{useCallback,useEffect,useMemo,useState} from 'react';
import {Activity,AlertTriangle,BarChart3,Database,Lock,RefreshCw,ShieldCheck,Target,Users} from 'lucide-react';
import {apiFetch} from './lib/api.js';

const emptyImport={candidates:[]};
const fmt=(value,d=2)=>value==null||!Number.isFinite(Number(value))?'—':Number(value).toFixed(d);
const venueNames={bitget:'Bitget',bybit:'Bybit',binance:'Binance'};
const marketNames={spot:'Spot',usdt_perpetual:'USDT Perpetual',coin_perpetual:'Coin-M Perpetual',usdc_perpetual:'USDC Perpetual'};
export default function MultiExchangeEliteReplication(){
 const [status,setStatus]=useState(null),[ranking,setRanking]=useState(null),[history,setHistory]=useState([]);
 const [token,setToken]=useState(''),[payload,setPayload]=useState(JSON.stringify(emptyImport,null,2));
 const [venue,setVenue]=useState('all'),[market,setMarket]=useState('all'),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const load=useCallback(async()=>{
  setLoading(true);setError('');
  try{
   const response=await apiFetch('/api/multi-exchange-elite',{cache:'no-store'}),meta=await response.json();
   if(!response.ok)throw new Error(meta.error||'Multi-exchange service unavailable.');
   setStatus(meta);
   if(token.trim()){
    const h=await apiFetch('/api/multi-exchange-elite?limit=10',{headers:{'x-jpti-api-token':token},cache:'no-store'}),data=await h.json();
    if(!h.ok)throw new Error(data.error||'Ranking history unavailable.');
    setHistory(data.rankings||[]);
   }else setHistory([]);
  }catch(e){setError(e.message||'Could not load multi-exchange status.');}
  finally{setLoading(false);}
 },[token]);
 useEffect(()=>{load();},[load]);
 const run=async()=>{
  setBusy(true);setError('');setNotice('');
  try{
   const body=JSON.parse(payload);
   const response=await apiFetch('/api/multi-exchange-elite',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':token},body:JSON.stringify(body)});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'Assessment failed.');
   setRanking(data);setNotice('Ranking, shared-memory and risk-review events saved to Cloudflare D1. No orders were placed.');
   await load();
  }catch(e){setError(e instanceof SyntaxError?'Candidate JSON is invalid: '+e.message:e.message||'Could not run assessment.');}
  finally{setBusy(false);}
 };
 const current=ranking||history[0]||null;
 const filtered=useMemo(()=>!current?[]:(current.assessments||[]).filter(x=>(venue==='all'||x.exchange===venue)&&(market==='all'||x.marketType===market)),[current,venue,market]);
 const boardSummary=status?.exchanges||[];
 return <section className="glass-panel detail-workspace">
  <div className="section-heading ops-title"><div><span className="eyebrow">JPTI · MULTI-EXCHANGE ELITE REPLICATION</span><h3>Global elite trader intelligence</h3><p>Separate venue leaderboards, common evidence gates, strategy fingerprints, cross-venue exposure checks and paper-replica research.</p></div><button className="small-refresh" onClick={load} disabled={loading}><RefreshCw size={13}/>{loading?'Checking…':'Refresh'}</button></div>
  <div className="quote-consensus-stats"><div><span>EXCHANGES</span><b>3</b></div><div><span>SPECIALIST AGENTS</span><b>{status?.agents?.length??24}</b></div><div><span>EXECUTION MODE</span><b>PAPER ONLY</b></div><div><span>LIVE ORDER PERMISSION</span><b>LOCKED</b></div></div>
  <div className="ops-grid">{boardSummary.map(item=><article className="ops-card" key={item.name}><div className="ops-card-top"><span className="ops-icon"><Activity size={16}/></span><span className="status-pill warn"><i/>{item.feedConfigured?'feed configured':'manual import only'}</span></div><h4>{item.name}</h4><p>{item.leaderboard}</p><div className="subtle-note">Markets: {item.markets.map(x=>marketNames[x]||x).join(' · ')}</div><div className="subtle-note">Copy trading: {item.privateCopyTrading} · Live execution: disabled</div></article>)}</div>
  <div className="risk-list">
   <p><ShieldCheck/><span><b>Common capital-protection policy.</b><br/>At least 100 trades, 90 days of history, positive 90-day ROI, maximum 25% drawdown, at least three actual rolling windows, valid metric ranges and operator source attestation.</span></p>
   <p><AlertTriangle/><span><b>Public data access is not assumed.</b><br/>Bybit and Binance profile metrics must come from supported official exports or approved feed adapters. This release imports records; it does not scrape private trader accounts or fabricate leaderboard entries.</span></p>
   <p><Lock/><span><b>No live copying or order execution.</b><br/>Replica candidates receive zero capital allocation. Exchange credentials, order routes and live permissions are not consumed by this system.</span></p>
  </div>
  <h4>Private JPTI access</h4><input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token · kept in component state only" autoComplete="off"/>
  <div className="section-heading"><div><span className="eyebrow">CANDIDATE INGESTION</span><h4>Import trader performance records</h4></div><span className="subtle-note">Maximum 300 records per run</span></div>
  <p className="subtle-note">Use actual provider-sourced statistics. Include exchange, market type, trader ID, source, retrieval timestamp, total trades, history days and 7d / 30d / 90d / 180d windows. Copier PnL is optional because provider availability differs. Operator attestation is not independent verification.</p>
  <textarea value={payload} onChange={e=>setPayload(e.target.value)} rows={12} spellCheck={false}/>
  <div className="news-search"><button onClick={run} disabled={busy||!token.trim()}>{busy?'Assessing all exchanges…':'Assess, rank & publish intelligence'}</button><button type="button" className="mode" onClick={()=>setPayload(JSON.stringify(emptyImport,null,2))}>Clear import</button></div>
  {error&&<p className="quote-error">{error}</p>}{notice&&<p className="subtle-note">{notice}</p>}
  {current&&<>
   <div className="section-heading ops-title"><div><span className="eyebrow">LATEST RANKING SNAPSHOT</span><h4>{current.eligibleCount??0} eligible · {current.candidateCount??0} assessed · {current.selectedCount??0} research selections</h4></div><span className="status-pill good"><i/>D1 persisted</span></div>
   <div className="quote-consensus-stats"><div><span>BITGET CANDIDATES</span><b>{current.exchangeSummary?.bitget?.candidateCount??0}</b></div><div><span>BYBIT CANDIDATES</span><b>{current.exchangeSummary?.bybit?.candidateCount??0}</b></div><div><span>BINANCE CANDIDATES</span><b>{current.exchangeSummary?.binance?.candidateCount??0}</b></div><div><span>CROSS-VENUE COLLISIONS</span><b>{current.crossExchangeCollisions?.length??0}</b></div></div>
   <div className="news-search"><select value={venue} onChange={e=>setVenue(e.target.value)}><option value="all">All exchanges</option>{Object.entries(venueNames).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select><select value={market} onChange={e=>setMarket(e.target.value)}><option value="all">All market types</option>{Object.entries(marketNames).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></div>
   <div className="scanner-table"><div><span>TRADER / EXCHANGE</span><span>SCORE</span><span>MARKET</span><span>ROI · 90D</span><span>MAX DD</span><span>STATUS</span></div>
    {filtered.slice(0,60).map((t,i)=><div key={t.exchange+':'+t.traderId+':'+i}><b>{t.displayName}<small>{venueNames[t.exchange]||t.exchange} · {t.traderId}</small></b><strong>{fmt(t.score)}</strong><span>{marketNames[t.marketType]||t.marketType}</span><span>{fmt(t.metrics?.roiPct)}%</span><span>{fmt(t.metrics?.maxDrawdownPct)}%</span><span>{t.eligible?'Eligible':'Rejected'}{t.riskFlags?.length?' · '+t.riskFlags.length+' flags':''}</span></div>)}
    {!filtered.length&&<p className="empty-state">No candidate records match these filters.</p>}
   </div>
   <div className="section-heading"><div><span className="eyebrow">CROSS-EXCHANGE EXPOSURE COLLISIONS</span><h4>Duplicate and opposing position exposure</h4></div></div>
   {(current.crossExchangeCollisions||[]).length?<div className="scanner-table"><div><span>TRADER A</span><span>VENUE A</span><span>TRADER B</span><span>VENUE B</span><span>SHARED SYMBOLS</span><span>CLASSIFICATION</span></div>{current.crossExchangeCollisions.slice(0,30).map((x,i)=><div key={i}><b>{x.leftTraderId}</b><span>{x.leftExchange}</span><b>{x.rightTraderId}</b><span>{x.rightExchange}</span><span>{x.sharedSymbols.join(', ')}</span><span>{x.classification}</span></div>)}</div>:<p className="subtle-note">No overlapping position evidence was supplied in this ranking snapshot. This is not proof that cross-venue exposure is absent.</p>}
   {current.allocationSimulation&&<>
    <div className="section-heading"><div><span className="eyebrow">CAPITAL ALLOCATION RESEARCH</span><h4>Virtual risk-budget simulation</h4></div></div>
    <div className="quote-consensus-stats"><div><span>VIRTUAL TARGET</span><b>{fmt(current.allocationSimulation.totalTargetPct)}%</b></div><div><span>CASH RESERVE</span><b>{fmt(current.allocationSimulation.cashReservePct)}%</b></div><div><span>MAX / TRADER</span><b>{fmt(current.allocationSimulation.maximumPerTraderPct)}%</b></div><div><span>REAL CAPITAL USED</span><b>0</b></div></div>
    <div className="scanner-table"><div><span>TRADER</span><span>EXCHANGE</span><span>MARKET</span><span>SCORE</span><span>DRAWDOWN</span><span>VIRTUAL TARGET</span></div>{current.allocationSimulation.targets.slice(0,30).map((x,i)=><div key={x.exchange+':'+x.traderId+':'+i}><b>{x.traderId}</b><span>{venueNames[x.exchange]||x.exchange}</span><span>{marketNames[x.marketType]||x.marketType}</span><span>{fmt(x.score)}</span><span>{fmt(x.drawdownPct)}%</span><strong>{fmt(x.targetPct,4)}%</strong></div>)}</div>
    <p className="subtle-note">This is a virtual score-weighted inverse-drawdown research allocation only. It does not reserve funds, create paper orders or authorize live execution.</p>
   </>}
   <div className="section-heading"><div><span className="eyebrow">AGENT OPERATIONS</span><h4>Latest deterministic agent findings</h4></div></div>
   <div className="ops-grid">{(current.agentActivity||[]).map(agent=><article className="ops-card" key={agent.id}><div className="ops-card-top"><span className="ops-icon"><Activity size={15}/></span><b>{agent.id}</b><span className="status-pill warn"><i/>{agent.status}</span></div><h4>{agent.name||agent.id}</h4><p>{agent.finding}</p><span className="subtle-note">Evidence count: {agent.count??0} · permission: none</span></article>)}</div>
   <div className="section-heading"><div><span className="eyebrow">STRATEGY DNA</span><h4>Strategy fingerprint clusters</h4></div></div>
   <div className="ops-grid">{(current.strategyClusters||[]).slice(0,18).map(cluster=><article className="ops-card" key={cluster.fingerprint}><div className="ops-card-top"><span className="ops-icon"><Target size={16}/></span><b>{cluster.count} profile(s)</b></div><p>{cluster.fingerprint}</p></article>)}</div>
   <p className="subtle-note">Ranking scores are normalized research heuristics, not proof that performance is comparable across provider methodologies. Position-collision checks only use supplied position data.</p>
  </>}
  <div className="section-heading"><div><span className="eyebrow">AUTONOMOUS INTELLIGENCE ORGANISATION</span><h4>Cross-exchange and venue specialist agents</h4></div><span className="subtle-note">{status?.agents?.length??24} agents · no order permission</span></div>
  <div className="ops-grid">{(status?.agents||[]).map(agent=><article className="ops-card" key={agent.id}><div className="ops-card-top"><span className="ops-icon"><Users size={15}/></span><b>{agent.id}</b></div><h4>{agent.name}</h4><p>{agent.mandate}</p><span className="subtle-note">{agent.scope} · execution: none</span></article>)}</div>
  <div className="risk-list"><p><Database/> Ranking snapshots, Shared Intelligence Memory events and Risk Command Centre review events are persisted to the existing JPTI D1 event store. They are published as events for downstream consumers; this does not falsely claim that a separate consumer workflow is already running.</p><p><BarChart3/> Strategy fingerprinting, sample-quality checks, rolling-window stability, leverage flags, slippage/funding flags and cross-venue collision checks are active in the assessment engine.</p></div>
 </section>;
}
