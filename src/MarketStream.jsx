import React,{useEffect,useState}from'react';
import{apiUrl,apiFetch}from'./lib/api.js';

export default function MarketStream(){
 const[exchange,setExchange]=useState('binance'),[symbol,setSymbol]=useState('BTC/USDT'),[intervalMs,setIntervalMs]=useState('5000'),[enabled,setEnabled]=useState(false),[quote,setQuote]=useState(null),[status,setStatus]=useState('disconnected'),[error,setError]=useState('');
 const[replication,setReplication]=useState(null),[replicationError,setReplicationError]=useState('');
 useEffect(()=>{let active=true;const load=async()=>{try{const response=await apiFetch('/api/replication');if(!response.ok)throw new Error('Replication status is unavailable (HTTP '+response.status+').');const body=await response.json();if(active){setReplication(body);setReplicationError('');}}catch(err){if(active)setReplicationError(String(err?.message||err));}};load();const timer=setInterval(load,60000);return()=>{active=false;clearInterval(timer);};},[]);
 useEffect(()=>{if(!enabled)return;const query=new URLSearchParams({exchange,symbol,intervalMs});const source=new EventSource(apiUrl('/api/stream/market?'+query));setStatus('connecting');setError('');
  source.addEventListener('status',e=>{try{setStatus(JSON.parse(e.data).status);}catch{}});
  source.addEventListener('quote',e=>{try{setQuote(JSON.parse(e.data));setStatus('connected');}catch{}});
  source.addEventListener('warning',e=>{try{setError(JSON.parse(e.data).message);}catch{}});
  source.addEventListener('error',e=>{if(e.data){try{setError(JSON.parse(e.data).message);}catch{}}setStatus('reconnecting');});
  source.onerror=()=>setStatus('reconnecting');
  return()=>{source.close();setStatus('disconnected');};
 },[enabled,exchange,symbol,intervalMs]);
 const totals=replication?.totals||{};
 return <div className="detail-workspace">
  <section className="glass-panel"><span className="eyebrow">PHASE 15 · REAL-TIME TRANSPORT GATEWAY</span><h3>Live market stream monitor</h3>
   <p>Server-sent event delivery with native public ticker WebSockets for Binance, Bybit, OKX and Bitget, plus bounded CCXT REST fallback, per-client cleanup and stale-quote flags. Full order-book delta streaming remains separate from this ticker stream.</p>
   <div className="news-search"><select value={exchange} onChange={e=>setExchange(e.target.value)}><option>binance</option><option>bybit</option><option>okx</option><option>bitget</option></select><input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="BASE/QUOTE"/><select value={intervalMs} onChange={e=>setIntervalMs(e.target.value)}><option value="3000">3 seconds</option><option value="5000">5 seconds</option><option value="10000">10 seconds</option><option value="30000">30 seconds</option></select><button onClick={()=>setEnabled(v=>!v)}>{enabled?'Stop stream':'Start stream'}</button></div>
   <div className="quote-consensus-stats"><div><span>CONNECTION</span><b>{status.toUpperCase()}</b></div><div><span>LAST PRICE</span><b>{quote?.last==null?'—':Number(quote.last).toLocaleString()}</b></div><div><span>BID / ASK</span><b>{quote?.bid??'—'} / {quote?.ask??'—'}</b></div><div><span>QUOTE QUALITY</span><b>{quote?quote.stale?'STALE':'FRESH':'—'}</b></div></div>
   {quote&&<p className="subtle-note">Received {new Date(quote.receivedAt).toLocaleTimeString()} · Source timestamp {quote.observedAt||'not supplied'} · {quote.transport}</p>}
   {error&&<p className="quote-error">{error}</p>}
   <p className="subtle-note">The stream endpoint is capped at 25 concurrent clients by default. Native public ticker adapters are enabled for Binance, Bybit, OKX and Bitget; other CCXT venues use REST fallback.</p>
  </section>
  <section className="glass-panel" style={{marginTop:16}}>
   <span className="eyebrow">DURABLE DATA PLANE · CLOUDFLARE D1</span><h3>Continuous replication health</h3>
   <p>Five-minute scheduled acquisition cycles persist validated ticker and OHLCV observations. The chart API can use this history when a live candle request fails.</p>
   <div className="quote-consensus-stats"><div><span>OBSERVATIONS</span><b>{Number(totals.observations||0).toLocaleString()}</b></div><div><span>EXCHANGES</span><b>{totals.exchanges??'—'}</b></div><div><span>SYMBOLS</span><b>{totals.symbols??'—'}</b></div><div><span>LAST RECEIVED</span><b>{totals.last_received_at?new Date(totals.last_received_at).toLocaleTimeString():'—'}</b></div></div>
   {replication?.recentRuns?.length>0&&<div className="dash-market-list">{replication.recentRuns.slice(0,3).map(run=><div key={run.runId}><span><b>{String(run.status||'unknown').toUpperCase()}</b><small>{new Date(run.startedAt).toLocaleString()}</small></span><strong>{Number(run.counts?.inserted||0).toLocaleString()} saved</strong><em>{run.errors?.length?run.errors.length+' issues':'clean'}</em></div>)}</div>}
   {replication?.coverage?.length>0&&<p className="subtle-note">Coverage: {replication.coverage.map(row=>row.exchange+' '+row.market_type+' ('+row.symbols+' symbols)').join(' · ')}</p>}
   {replicationError&&<p className="quote-error">{replicationError}</p>}
   <p className="subtle-note">A missing scheduled run, stale feed or failed category is reported as a coverage gap. Public market replication does not imply exchange-account authentication or trading permission.</p>
  </section>
 </div>;
}
