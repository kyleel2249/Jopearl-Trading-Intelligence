import React,{useCallback,useEffect,useState} from 'react';
import { useSessionToken } from './lib/useSessionToken.js';
import {Activity,RefreshCw,ShieldCheck,Users,Target,AlertTriangle,Lock} from 'lucide-react';
import {apiFetch} from './lib/api.js';

const example={candidates:[{traderId:'REPLACE_WITH_REAL_ID',displayName:'Real provider trader',source:'verified-provider-export',sourceAttested:false,sourceUrl:'https://www.bitget.com/copy-trading',retrievedAt:new Date().toISOString(),totalTrades:150,historyDays:120,averageHoldingHours:6,maxLeverage:3,windows:{'7d':{roiPct:1,winRatePct:58,maxDrawdownPct:4,copierPnlUsd:20},'30d':{roiPct:4,winRatePct:60,maxDrawdownPct:7,copierPnlUsd:80},'90d':{roiPct:9,winRatePct:59,maxDrawdownPct:9,copierPnlUsd:180,sharpe:1.2,sortino:1.5,calmar:1.1},'180d':{roiPct:14,winRatePct:58,maxDrawdownPct:11,copierPnlUsd:260}}}]};
const number=(v,d=1)=>v==null?'—':Number(v).toFixed(d);
export default function EliteTraderReplication(){
 const [status,setStatus]=useState(null),[ranking,setRanking]=useState(null),[history,setHistory]=useState([]);
 const [token,setToken]=useSessionToken(),[payload,setPayload]=useState(JSON.stringify(example,null,2));
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const load=useCallback(async()=>{
  setError('');
  try{
   const [s,h]=await Promise.all([apiFetch('/api/elite-traders',{cache:'no-store'}),apiFetch('/api/elite-traders?limit=10',{headers:{'x-jpti-api-token':token},cache:'no-store'})]);
   const sd=await s.json();setStatus(sd);
   if(h.ok){const hd=await h.json();setHistory(hd.rankings||[]);}
   else if(token)setError('Ranking history unavailable: '+((await h.json()).error||h.status));
  }catch(e){setError(e.message||'ETRD service is unavailable.');}
 },[token]);
 useEffect(()=>{load();},[load]);
 const run=async()=>{
  setBusy(true);setError('');setNotice('');
  try{
   const body=JSON.parse(payload);
   const response=await apiFetch('/api/elite-traders',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':token},body:JSON.stringify(body)});
   const data=await response.json();
   if(!response.ok)throw new Error(data.error||'Ranking run failed.');
   setRanking(data);setNotice('Assessment saved to Cloudflare D1. No orders were placed.');
   await load();
  }catch(e){setError(e instanceof SyntaxError?'Candidate JSON is invalid: '+e.message:e.message||'Could not run ETRD.');}
  finally{setBusy(false);}
 };
 const current=ranking||history[0];
 return <section className="glass-panel detail-workspace">
  <div className="section-heading ops-title"><div><span className="eyebrow">ELITE TRADER REPLICATION DIVISION · ETRD</span><h3>Elite trader selection & replica command</h3><p>15 specialist agents assess source quality, performance consistency, copier returns and drawdown before a candidate can enter the paper-replica shortlist.</p></div><button className="small-refresh" onClick={load}><RefreshCw size={13}/> Refresh</button></div>
  <div className="quote-consensus-stats">
   <div><span>AGENT ROSTER</span><b>{status?.agents?.length??15}</b></div><div><span>CORE SELECTION TARGET</span><b>{status?.policy?.coreSelections??10}</b></div><div><span>EXECUTION MODE</span><b>PAPER ONLY</b></div><div><span>LIVE ORDER PERMISSION</span><b>LOCKED</b></div>
  </div>
  <div className="risk-list">
   <p><ShieldCheck/><span><b>Capital protection is the final gate.</b><br/>Minimum sample, 90-day history, positive ROI and copier PnL, fresh source timestamps, 3+ performance windows and drawdown no greater than 25% are required for eligibility.</span></p>
   <p><AlertTriangle/><span><b>Feed connection is not yet configured.</b><br/>This screen accepts verified provider exports. It does not invent Bitget trader rankings or claim provider data is independently verified.</span></p>
   <p><Lock/><span><b>Automatic live trading is disabled.</b><br/>ETRD can rank and save assessments. It cannot place, modify or cancel orders. Continuous refresh still needs a verified feed adapter and Cloudflare scheduled trigger.</span></p>
  </div>
  <h4>Private JPTI access</h4>
  <input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token · held in this screen only" autoComplete="off"/>
  <h4>Candidate feed import · up to 100 records</h4>
  <p className="subtle-note">Paste actual records from an approved data source. Replace the sample schema before running. Do not submit sample metrics as real trader data.</p>
  <textarea value={payload} onChange={e=>setPayload(e.target.value)} rows={15} spellCheck={false}/>
  <div className="news-search"><button onClick={run} disabled={busy||!token.trim()}>{busy?'Scoring candidates…':'Assess and rank candidates'}</button><button type="button" className="mode" onClick={()=>setPayload(JSON.stringify({candidates:[]},null,2))}>Clear sample</button></div>
  {error&&<p className="quote-error">{error}</p>}{notice&&<p className="subtle-note">{notice}</p>}
  {current&&<>
   <div className="section-heading"><div><span className="eyebrow">LATEST ASSESSMENT</span><h4>{current.selectedCount??current.selected?.length??0} eligible paper replicas · {current.candidateCount??0} assessed</h4></div></div>
   <div className="quote-consensus-stats"><div><span>CANDIDATES</span><b>{current.candidateCount??0}</b></div><div><span>ELIGIBLE</span><b>{current.eligibleCount??0}</b></div><div><span>SELECTED</span><b>{current.selectedCount??0}</b></div><div><span>ORDERS CREATED</span><b>0</b></div></div>
   <div className="scanner-table"><div><span>RANK / TRADER</span><span>SCORE</span><span>STYLE</span><span>ROI · 90D</span><span>MAX DD</span><span>COPIER PNL</span></div>
    {(current.assessments||[]).slice(0,30).map((t,i)=><div key={t.traderId||i}><b>{t.rank||'—'} · {t.displayName}</b><strong>{number(t.score,2)}</strong><span>{t.style}</span><span>{number(t.metrics?.roiPct,2)}%</span><span>{number(t.metrics?.maxDrawdownPct,2)}%</span><span>{number(t.metrics?.copierPnlUsd,2)} USD</span></div>)}
   </div>
   <p className="subtle-note">Every selected trader remains a paper-only research candidate. Source claims have not been independently reconciled unless the provenance explicitly says so.</p>
  </>}
  <h4>15-agent specialist roster</h4>
  <div className="ops-grid">{(status?.agents||[]).map(agent=><article className="ops-card" key={agent.id}><div className="ops-card-top"><span className="ops-icon"><Activity size={15}/></span><span className="status-pill warn">Research only</span></div><b>{agent.id} · {agent.name}</b><p>{agent.mandate}</p></article>)}</div>
  <p className="subtle-note">Status: {status?.status?.scheduledMonitoringConfigured?'scheduled monitor configured':'scheduled monitor not configured'} · Storage: {status?.status?.storageConfigured?'D1 detected':'D1 unavailable'} · Feed: {status?.status?.traderFeedConfigured?'configured':'not configured'}.</p>
 </section>;
}
