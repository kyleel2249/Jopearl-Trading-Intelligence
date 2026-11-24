import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownUp, RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import './PairScanner.css';

const money = value => Number.isFinite(Number(value)) ? '$' + Number(value).toLocaleString(undefined,{maximumFractionDigits:0}) : '—';
const px = value => Number.isFinite(Number(value)) ? '$' + Number(value).toLocaleString(undefined,{maximumFractionDigits:10}) : '—';
const percent = value => Number.isFinite(Number(value)) ? (Number(value)>0?'+':'')+Number(value).toFixed(2)+'%' : '—';
const funding = value => Number.isFinite(Number(value)) ? (Number(value)>0?'+':'')+(Number(value)*100).toFixed(4)+'%' : '—';

export default function PairScanner(){
 const [data,setData]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
 const [range,setRange]=useState('20'),[minimum,setMinimum]=useState('50000'),[sort,setSort]=useState('turnover');
 const [query,setQuery]=useState(''),[timeframe,setTimeframe]=useState('1h');
 const load=useCallback(async()=>{
  setLoading(true);setError('');
  try{
   const response=await fetch('/api/market/pair-scanner?rangePct='+encodeURIComponent(range)+'&minTurnover='+encodeURIComponent(minimum)+'&timeframe='+encodeURIComponent(timeframe),{cache:'no-store'});
   const payload=await response.json();
   if(!response.ok)throw new Error(payload.error||'Bitget pair scan failed');
   setData(payload);
  }catch(e){setError(e.message||'Unable to load pair scanner');}
  finally{setLoading(false);}
 },[range,minimum,timeframe]);
 useEffect(()=>{load();},[load]);
 const rows=useMemo(()=>{
  const filtered=(data?.pairs||[]).filter(row=>row.symbol.toLowerCase().includes(query.trim().toLowerCase()));
  return filtered.sort((a,b)=>sort==='price'?a.distancePct-b.distancePct:sort==='spread'?a.spreadPct-b.spreadPct:sort==='funding'?Math.abs(a.fundingRate||0)-Math.abs(b.fundingRate||0):b.turnover24h-a.turnover24h);
 },[data,query,sort]);
 const inverse=(data?.correlations||[]).filter(item=>item.correlation<=-0.35).sort((a,b)=>a.correlation-b.correlation);
 const positive=(data?.correlations||[]).filter(item=>item.correlation>=0.65).sort((a,b)=>b.correlation-a.correlation);
 return <main className="jpti-pair-scanner">
  <section className="ps-hero"><div><span className="ps-eyebrow"><Activity size={14}/> BITGET · USDT-M PERPETUALS</span><h2>SOPH Alternative Pair Scanner</h2><p>Find similarly priced contracts, compare real execution conditions and measure return correlation against SOPH. A similar token price does not imply similar risk or market behaviour.</p></div><button onClick={load} disabled={loading}><RefreshCw size={15}/>{loading?'Scanning…':'Refresh scan'}</button></section>
  <section className="ps-controls">
   <label>Price distance from SOPH<select value={range} onChange={e=>setRange(e.target.value)}><option value="10">±10%</option><option value="20">±20%</option><option value="40">±40%</option><option value="100">±100%</option></select></label>
   <label>Minimum 24h turnover<select value={minimum} onChange={e=>setMinimum(e.target.value)}><option value="0">Any turnover</option><option value="25000">$25K+</option><option value="50000">$50K+</option><option value="100000">$100K+</option><option value="250000">$250K+</option><option value="500000">$500K+</option></select></label>
   <label>Correlation timeframe<select value={timeframe} onChange={e=>setTimeframe(e.target.value)}><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></label>
   <label>Find pair<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="e.g. ONE, ZIL, RVN"/></label>
  </section>
  {error&&<div className="ps-alert"><AlertTriangle size={17}/>{error}</div>}
  {data&&<><section className="ps-metrics">
   <div><small>SOPH REFERENCE</small><b>{px(data.reference.price)}</b><span>{percent(data.reference.change24h)} · {data.reference.symbol}</span></div>
   <div><small>QUALIFYING CONTRACTS</small><b>{data.pairs.length}</b><span>After price and turnover filters</span></div>
   <div><small>INVERSE CORRELATIONS</small><b>{inverse.length}</b><span>At or below −0.35</span></div>
   <div><small>RETURN OBSERVATIONS</small><b>{data.correlationMeta?.observations||0}</b><span>{data.correlationMeta?.timeframe||timeframe} matched intervals</span></div>
  </section>
  <section className="ps-panel"><div className="ps-heading"><div><span className="ps-eyebrow">LIVE CONTRACT UNIVERSE</span><h3>Price and execution quality</h3></div><label>Sort by<select value={sort} onChange={e=>setSort(e.target.value)}><option value="turnover">Turnover</option><option value="price">Closest price</option><option value="spread">Tightest spread</option><option value="funding">Funding magnitude</option></select></label></div>
   <div className="ps-table-wrap"><table><thead><tr><th>PAIR</th><th>LAST</th><th>VS SOPH</th><th>24H CHANGE</th><th>24H TURNOVER</th><th>SPREAD</th><th>OPEN INTEREST</th><th>FUNDING</th><th>MAX LEV.</th></tr></thead><tbody>
   {rows.map(row=><tr key={row.symbol}><td><b>{row.symbol.replace('USDT','/USDT')}</b>{row.symbol==='SOPHUSDT'&&<small>REFERENCE</small>}</td><td>{px(row.price)}</td><td>{percent(row.distancePct)}</td><td className={row.change24h>=0?'ps-up':'ps-down'}>{percent(row.change24h)}</td><td>{money(row.turnover24h)}</td><td>{row.spreadPct==null?'—':row.spreadPct.toFixed(3)+'%'}</td><td>{money(row.openInterestUsd)}</td><td>{funding(row.fundingRate)}</td><td>{row.maxLeverage?row.maxLeverage+'x':'—'}</td></tr>)}
   {!rows.length&&<tr><td colSpan="9">No contracts match the selected filters.</td></tr>}
   </tbody></table></div><p className="ps-footnote">Funding values are current snapshots; settlement intervals are shown below. Spread is calculated from best bid/ask. OI is valued in USDT. Values can change quickly.</p>
  </section>
  <section className="ps-correlation-grid">
   <div className="ps-panel"><span className="ps-eyebrow"><ArrowDownUp size={13}/> OPPOSITE-MOVEMENT CANDIDATES</span><h3>Negative correlation to SOPH</h3><p>These pairs had returns moving in opposite directions over the sampled matched candles. This is historical co-movement, not a reliable hedge or a prediction.</p>
    {inverse.length?inverse.map(item=><div className="ps-correlation-row" key={item.symbol}><b>{item.symbol.replace('USDT','/USDT')}</b><strong className="ps-down">{item.correlation.toFixed(3)}</strong><span>{item.observations} returns</span></div>):<p className="ps-empty">No qualifying negative correlations in this sample.</p>}
   </div>
   <div className="ps-panel"><span className="ps-eyebrow">SOPH CO-MOVEMENT</span><h3>Strong positive correlation</h3><p>Pairs in this group moved in a similar direction in the same sample.</p>
    {positive.length?positive.map(item=><div className="ps-correlation-row" key={item.symbol}><b>{item.symbol.replace('USDT','/USDT')}</b><strong className="ps-up">{item.correlation.toFixed(3)}</strong><span>{item.observations} returns</span></div>):<p className="ps-empty">No strong positive correlations in this sample.</p>}
   </div>
  </section>
  <section className="ps-panel"><span className="ps-eyebrow"><SlidersHorizontal size={13}/> CONTRACT SPECIFICATIONS</span><h3>Trading constraints</h3><div className="ps-table-wrap"><table><thead><tr><th>PAIR</th><th>STATUS</th><th>MAX LEVERAGE</th><th>MIN ORDER</th><th>FUNDING INTERVAL</th><th>MAKER FEE</th><th>TAKER FEE</th></tr></thead><tbody>{(data.pairs||[]).map(row=><tr key={row.symbol}><td>{row.symbol}</td><td>{row.status||'—'}</td><td>{row.maxLeverage?row.maxLeverage+'x':'—'}</td><td>{row.minOrderAmount||'—'}</td><td>{row.fundingInterval?row.fundingInterval+'h':'—'}</td><td>{row.makerFeeRate==null?'—':(Number(row.makerFeeRate)*100).toFixed(3)+'%'}</td><td>{row.takerFeeRate==null?'—':(Number(row.takerFeeRate)*100).toFixed(3)+'%'}</td></tr>)}</tbody></table></div>
   <p className="ps-footnote">Exchange maximum leverage is a ceiling, not a recommended setting. Actual leverage, margin tiers, fees and order minimums depend on account and contract settings.</p>
  </section>
  <p className="ps-footnote">Snapshot generated {new Date(data.generatedAt).toLocaleString()} · source: Bitget public USDT-FUTURES market endpoints. {data.caveats?.join(' ')}</p>
 </>}
 </main>;
}
