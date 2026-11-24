import React, { useCallback, useState } from 'react';
import { Activity, BrainCircuit, ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, MessageSquareWarning } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import './AgentCommandCenter.css';

const initial = { symbol:'BTC/USDT', momentumPct:'1.8', timeframeAlignment:'0.8', relativeVolume:'1.6',
  depthImbalance:'0.35', fundingRate:'0.0001', openInterestChangePct:'4', volatilityPct:'2.5',
  liquidityUsd:'250000', correlationBias:'0.2', highImpactEvent:'false' };
const agentNames = { trend:'Trend structure', participation:'Volume participation', microstructure:'Order-book pressure',
  derivatives:'Derivatives positioning', macro:'Macro regime', risk:'Liquidity & volatility risk',
  liquidity:'Liquidity conditions', momentum:'Momentum & reversal', correlation:'Cross-asset context', event:'Event risk' };

export default function AgentCommandCenter() {
  const [form,setForm] = useState(initial);
  const [result,setResult] = useState(null);
  const [history,setHistory] = useState([]);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [feedback,setFeedback] = useState('win');
  const [feedbackMessage,setFeedbackMessage] = useState('');
  const update = (key,value) => setForm(old => ({...old,[key]:value}));
  const run = useCallback(async event => {
    event?.preventDefault(); setBusy(true); setError('');
    try {
      const evidence = Object.fromEntries(Object.entries(form).filter(([key])=>key!=='symbol').map(([key,value])=>
        [key,key==='highImpactEvent'?value==='true':Number(value)]));
      const response = await apiFetch('/api/agents/evaluate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        symbol:form.symbol.trim().toUpperCase(), evidence:{...evidence,timestamp:new Date().toISOString(),sources:[{id:'operator-supplied',status:'ok'}]}
      })});
      const payload=await response.json(); if(!response.ok) throw new Error(payload.error||'Agent evaluation failed.');
      setResult(payload); setHistory(old=>[payload,...old].slice(0,8));
    } catch(cause){setError(cause.message||'Could not run agent fleet.');}
    finally{setBusy(false);}
  },[form]);
  const saveFeedback = useCallback(async()=>{
    if(!result?.id)return; setFeedbackMessage('');
    try{const response=await apiFetch('/api/agents/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({evaluationId:result.id,outcome:feedback})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Feedback failed');setFeedbackMessage('Outcome saved to observational trading memory.');}
    catch(cause){setFeedbackMessage(cause.message||'Feedback could not be saved.');}
  },[result,feedback]);
  const loadHistory = useCallback(async()=>{
    try{const response=await apiFetch('/api/agents/history?limit=12',{cache:'no-store'});const payload=await response.json();if(response.ok)setHistory(payload.evaluations||[]);}
    catch{}
  },[]);
  React.useEffect(()=>{loadHistory();},[loadHistory]);
  const fields=[['momentumPct','Momentum %'],['timeframeAlignment','Timeframe alignment (-1 to 1)'],['relativeVolume','Relative volume'],['depthImbalance','Depth imbalance (-1 to 1)'],['fundingRate','Funding rate'],['openInterestChangePct','Open-interest change %'],['volatilityPct','Volatility %'],['liquidityUsd','Visible liquidity (USD)'],['correlationBias','Correlation bias (-1 to 1)']];
  return <section className="glass-panel detail-workspace">
    <div className="section-heading ops-title"><div><span className="eyebrow">MULTI-AGENT RESEARCH · EXPLAINABLE DECISIONS</span><h3>JPTI AI Agent Command Center</h3><p>Ten specialist agents independently score supplied market evidence, challenge the consensus and apply a risk veto.</p></div><span className="paper-chip"><ShieldCheck size={13}/> RESEARCH ONLY</span></div>
    <div className="risk-list"><p><BrainCircuit/><span><b>Specialist agent swarm</b><br/>Trend, participation, microstructure, derivatives, macro, liquidity, momentum, correlation, event and risk specialists.</span></p><p><MessageSquareWarning/><span><b>Debate and dissent</b><br/>Displays opposing votes, missing evidence and unresolved agent questions instead of hiding disagreement.</span></p><p><ShieldCheck/><span><b>Hard execution boundary</b><br/>This workspace cannot create exchange orders. Paper/live execution remains separately gated.</span></p></div>
    <form onSubmit={run}>
      <label className="eyebrow" htmlFor="agent-symbol">MARKET SYMBOL</label><input id="agent-symbol" value={form.symbol} onChange={e=>update('symbol',e.target.value)} required/>
      <div className="agent-input-grid">{fields.map(([key,label])=><label key={key}>{label}<input type="number" step="any" value={form[key]} onChange={e=>update(key,e.target.value)} required/></label>)}</div>
      <label className="agent-event-toggle">High-impact event flag <select value={form.highImpactEvent} onChange={e=>update('highImpactEvent',e.target.value)}><option value="false">No known event</option><option value="true">High-impact event present</option></select></label>
      <button className="refresh-button" type="submit" disabled={busy}>{busy?<><RefreshCw size={14}/> Running specialists…</>:<><Activity size={14}/> Run agent council</>}</button>
    </form>
    {error&&<p className="quote-error">{error}</p>}
    {result&&<div className="agent-result">
      <div className="quote-consensus-stats"><div><span>RESEARCH STANCE</span><b>{result.consensus.stance.replaceAll('_',' ')}</b></div><div><span>CONFIDENCE SCORE</span><b>{(result.consensus.confidence*100).toFixed(1)}%</b></div><div><span>AGENT AGREEMENT</span><b>{(result.consensus.agreementRatio*100).toFixed(1)}%</b></div><div><span>RISK GATE</span><b>{result.risk.blocked?'BLOCKED':'NO VETO'}</b></div></div>
      <div className="risk-list"><p>{result.risk.blocked?<AlertTriangle/>:<CheckCircle2/>}<span><b>{result.recommendedAction.replaceAll('_',' ')}</b><br/>{result.risk.reasons.join(' · ')||'No risk veto. This is still research output, not an execution instruction.'}</span></p></div>
      <h4>Agent findings</h4><div className="scanner-table"><div><span>AGENT</span><span>STATUS / SCORE</span><span>CONFIDENCE</span></div>{result.agents.map(agent=><div key={agent.id}><b>{agentNames[agent.id]||agent.id}</b><span>{agent.status.replaceAll('_',' ')}{agent.score==null?'':' · '+agent.score.toFixed(2)}</span><strong>{(agent.confidence*100).toFixed(0)}%</strong></div>)}</div>
      <h4>Agent debate</h4><p className="subtle-note">{result.debate.thesis}</p><p className="subtle-note">{result.debate.challenge}</p>
      {result.agents.filter(a=>a.status!=='evaluated').map(a=><p className="subtle-note" key={a.id}>{agentNames[a.id]}: missing {a.missingEvidence.join(', ')}</p>)}
      <div className="agent-feedback"><label>Record eventual outcome <select value={feedback} onChange={e=>setFeedback(e.target.value)}><option value="win">Win</option><option value="loss">Loss</option><option value="breakeven">Breakeven</option><option value="invalidated">Invalidated</option><option value="not_taken">Not taken</option></select></label><button className="small-refresh" type="button" onClick={saveFeedback}>Save outcome</button>{feedbackMessage&&<small>{feedbackMessage}</small>}</div>
      <small className="subtle-note">Evaluation {result.id} · {new Date(result.generatedAt).toLocaleString()} · {result.persisted?'Saved to JPTI memory':'Not persisted'}</small>
    </div>}
    <div className="section-heading"><div><h4>Recent agent evaluations</h4><p className="subtle-note">Append-only research history.</p></div><button className="small-refresh" type="button" onClick={loadHistory}>Refresh history</button></div>
    {history.map(item=><div className="agent-history-row" key={item.id}><b>{item.symbol||'Unspecified market'}</b><span>{item.consensus.stance.replaceAll('_',' ')}</span><small>{new Date(item.generatedAt).toLocaleString()}</small></div>)}
  </section>;
}
