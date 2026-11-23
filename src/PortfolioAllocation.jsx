import React,{useState}from'react';
import{apiFetch}from'./lib/api.js';
export default function PortfolioAllocation(){
 const[token,setToken]=useState(''),[payload,setPayload]=useState(''),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function calculate(){setBusy(true);setError('');try{let body;try{body=JSON.parse(payload);}catch{throw new Error('Provide valid JSON containing assets and aligned returns.');}const r=await apiFetch('/api/portfolio/allocation/risk-parity',{method:'POST',headers:{'Content-Type':'application/json','x-jpti-api-token':token},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Risk parity calculation failed');setResult(d);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="glass-panel detail-workspace">
  <span className="eyebrow">PHASE 14 · PORTFOLIO CONSTRUCTION</span><h3>Covariance-aware risk parity</h3>
  <p>Calculate long-only equal-risk-contribution weights from aligned historical return observations. Keep each calculation within one quote currency; no FX conversions or order placement are performed.</p>
  <div className="news-search"><input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token"/><button onClick={calculate} disabled={busy||!token||!payload.trim()}>{busy?'Calculating…':'Calculate and persist allocation'}</button></div>
  <label className="eyebrow">ALLOCATION INPUT JSON</label>
  <textarea rows={12} value={payload} onChange={e=>setPayload(e.target.value)} spellCheck={false} placeholder={JSON.stringify({periodsPerYear:252,assets:[{symbol:'BTC/USDT',quoteCurrency:'USDT',returns:[]},{symbol:'ETH/USDT',quoteCurrency:'USDT',returns:[]}]},null,2)}/>
  {error&&<p className="quote-error">{error}</p>}
  {result&&<>
   <div className="quote-consensus-stats"><div><span>QUOTE CURRENCY</span><b>{result.quoteCurrency}</b></div><div><span>ANNUALIZED VOLATILITY</span><b>{result.annualizedVolatilityPercent.toFixed(2)}%</b></div><div><span>DIVERSIFICATION RATIO</span><b>{result.diversificationRatio.toFixed(3)}</b></div><div><span>EFFECTIVE POSITIONS</span><b>{result.concentration.effectivePositions.toFixed(2)}</b></div></div>
   <div className="scanner-table"><div><span>INSTRUMENT</span><span>ALLOCATION</span><span>RISK CONTRIBUTION</span><span>ASSET VOLATILITY</span></div>{result.weights.map(x=><div key={x.symbol}><b>{x.symbol}</b><strong>{x.weightPercent.toFixed(2)}%</strong><span>{x.riskContributionPercent?.toFixed(2)??'—'}%</span><span>{(x.assetVolatilityPerPeriod*100).toFixed(3)}% / period</span></div>)}</div>
   <p className="subtle-note">{result.method} · {result.observations} aligned observations · {result.iterations} iterations · persisted {String(result.persisted)}.</p>
   <p className="quote-error">Execution authorized: NO · Orders created: 0</p>
   <p className="subtle-note">{result.limitations.join(' ')}</p>
  </>}
 </section>;
}
