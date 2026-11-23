import React,{useState}from'react';
import{apiFetch}from'./lib/api.js';
const sample=()=>JSON.stringify({timestamp:new Date().toISOString(),sources:[{id:'manual-observation',status:'ok'}],momentumPct:1.2,timeframeAlignment:.6,relativeVolume:1.5,depthImbalance:.2,fundingRate:.0002,openInterestChangePct:1,liquidityUsd:100000,volatilityPct:3,macroBias:'neutral'},null,2);
export default function ResearchCouncil(){
 const[token,setToken]=useState(''),[symbol,setSymbol]=useState('BTC/USDT'),[assetClass,setAssetClass]=useState('crypto_spot'),[evidence,setEvidence]=useState(sample),[result,setResult]=useState(null),[history,setHistory]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const headers=()=>({'Content-Type':'application/json','x-jpti-api-token':token});
 async function evaluate(){setBusy(true);setError('');try{let parsed;try{parsed=JSON.parse(evidence);}catch{throw new Error('Evidence must be valid JSON.');}const r=await apiFetch('/api/council/evaluate',{method:'POST',headers:headers(),body:JSON.stringify({symbol,assetClass,evidence:parsed})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Council evaluation failed');setResult(d);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function loadHistory(){setBusy(true);setError('');try{const r=await apiFetch('/api/council/history?limit=20',{headers:headers(),cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Council history unavailable');setHistory(d.evaluations||[]);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="glass-panel detail-workspace">
  <span className="eyebrow">PHASE 13 · MULTI-AGENT RESEARCH COUNCIL</span><h3>Explainable specialist council</h3>
  <p>Six independent research specialists evaluate trend, participation, microstructure, derivatives positioning, macro regime and liquidity/volatility risk. Evidence must be timestamped. This is a deterministic research ensemble, not an LLM conversation or autonomous trader.</p>
  <div className="news-search"><input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token"/><input value={symbol} onChange={e=>setSymbol(e.target.value)} placeholder="Instrument symbol"/><select value={assetClass} onChange={e=>setAssetClass(e.target.value)}><option value="crypto_spot">Crypto spot</option><option value="crypto_perpetual">Crypto perpetual</option><option value="crypto_future">Dated future</option><option value="equity">Equity</option><option value="fx">FX</option><option value="commodity">Commodity</option><option value="index">Index</option></select></div>
  <label className="eyebrow">TIMESTAMPED EVIDENCE JSON</label><textarea rows={9} value={evidence} onChange={e=>setEvidence(e.target.value)} spellCheck={false}/>
  <div className="news-search"><button onClick={evaluate} disabled={busy||!token}>{busy?'Evaluating…':'Run research council'}</button><button onClick={loadHistory} disabled={busy||!token}>Load persisted history</button></div>
  {error&&<p className="quote-error">{error}</p>}
  {result&&<>
   <div className="quote-consensus-stats"><div><span>COUNCIL STANCE</span><b>{result.consensus.stance.replaceAll('_',' ')}</b></div><div><span>WEIGHTED SCORE</span><b>{result.consensus.weightedScore??'—'}</b></div><div><span>AGREEMENT</span><b>{(result.consensus.agreementRatio*100).toFixed(1)}%</b></div><div><span>CONFIDENCE</span><b>{(result.consensus.confidence*100).toFixed(1)}%</b></div></div>
   <div className="scanner-table"><div><span>SPECIALIST</span><span>ASSESSMENT</span><span>SCORE</span><span>CONFIDENCE</span><span>REQUIREMENTS</span></div>{result.agents.map(a=><div key={a.id}><b>{a.specialty}<small>{a.id}</small></b><span>{a.status.replaceAll('_',' ')}</span><strong>{a.score??'—'}</strong><span>{(a.confidence*100).toFixed(0)}%</span><span>{a.missingEvidence.join(', ')||'Evidence present'}</span></div>)}</div>
   <p className="subtle-note">Evidence age: {result.evidence.ageMs==null?'unknown':Math.round(result.evidence.ageMs/1000)+'s'} · {result.risk.blocked?'Research gate blocked':'Research gate passed'}. Persisted: {String(result.persisted)}.</p>
   <p className="quote-error">Paper entry eligible: NO · Live execution authorized: NO · Orders created: 0</p>
   <p className="subtle-note">{result.interpretation}</p>
  </>}
  {history.length>0&&<><div className="section-heading"><div><span className="eyebrow">APPEND-ONLY COUNCIL HISTORY</span><h3>{history.length} recent evaluations</h3></div></div><div className="scanner-table">{history.map(h=><div key={h.id}><b>{h.symbol||'Unspecified'}<small>{new Date(h.generatedAt).toLocaleString()}</small></b><span>{h.consensus.stance}</span><strong>{h.consensus.weightedScore??'—'}</strong><span>{(h.consensus.confidence*100).toFixed(1)}%</span><span>Research only</span></div>)}</div></>}
 </section>;
}
