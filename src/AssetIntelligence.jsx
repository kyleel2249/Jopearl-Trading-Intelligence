import React,{useCallback,useEffect,useState}from'react';
import{apiFetch}from'./lib/api.js';

const fmt=v=>v==null?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:8});
const CLASSES=[['all','All supported markets'],['crypto_spot','Crypto spot'],['crypto_perpetual','Perpetual swaps'],['crypto_future','Dated futures'],['crypto_option','Options'],['margin','Margin markets']];
export default function AssetIntelligence(){
 const[exchanges,setExchanges]=useState('binance,bybit,okx,bitget'),[assetClass,setAssetClass]=useState('all'),[search,setSearch]=useState('BTC'),[limit,setLimit]=useState('200');
 const[data,setData]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const load=useCallback(async()=>{setLoading(true);setError('');try{const q=new URLSearchParams({exchanges,assetClass,search,limit});const r=await apiFetch('/api/assets/universe?'+q,{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Asset universe unavailable');setData(d);}catch(e){setError(e.message);}finally{setLoading(false);}},[exchanges,assetClass,search,limit]);
 useEffect(()=>{load();},[load]);
 return <section className="glass-panel detail-workspace">
  <span className="eyebrow">PHASE 12 · UNIVERSAL INSTRUMENT INTELLIGENCE</span><h3>Cross-asset instrument universe</h3>
  <p>Normalized market metadata from selected CCXT venues. This is an exchange catalog, not a guarantee that a market is liquid, available to your account or eligible in your jurisdiction.</p>
  <div className="news-search">
   <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search symbol, base, quote or settlement"/>
   <select value={assetClass} onChange={e=>setAssetClass(e.target.value)}>{CLASSES.map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
   <input value={exchanges} onChange={e=>setExchanges(e.target.value)} placeholder="Exchange IDs, comma-separated"/>
   <input type="number" min="1" max="500" value={limit} onChange={e=>setLimit(e.target.value)} aria-label="Maximum instruments"/>
   <button onClick={load} disabled={loading}>{loading?'Discovering…':'Refresh universe'}</button>
  </div>
  {error&&<p className="quote-error">{error}</p>}
  {data&&<>
   <div className="quote-consensus-stats">
    <div><span>MARKETS MATCHED</span><b>{fmt(data.totalMarkets)}</b></div>
    <div><span>VENUES RESPONDED</span><b>{fmt(data.respondingExchanges)} / {fmt(data.requestedExchanges)}</b></div>
    <div><span>SUPPORTED CCXT VENUES</span><b>{fmt(data.catalog?.supportedExchangeCount)}</b></div>
    <div><span>RESULT WINDOW</span><b>{fmt(data.returnedMarkets?.length)} / {fmt(data.totalMarkets)}</b></div>
   </div>
   {data.failedExchanges?.map(x=><p className="subtle-note" key={x.exchange}>{x.exchange}: {x.error}</p>)}
   <div className="scanner-table">
    <div><span>VENUE / SYMBOL</span><span>ASSET CLASS</span><span>BASE / QUOTE</span><span>SETTLEMENT</span><span>CONTRACT</span></div>
    {(data.returnedMarkets||[]).map(m=><div key={m.id}><b>{m.exchange}<small>{m.symbol}</small></b><span>{m.assetClass.replaceAll('_',' ')}</span><span>{m.base||'—'} / {m.quote||'—'}</span><span>{m.settle||'—'}</span><span>{m.contract?(m.linear?'Linear':m.inverse?'Inverse':'Contract'):'Spot / cash'}<small>{m.active?'Active metadata':'Inactive'}</small></span></div>)}
    {!data.returnedMarkets?.length&&<p className="empty-state">No matching markets were returned by the selected venues.</p>}
   </div>
   <p className="subtle-note">{data.truncated?'Results were capped. Narrow the search or request fewer venues. ':''}{data.sourcePolicy}</p>
  </>}
 </section>;
}
