import React,{useCallback,useEffect,useMemo,useState}from'react';
import {Activity,RefreshCw,ShieldCheck,AlertTriangle,ArrowUpRight,ArrowDownRight,Minus}from'lucide-react';
import {apiFetch}from'./lib/api.js';
import analyzeIMI from'./institutional-market-intelligence.js';
import {buildOpportunityRadar}from'./opportunity-radar-engine.js';
import './OpportunityRadar.css';

const UNIVERSE=['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT','BNB/USDT','DOGE/USDT','LINK/USDT','SUI/USDT'];
const number=v=>Number.isFinite(Number(v))?Number(v):null;
const fmt=v=>v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:4});
const biasIcon=d=>d==='LONG'?<ArrowUpRight size={14}/>:d==='SHORT'?<ArrowDownRight size={14}/>:<Minus size={14}/>;

export default function OpportunityRadar({exchange='bitget',timeframe='1h'}){
 const [selectedExchange,setSelectedExchange]=useState(exchange),[selectedTimeframe,setSelectedTimeframe]=useState(timeframe);
 const [radar,setRadar]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[lastScan,setLastScan]=useState(null),[minScore,setMinScore]=useState(0),[direction,setDirection]=useState('ALL');
 useEffect(()=>setSelectedExchange(exchange),[exchange]);useEffect(()=>setSelectedTimeframe(timeframe),[timeframe]);
 const scan=useCallback(async()=>{
  setLoading(true);setError('');
  try{
   const results=[];const queue=[...UNIVERSE];const worker=async()=>{while(queue.length){const symbol=queue.shift(),market=symbol.replace('/','-');
    try{
     const urls=['/api/exchanges/'+encodeURIComponent(selectedExchange)+'/ohlcv/'+encodeURIComponent(market)+'?timeframe='+encodeURIComponent(selectedTimeframe)+'&limit=240&type=spot','/api/intelligence/market/'+encodeURIComponent(selectedExchange)+'/'+encodeURIComponent(market)+'/context?timeframe='+encodeURIComponent(selectedTimeframe)+'&type=spot'];
     const responses=await Promise.all(urls.map(url=>apiFetch(url,{cache:'no-store'})));
     const payloads=await Promise.all(responses.map(r=>r.json()));
     if(!responses[0].ok)throw new Error(payloads[0]?.error||'Candle feed unavailable');
     const candles=payloads[0].candles||[],snapshot=analyzeIMI(candles,symbol,selectedTimeframe,responses[1].ok?payloads[1]:null);
     results.push({symbol,candles,snapshot,context:responses[1].ok?payloads[1]:null,source:selectedExchange.toUpperCase(),dataStatus:responses[1].ok?'CANDLES + CONTEXT':'CANDLES ONLY'});
    }catch(e){results.push({symbol,candles:[],snapshot:{status:'insufficient',scores:{},domains:{},evidence:[],conflicts:[]},context:null,dataStatus:'UNAVAILABLE',error:e.message});}
   }};
   await Promise.all(Array.from({length:4},worker));
   const result=buildOpportunityRadar(results);setRadar(result);setLastScan(new Date().toISOString());
  }catch(e){setError(e.message||'Opportunity scan failed.');}
  finally{setLoading(false);}
 },[selectedExchange,selectedTimeframe]);
 useEffect(()=>{scan();const timer=setInterval(scan,90000);return()=>clearInterval(timer);},[scan]);
 const rows=useMemo(()=> (radar?.markets||[]).filter(m=>(m.ranking.score??-1)>=Number(minScore)&&(direction==='ALL'||m.ranking.direction===direction)),[radar,minScore,direction]);
 const correlations=useMemo(()=>[...(radar?.correlations||[])].filter(x=>x.correlation!==null).sort((a,b)=>Math.abs(b.correlation)-Math.abs(a.correlation)).slice(0,12),[radar]);
 return <section className="glass-panel detail-workspace opr-workspace">
  <header className="section-heading ops-title"><div><span className="eyebrow">MULTI-ASSET DISCOVERY · LIVE EXCHANGE DATA</span><h3>Opportunity Radar & Cross-Market Intelligence</h3><p>Ranks a fixed liquid-market universe using explainable candle evidence, available depth context and synchronized return correlations.</p></div><span className="paper-chip"><ShieldCheck size={13}/> RESEARCH ONLY</span></header>
  <div className="opr-toolbar"><label>Venue<select value={selectedExchange} onChange={e=>setSelectedExchange(e.target.value)}><option value="bitget">Bitget</option><option value="binance">Binance</option><option value="bybit">Bybit</option><option value="okx">OKX</option></select></label><label>Timeframe<select value={selectedTimeframe} onChange={e=>setSelectedTimeframe(e.target.value)}><option>15m</option><option>1h</option><option>4h</option><option>1d</option></select></label><label>Minimum score<select value={minScore} onChange={e=>setMinScore(e.target.value)}><option value="0">All</option><option value="50">50+</option><option value="65">65+</option><option value="75">75+</option></select></label><label>Direction<select value={direction} onChange={e=>setDirection(e.target.value)}><option value="ALL">All</option><option value="LONG">Long bias</option><option value="SHORT">Short bias</option><option value="NEUTRAL">Neutral</option></select></label><button type="button" onClick={scan} disabled={loading}><RefreshCw size={14}/>{loading?'Scanning…':'Scan now'}</button></div>
  {error&&<p className="quote-error">{error}</p>}
  <div className="opr-summary"><article><small>MARKETS SCANNED</small><b>{radar?.summary.scanned??0}</b></article><article><small>HIGH PRIORITY</small><b>{radar?.summary.highPriority??0}</b></article><article><small>WATCHLIST</small><b>{radar?.summary.watch??0}</b></article><article><small>DATA GAPS</small><b>{radar?.summary.insufficient??UNIVERSE.length}</b></article></div>
  <h4>Ranked opportunities</h4><div className="opr-market-list">{rows.map((m,i)=><article key={m.symbol}><div className="opr-market-head"><span className="opr-rank">#{i+1}</span><b>{m.symbol}</b><span className={'opr-state '+m.ranking.status.toLowerCase().replaceAll('_','-')}>{m.ranking.status.replaceAll('_',' ')}</span><span className="opr-score">{m.ranking.score??'—'}<small>/100</small></span></div><div className="opr-market-meta"><span>{biasIcon(m.ranking.direction)} {m.ranking.direction}</span><span>{m.ranking.regime||'Unknown regime'}</span><span>Confluence {fmt(m.ranking.confluencePercent)}%</span><span>{m.dataStatus}</span></div><p>{(m.ranking.reasons||[]).join(' ')}</p>{m.ranking.riskFlags?.length>0&&<div className="opr-flags">{m.ranking.riskFlags.map(flag=><span key={flag}><AlertTriangle size={11}/>{flag.replaceAll('_',' ')}</span>)}</div>}{m.error&&<p className="quote-error">{m.error}</p>}</article>)}{!rows.length&&<p className="subtle-note">No markets match the selected filters. Lower the minimum score or scan again.</p>}</div>
  <h4>Cross-market return correlation</h4><p className="subtle-note">Pearson correlation of timestamp-aligned candle log returns. Positive values move together; negative values move in opposite directions. Correlation is timeframe-dependent and can change quickly.</p>
  <div className="opr-correlation-list">{correlations.map(c=><article key={c.left+'|'+c.right}><b>{c.left} · {c.right}</b><strong className={c.correlation<0?'down':'up'}>{c.correlation>0?'+':''}{c.correlation.toFixed(3)}</strong><span>{c.observations} aligned returns</span><i style={{width:Math.abs(c.correlation)*100+'%'}}/></article>)}{!correlations.length&&<p className="subtle-note">At least 20 synchronized return observations are needed for each pair.</p>}</div>
  <div className="opr-method"><Activity size={14}/><span>{radar?.methodology||'Waiting for first scan.'} {radar?.limitations?.join(' ')}</span></div>
  <p className="subtle-note">Last scan: {lastScan?new Date(lastScan).toLocaleString():'Awaiting data'} · Auto-refresh every 90 seconds · No order submission or trade authorization.</p>
 </section>;
}
