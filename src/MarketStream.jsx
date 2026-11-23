import React,{useEffect,useState}from'react';
import{apiUrl}from'./lib/api.js';
export default function MarketStream(){
 const[exchange,setExchange]=useState('binance'),[symbol,setSymbol]=useState('BTC/USDT'),[intervalMs,setIntervalMs]=useState('5000'),[enabled,setEnabled]=useState(false),[quote,setQuote]=useState(null),[status,setStatus]=useState('disconnected'),[error,setError]=useState('');
 useEffect(()=>{if(!enabled)return;const query=new URLSearchParams({exchange,symbol,intervalMs});const source=new EventSource(apiUrl('/api/stream/market?'+query));setStatus('connecting');setError('');
  source.addEventListener('status',e=>{try{setStatus(JSON.parse(e.data).status);}catch{}});
  source.addEventListener('quote',e=>{try{setQuote(JSON.parse(e.data));setStatus('connected');}catch{}});
  source.addEventListener('warning',e=>{try{setError(JSON.parse(e.data).message);}catch{}});
  source.addEventListener('error',e=>{if(e.data){try{setError(JSON.parse(e.data).message);}catch{}}setStatus('reconnecting');});
  source.onerror=()=>setStatus('reconnecting');
  return()=>{source.close();setStatus('disconnected');};
 },[enabled,exchange,symbol,intervalMs]);
 return <section className="glass-panel detail-workspace"><span className="eyebrow">PHASE 15 · REAL-TIME TRANSPORT GATEWAY</span><h3>Live market stream monitor</h3>
  <p>Server-sent event delivery with native public ticker WebSockets for Binance, Bybit, OKX and Bitget, plus bounded CCXT REST fallback, per-client cleanup and stale-quote flags. Full order-book delta streaming is not included.</p>
  <div className="news-search"><select value={exchange} onChange={e=>setExchange(e.target.value)}><option>binance</option><option>bybit</option><option>okx</option><option>bitget</option></select><input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="BASE/QUOTE"/><select value={intervalMs} onChange={e=>setIntervalMs(e.target.value)}><option value="3000">3 seconds</option><option value="5000">5 seconds</option><option value="10000">10 seconds</option><option value="30000">30 seconds</option></select><button onClick={()=>setEnabled(v=>!v)}>{enabled?'Stop stream':'Start stream'}</button></div>
  <div className="quote-consensus-stats"><div><span>CONNECTION</span><b>{status.toUpperCase()}</b></div><div><span>LAST PRICE</span><b>{quote?.last==null?'—':Number(quote.last).toLocaleString()}</b></div><div><span>BID / ASK</span><b>{quote?.bid??'—'} / {quote?.ask??'—'}</b></div><div><span>QUOTE QUALITY</span><b>{quote?quote.stale?'STALE':'FRESH':'—'}</b></div></div>
  {quote&&<p className="subtle-note">Received {new Date(quote.receivedAt).toLocaleTimeString()} · Source timestamp {quote.observedAt||'not supplied'} · {quote.transport}</p>}
  {error&&<p className="quote-error">{error}</p>}
  <p className="subtle-note">The stream endpoint is capped at 25 concurrent clients by default. Native public ticker adapters are enabled for Binance, Bybit, OKX and Bitget; other CCXT venues use REST fallback.</p>
 </section>;
}
