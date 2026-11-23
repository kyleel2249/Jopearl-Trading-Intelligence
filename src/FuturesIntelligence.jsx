import React,{useCallback,useEffect,useState} from 'react';
import {apiFetch} from './lib/api.js';
import FuturesPaperDesk from './FuturesPaperDesk.jsx';

const DEFAULT_VENUES='all';
const number=value=>value==null||!Number.isFinite(Number(value))?'—':Number(value).toLocaleString(undefined,{maximumFractionDigits:8});
const pct=value=>value==null?'—':Number(value).toFixed(3)+'%';
export default function FuturesIntelligence(){
 const [symbol,setSymbol]=useState('BTC/USDT:USDT'),[kind,setKind]=useState('perpetual'),[venues,setVenues]=useState(DEFAULT_VENUES),[amount,setAmount]=useState('0.01'),[fee,setFee]=useState('6');
 const [catalog,setCatalog]=useState(null),[data,setData]=useState(null),[funding,setFunding]=useState(null),[universe,setUniverse]=useState(null),[universeBusy,setUniverseBusy]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[auto,setAuto]=useState(true),[updated,setUpdated]=useState(null);
 const discover=useCallback(async()=>{setUniverseBusy(true);setError('');try{const base=symbol.split('/')[0].split(':')[0];const q=new URLSearchParams({kind,search:base||'',limit:'500'});const r=await apiFetch('/api/futures/universe?'+q,{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Contract discovery failed');setUniverse(d);}catch(e){setError(e.message);}finally{setUniverseBusy(false);}},[symbol,kind]);
 const load=useCallback(async()=>{
  setBusy(true);setError('');
  try{
   const params=new URLSearchParams({symbol,kind,exchanges:venues,depth:'20',amount,takerFeeBps:fee});
   const comparison=await apiFetch('/api/futures/compare?'+params,{cache:'no-store'});
   const a=await comparison.json();
   if(!comparison.ok)throw new Error(a.error||'Futures comparison failed');
   setData(a);setFunding({funding:(a.venues||[]).filter(v=>v.status==='ok').map(v=>({exchange:v.exchange,symbol:v.symbol,rate:v.funding?.rate,intervalHours:v.funding?.intervalHours,nextFundingAt:v.funding?.nextFundingAt}))});setUpdated(new Date());
  }catch(e){setError(e.message);}finally{setBusy(false);}
 },[symbol,kind,venues,amount,fee]);
 useEffect(()=>{apiFetch('/api/futures/catalog',{cache:'no-store'}).then(r=>r.json()).then(setCatalog).catch(()=>setCatalog(null));},[]);
 useEffect(()=>{load();},[load]);
 useEffect(()=>{if(!auto)return;const timer=setInterval(load,venues.trim().toLowerCase()==='all'?60000:15000);return()=>clearInterval(timer);},[auto,load]);
 return <section className="glass-panel detail-workspace">
  <span className="eyebrow">PHASE 11 · MULTI-VENUE DERIVATIVES DATA</span><h3>Universal Futures Cross-Exchange Intelligence</h3>
  <p>Compare compatible perpetual and dated futures contracts across the supported CCXT exchange catalog. Public market data and paper research only; no live futures orders are submitted.</p>
  <div className="news-search">
   <input value={symbol} onChange={e=>setSymbol(e.target.value)} aria-label="Contract symbol" placeholder="BTC/USDT:USDT"/>
   <select value={kind} onChange={e=>setKind(e.target.value)}><option value="perpetual">Perpetual swaps</option><option value="dated">Dated futures</option><option value="any">Any derivative</option></select>
   <input value={venues} onChange={e=>setVenues(e.target.value)} aria-label="Exchange IDs" placeholder="binance,bybit,okx"/>
   <button onClick={load} disabled={busy}>{busy?'Scanning…':'Refresh comparison'}</button><button type="button" onClick={discover} disabled={universeBusy}>{universeBusy?'Discovering…':'Discover contracts'}</button>
  </div>
  <div className="news-search">
   <input type="number" min="0" step="0.0001" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Base amount for depth"/>
   <input type="number" min="0" max="100" step="0.1" value={fee} onChange={e=>setFee(e.target.value)} placeholder="Estimated taker fee bps / side"/>
   <label className="subtle-note"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/> Auto-refresh (15s selected venues · 60s all venues)</label>
   <span className="subtle-note">{updated?'Updated '+updated.toLocaleTimeString():'Awaiting market data'}</span>
  </div>
  {error&&<p className="quote-error">{error}</p>}
  {universe&&<><div className="section-heading"><div><span className="eyebrow">ALL-VENUE CONTRACT DISCOVERY</span><h3>{number(universe.totalContracts)} listed contracts · {universe.respondingExchanges} exchanges responded</h3></div></div><div className="scanner-table"><div><span>EXCHANGE</span><span>CONTRACT</span><span>SETTLEMENT</span><span>STRUCTURE</span><span>TYPE</span></div>{universe.markets.slice(0,30).map((m,i)=><div key={m.exchange+'-'+m.symbol+'-'+i}><b>{m.exchange}</b><span>{m.symbol}</span><span>{m.settle||'—'}</span><span>{m.linear?'Linear':m.inverse?'Inverse':'Other'}</span><span>{m.kind}</span></div>)}</div><p className="subtle-note">{universe.truncated?'Showing first 500 matching contracts. ':''}{universe.note}</p></>}
  <div className="quote-consensus-stats">
   <div><span>MEDIAN LAST PRICE</span><b>{number(data?.priceConsensus?.medianLast)}</b></div>
   <div><span>MEDIAN MARK PRICE</span><b>{number(data?.priceConsensus?.medianMark)}</b></div>
   <div><span>MEDIAN INDEX PRICE</span><b>{number(data?.priceConsensus?.medianIndex)}</b></div>
   <div><span>LAST-PRICE DISPERSION</span><b>{data?.priceConsensus?.lastSpreadBps==null?'—':number(data.priceConsensus.lastSpreadBps)+' bps'}</b></div>
  </div>
  <div className="section-heading"><div><span className="eyebrow">VENUE MICROSTRUCTURE</span><h3>Contract price matrix</h3></div><span className="live-tag">{data?.venueCount??0} VENUES RESPONDED</span></div>
  <div className="scanner-table"><div><span>EXCHANGE / CONTRACT</span><span>LAST / MARK / INDEX</span><span>BID / ASK</span><span>FUNDING</span><span>STATUS</span></div>
   {(data?.venues||[]).map(v=><div key={v.exchange}><b>{v.exchange}<small>{v.symbol||v.reason||''}</small></b><span>{number(v.prices?.last)}<small>M {number(v.prices?.mark)} · I {number(v.prices?.index)}</small></span><span>{number(v.prices?.bid)} / {number(v.prices?.ask)}<small>Spread {number(v.book?.spreadBps)} bps</small></span><span>{v.funding?.rate==null?'—':(v.funding.rate*100).toFixed(5)+'%'}<small>{v.funding?.intervalHours? v.funding.intervalHours+'h interval':''}</small></span><Status status={v.status}/></div>)}
   {!data?.venues?.length&&<p className="empty-state">No exchange observations yet. Check gateway availability and selected venue market coverage.</p>}
  </div>
  <div className="section-heading"><div><span className="eyebrow">CROSS-VENUE EXECUTION ESTIMATE</span><h3>Net spread opportunities</h3></div></div>
  <p className="subtle-note">Estimated net edge deducts two taker fees. Depth-weighted average prices are used when requested amount and book data are available. Funding is excluded from this calculation.</p>
  <div className="scanner-table"><div><span>BUY VENUE</span><span>SELL VENUE</span><span>BUY / SELL AVG</span><span>GROSS / NET BPS</span><span>DEPTH ASSESSMENT</span></div>
   {(data?.opportunities||[]).slice(0,12).map((x,i)=><div key={x.buyExchange+'-'+x.sellExchange}><b>{x.buyExchange}</b><b>{x.sellExchange}</b><span>{number(x.buyPrice)} / {number(x.sellPrice)}</span><strong className={x.netEdgeBps>0?'up':'down'}>{number(x.grossEdgeBps)} / {number(x.netEdgeBps)}</strong><span>{x.executableAssessment.replaceAll('_',' ')}</span></div>)}
   {!data?.opportunities?.length&&<p className="empty-state">No comparable two-sided order books are currently available.</p>}
  </div>
  <div className="section-heading"><div><span className="eyebrow">FUNDING RATE DISPERSION</span><h3>Perpetual funding comparison</h3></div></div>
  <div className="scanner-table"><div><span>EXCHANGE</span><span>CONTRACT</span><span>FUNDING RATE</span><span>INTERVAL</span><span>NEXT FUNDING</span></div>
   {(funding?.funding||[]).map(f=><div key={f.exchange}><b>{f.exchange}</b><span>{f.symbol}</span><strong>{f.rate==null?'—':(f.rate*100).toFixed(5)+'%'}</strong><span>{f.intervalHours?f.intervalHours+'h':'—'}</span><span>{f.nextFundingAt?new Date(f.nextFundingAt).toLocaleString():'—'}</span></div>)}
  </div>
  <p className="subtle-note">CCXT catalog: {catalog?.supportedExchangeCount??'—'} supported adapters; {catalog?.derivativeDataCapableCount??'—'} expose relevant public data capabilities. This is not proof that all listed pairs are tradable or liquid on every venue.</p>
  {(data?.safety?.warnings||[]).map(w=><p className="subtle-note" key={w}>• {w}</p>)}
  <FuturesPaperDesk comparison={data} symbol={symbol} kind={kind}/>
 </section>;
}
function Status({status}){return <span className={'status-pill '+(status==='ok'?'good':status==='partial'?'warn':'bad')}><i/>{status}</span>}
