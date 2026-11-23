import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Clock3, FlaskConical, Play, RefreshCw, ShieldCheck, Target, TrendingUp, XCircle } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import LiveCandlestickChart from './LiveCandlestickChart.jsx';
import { gainzAlphaContext } from './gainz-alpha/context.js';
import './AlphaSignalEngine.css';

const fmt=(v,d=4)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:d});
const options={exchange:['binance','bitget','bybit','okx'],timeframe:['5m','15m','1h','4h','1d']};
export default function AlphaSignalEngine(){
 const [exchange,setExchange]=useState('binance'),[symbol,setSymbol]=useState('BTC/USDT'),[timeframe,setTimeframe]=useState('1h'),[marketType,setMarketType]=useState('spot');
 const [equity,setEquity]=useState('10000'),[dailyPnl,setDailyPnl]=useState('0'),[riskPercent,setRiskPercent]=useState('0.5'),[maxNotional,setMaxNotional]=useState('2000'),[apiToken,setApiToken]=useState(''),[inventoryConfirmed,setInventoryConfirmed]=useState(false),[exposuresJson,setExposuresJson]=useState('');
 const [result,setResult]=useState(null),[replay,setReplay]=useState(null),[ledger,setLedger]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[paperBusy,setPaperBusy]=useState(false),[markBusy,setMarkBusy]=useState(false),[promotion,setPromotion]=useState(null),[promotionBusy,setPromotionBusy]=useState(false);
 const headers=()=>apiToken?{'x-jpti-api-token':apiToken}:{};
 const loadLedger=useCallback(async()=>{try{const r=await apiFetch('/api/alpha/paper/ledger',{headers:headers(),cache:'no-store'});const d=await r.json();if(r.ok)setLedger(d);}catch{}},[apiToken]);
 useEffect(()=>{loadLedger();},[loadLedger]);
 const getMarketData=useCallback(async()=>{
  const normalized=symbol.trim().toUpperCase();if(!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(normalized))throw new Error('Enter a normalized BASE/QUOTE symbol such as BTC/USDT.');
  const marketPath=normalized.replace('/','-');
  const [candleResponse,quoteResponse]=await Promise.all([
   apiFetch('/api/exchanges/'+exchange+'/ohlcv/'+encodeURIComponent(marketPath)+'?timeframe='+encodeURIComponent(timeframe)+'&limit=320&type='+encodeURIComponent(marketType),{cache:'no-store'}),
   apiFetch('/api/exchanges/'+exchange+'/ticker/'+encodeURIComponent(marketPath),{cache:'no-store'})
  ]);
  const [candleData,quoteData]=await Promise.all([candleResponse.json(),quoteResponse.json()]);
  if(!candleResponse.ok)throw new Error(candleData.error||'OHLCV history unavailable.');
  if(!quoteResponse.ok)throw new Error(quoteData.error||'A fresh exchange quote is required.');
  const timestamp=quoteData.timestamp?new Date(quoteData.timestamp).toISOString():quoteData.datetime;
  return {symbol:normalized,marketType,candles:candleData.candles,quote:{last:quoteData.last,timestamp}};
 },[exchange,symbol,timeframe,marketType]);
 const run=useCallback(async()=>{
  setBusy(true);setError('');setReplay(null);
  try{let exposures;try{exposures=JSON.parse(exposuresJson);}catch{throw new Error('Existing exposure inventory must be valid JSON. Enter [] only after confirming that the account has no open positions.');}if(!Array.isArray(exposures))throw new Error('Existing exposure inventory must be a JSON array.');if(!inventoryConfirmed)throw new Error('Confirm that the exposure inventory includes every current open position before requesting paper eligibility.');const market=await getMarketData();let sessionMemory=[];try{const memoryResponse=await apiFetch('/api/session/memory',{cache:'no-store'});if(memoryResponse.ok){const memoryData=await memoryResponse.json();sessionMemory=Array.isArray(memoryData.records)?memoryData.records:[];}}catch{}const payload={...market,sessionMemory,exchange,timeframe,account:{equity:Number(equity),currency:symbol.split('/')[1],dailyPnl:Number(dailyPnl),exposures},
   limits:{maxDailyLoss:Math.max(1,Number(equity)*.025),maxOrderNotional:Number(maxNotional),maxGrossExposure:Math.max(Number(maxNotional),Number(equity)*.5),maxRiskPercent:Number(riskPercent),maxSymbolConcentrationPercent:25,maxQuoteAgeMs:15000},
   ...gainzAlphaContext(market.symbol,timeframe),
   config:{riskPercent:Number(riskPercent),minimumConfidence:62,minimumAgreement:.5,atrStopMultiple:1.5,targetOneR:1,targetTwoR:2}};
   const response=await apiFetch('/api/alpha/evaluate',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify(payload)});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'Alpha analysis failed.');setResult(data);await loadLedger();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 },[getMarketData,equity,dailyPnl,maxNotional,riskPercent,apiToken,exchange,timeframe,loadLedger,inventoryConfirmed,exposuresJson]);
 const createPaper=useCallback(async()=>{
  if(!result?.signalId)return;setPaperBusy(true);setError('');
  try{const r=await apiFetch('/api/alpha/paper/intent',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({signalId:result.signalId})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Paper intent rejected.');await loadLedger();}catch(e){setError(e.message);}finally{setPaperBusy(false);}
 },[result,apiToken,loadLedger]);
 const runReplay=useCallback(async()=>{
  setBusy(true);setError('');
  try{const market=await getMarketData();const r=await apiFetch('/api/alpha/replay',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({candles:market.candles,symbol:market.symbol,exchange,timeframe,config:{riskPercent:Number(riskPercent),minimumConfidence:62,minimumAgreement:.5,atrStopMultiple:1.5,targetOneR:1,targetTwoR:2},feeBps:10,slippageBps:5,initialCapital:Number(equity)})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Historical replay failed.');setReplay(d);}catch(e){setError(e.message);}finally{setBusy(false);}
 },[getMarketData,timeframe,riskPercent,equity,apiToken]);
 const loadPromotion=useCallback(async()=>{setPromotionBusy(true);setError('');try{const quoteCurrency=symbol.trim().toUpperCase().split('/')[1];const r=await apiFetch('/api/alpha/promotion-readiness?quoteCurrency='+encodeURIComponent(quoteCurrency),{headers:headers(),cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Promotion evidence assessment failed.');setPromotion(d);}catch(e){setError(e.message);}finally{setPromotionBusy(false);}},[symbol,apiToken]);
 const markOpenPositions=useCallback(async()=>{
  const open=(ledger?.trades||[]).filter(t=>t.status==='open');if(!open.length)return;setMarkBusy(true);setError('');
  const outcomes=await Promise.allSettled(open.map(async trade=>{
   const path=trade.market.symbol.replace('/','-'),product=trade.market.marketType||marketType,q=await apiFetch('/api/exchanges/'+trade.market.exchange+'/ticker/'+encodeURIComponent(path)+'?type='+encodeURIComponent(product),{cache:'no-store'}),quote=await q.json();if(!q.ok)throw new Error(trade.market.symbol+': '+(quote.error||'ticker unavailable'));
   const timestamp=quote.timestamp?new Date(quote.timestamp).toISOString():quote.datetime;
   const response=await apiFetch('/api/alpha/paper/mark',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({tradeId:trade.tradeId,markPrice:quote.last,quoteTimestamp:timestamp})});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'Paper mark failed for '+trade.market.symbol);return data;
  }));
  await loadLedger();const failures=outcomes.filter(x=>x.status==='rejected');if(failures.length)setError(failures.map(x=>x.reason?.message||'Mark failed').join(' · '));setMarkBusy(false);
 },[ledger,apiToken,loadLedger]);
 const closePaper=async trade=>{const price=window.prompt('Enter the observed exit price for this paper-only position:');if(!price)return;try{const r=await apiFetch('/api/alpha/paper/close',{method:'POST',headers:{...headers(),'Content-Type':'application/json'},body:JSON.stringify({tradeId:trade.tradeId,exitPrice:Number(price),reason:'operator_close'})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not close paper position.');await loadLedger();}catch(e){setError(e.message);}};
 const side=result?.direction,eligible=result?.permissions?.paperIntentEligible;
 return <div className="alpha-workspace">
  <section className="alpha-hero"><div><span className="alpha-eyebrow"><Activity size={13}/> JPTI QUANTITATIVE RESEARCH / ENGINE v1.0</span><h2>Alpha Signal Engine</h2><p>Deterministic multi-model signals, explainable evidence, reproducible fingerprints and fail-closed paper risk assessment.</p></div><div className="alpha-lock"><ShieldCheck size={17}/><span>PAPER ONLY<br/><b>LIVE EXECUTION LOCKED</b></span></div></section>
  <section className="alpha-panel"><div className="alpha-section-head"><div><span className="alpha-eyebrow">01 / MARKET & RISK CONFIGURATION</span><h3>Signal assessment parameters</h3></div><span className="alpha-chip">COMPLETED CANDLES ONLY</span></div>
   <div className="alpha-controls">
    <label>Exchange<select value={exchange} onChange={e=>setExchange(e.target.value)}>{options.exchange.map(x=><option key={x}>{x}</option>)}</select></label>
    <label>Market symbol<input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} placeholder="BTC/USDT"/></label>
    <label>Timeframe<select value={timeframe} onChange={e=>setTimeframe(e.target.value)}>{options.timeframe.map(x=><option key={x}>{x}</option>)}</select></label>
    <label>Account equity (quote currency)<input type="number" min="1" value={equity} onChange={e=>setEquity(e.target.value)}/></label>
    <label>Daily realized PnL<input type="number" value={dailyPnl} onChange={e=>setDailyPnl(e.target.value)}/></label>
    <label>Risk per trade (%)<input type="number" min="0.1" max="2" step="0.1" value={riskPercent} onChange={e=>setRiskPercent(e.target.value)}/></label>
    <label>Max order notional<input type="number" min="1" value={maxNotional} onChange={e=>setMaxNotional(e.target.value)}/></label>
    <label>Existing exposures JSON<input value={exposuresJson} onChange={e=>{setExposuresJson(e.target.value);setInventoryConfirmed(false);}} placeholder='[{"symbol":"ETH/USDT","marketValue":500,"currency":"USDT"}] or [] if flat'/></label><label>API token (if required)<input type="password" value={apiToken} onChange={e=>setApiToken(e.target.value)} placeholder="Local private access may not require one" autoComplete="off"/></label>
   </div>
   <label className="alpha-confirm"><input type="checkbox" checked={inventoryConfirmed} onChange={e=>setInventoryConfirmed(e.target.checked)}/> I confirm this inventory is complete and current, including all open positions.</label><div className="alpha-actions"><button className="alpha-primary" onClick={run} disabled={busy||!inventoryConfirmed}>{busy?<RefreshCw className="spin" size={15}/>:<Play size={15}/>} {busy?'Analyzing market…':'Generate Alpha assessment'}</button><button className="alpha-secondary" onClick={runReplay} disabled={busy}><FlaskConical size={15}/> Replay historical signals</button></div>
   <p className="alpha-footnote">Uses public OHLCV and ticker data from the selected exchange. Risk inventory is explicitly empty in this initial UI; connect a reconciled account exposure feed before using paper eligibility with an existing portfolio.</p>
   {error&&<div className="alpha-error"><AlertTriangle size={15}/>{error}</div>}
  </section>
  {result&&<section className="alpha-panel"><div className="alpha-section-head"><div><span className="alpha-eyebrow">02 / EXPLAINABLE SIGNAL OUTPUT</span><h3>Assessment result</h3></div><span className={'alpha-status '+(eligible?'pass':'blocked')}>{eligible?'PAPER ELIGIBLE':'BLOCKED'}</span></div>
   <div className="alpha-result-grid"><div className="alpha-direction"><span>ENSEMBLE DIRECTION</span><b className={side==='buy'?'up':side==='sell'?'down':''}>{side==='buy'?'BUY':side==='sell'?'SELL':'NEUTRAL'}</b><small>{result.market.symbol} · {result.market.timeframe} · {result.market.exchange}</small></div>
    <div className="alpha-metric"><span>HEURISTIC CONFIDENCE</span><b>{fmt(result.confidence,1)}%</b><small>Not a calibrated win probability</small></div><div className="alpha-metric"><span>MODEL AGREEMENT</span><b>{fmt(result.modelAgreement*100,1)}%</b><small>Active directional models</small></div><div className="alpha-metric"><span>MARKET REGIME</span><b>{result.marketRegime.replaceAll('_',' ')}</b><small>{result.market.completedCandles} completed bars</small></div></div>
   <div className="alpha-levels"><div><span>REFERENCE ENTRY</span><b>{fmt(result.levels.entry)}</b></div><div><span>STOP LOSS</span><b className="down">{fmt(result.levels.stopLoss)}</b></div><div><span>TAKE PROFIT 1</span><b className="up">{fmt(result.levels.takeProfitOne)}</b></div><div><span>TAKE PROFIT 2</span><b className="up">{fmt(result.levels.takeProfitTwo)}</b></div><div><span>RISK BUDGET</span><b>{fmt(result.sizing.riskBudget)}</b></div><div><span>PROPOSED QUANTITY</span><b>{fmt(result.sizing.quantity,6)}</b></div></div>
   <h4>Signal levels on live chart</h4><LiveCandlestickChart exchange={exchange} symbol={symbol} onSymbolChange={setSymbol} initialTimeframe={timeframe} onTimeframeChange={setTimeframe} onMarketTypeChange={setMarketType} alphaLevels={result ? [{label:'ENTRY',price:result.levels.entry,color:'#e5b85c'},{label:'STOP',price:result.levels.stopLoss,color:'#f07883'},{label:'TP1',price:result.levels.takeProfitOne,color:'#20c997'},{label:'TP2',price:result.levels.takeProfitTwo,color:'#20c997'}] : []}/>
   <h4>Specialist evidence</h4><div className="alpha-models">{result.evidence.models.map(m=><article key={m.id}><div><b>{m.label}</b><span className={m.direction===1?'up':m.direction===-1?'down':''}>{m.direction===1?'BULLISH':m.direction===-1?'BEARISH':'NEUTRAL'} · {Math.round(m.weight*100)}%</span></div><p>{m.evidence}</p></article>)}</div>
   <h4>Quality and risk gates</h4><div className="alpha-checks">{[...result.qualityChecks,...result.riskChecks].map(c=><div key={c.id}><span>{c.passed?<CheckCircle2 className="up" size={15}/>:<XCircle className="down" size={15}/>}<b>{c.id.replaceAll('_',' ')}</b></span><small>{c.detail}</small></div>)}</div>
   <div className="alpha-actions"><button className="alpha-primary" disabled={!eligible||paperBusy} onClick={createPaper}>{paperBusy?'Recording…': 'Create paper-only intent'}</button><span className="alpha-footnote">Signal fingerprint · {result.evidence.signalFingerprint.slice(0,24)}…</span></div>
   <p className="alpha-footnote">{result.evidence.methodology} Live execution authorized: no. Exchange orders created: 0.</p>
  </section>}
  {replay&&<section className="alpha-panel"><div className="alpha-section-head"><div><span className="alpha-eyebrow">03 / HISTORICAL REPRODUCIBILITY</span><h3>Deterministic replay results</h3></div><span className="alpha-chip">70 / 30 CHRONOLOGICAL SPLIT</span></div>
   <div className="alpha-result-grid">{[['TRADES',replay.overall.trades],['WIN RATE',replay.overall.winRatePercent==null?'—':replay.overall.winRatePercent+'%'],['PROFIT FACTOR',fmt(replay.overall.profitFactor,2)],['NET P&L',fmt(replay.overall.netPnl)],['MAX DRAWDOWN',replay.overall.maxDrawdownPercent+'%'],['OOS NET P&L',fmt(replay.outOfSample.netPnl)]].map(([k,v])=><div className="alpha-metric" key={k}><span>{k}</span><b>{v}</b></div>)}</div><p className="alpha-footnote">Dataset SHA-256 · {replay.data.sha256}. Out-of-sample parameters were not selected using test data. Fees, slippage and conservative stop-first intrabar assumptions are applied.</p>
  </section>}
  <section className="alpha-panel"><div className="alpha-section-head"><div><span className="alpha-eyebrow">04 / PAPER EXECUTION TRACKER</span><h3>Paper trade ledger</h3></div><div className="alpha-actions"><button className="alpha-secondary" onClick={loadLedger}><RefreshCw size={14}/> Refresh</button><button className="alpha-secondary" onClick={markOpenPositions} disabled={markBusy||!(ledger?.summary?.open>0)}>{markBusy?'Marking…':'Mark open positions'}</button></div></div>
   <div className="alpha-result-grid"><div className="alpha-metric"><span>OPEN</span><b>{ledger?.summary?.open??'—'}</b></div><div className="alpha-metric"><span>CLOSED</span><b>{ledger?.summary?.closed??'—'}</b></div><div className="alpha-metric"><span>REALIZED P&L</span><b>{fmt(ledger?.summary?.realizedPnl)}</b></div><div className="alpha-metric"><span>WIN / LOSS</span><b>{(ledger?.summary?.wins??0)+' / '+(ledger?.summary?.losses??0)}</b></div></div>
   <div className="alpha-table"><div><span>MARKET</span><span>DIRECTION</span><span>ENTRY</span><span>STOP / TARGET</span><span>MARK / U-PNL</span><span>STATUS</span><span>ACTION</span></div>{(ledger?.trades||[]).map(t=><div key={t.tradeId}><b>{t.market.symbol}</b><span>{t.direction.toUpperCase()}</span><span>{fmt(t.entry)}</span><span>{fmt(t.stopLoss)} / {fmt(t.takeProfitTwo)}</span><span>{t.mark?fmt(t.mark.price)+' / '+fmt(t.mark.unrealizedPnl):'—'}</span><span>{t.status}</span><span>{t.status==='open'?<button onClick={()=>closePaper(t)}>Record exit</button>:fmt(t.close.netPnl)}</span></div>)}{!ledger?.trades?.length&&<p className="alpha-empty">No paper trades recorded yet.</p>}</div>
   <p className="alpha-footnote">Paper ledger entries are locally persisted events. Live public quotes can automatically trigger the simulated stop or second target when you mark open positions; no exchange orders are submitted.</p>
  </section>
  <section className="alpha-panel"><div className="alpha-section-head"><div><span className="alpha-eyebrow">05 / GOVERNANCE QUALIFICATION</span><h3>Paper-to-review promotion gate</h3></div><button className="alpha-secondary" onClick={loadPromotion} disabled={promotionBusy}>{promotionBusy?'Assessing…':'Evaluate promotion evidence'}</button></div>
   {promotion&&<><div className="alpha-result-grid"><div className="alpha-metric"><span>DECISION</span><b>{promotion.decision.replaceAll('_',' ')}</b></div><div className="alpha-metric"><span>CLOSED PAPER TRADES</span><b>{promotion.metrics.closedTrades}</b></div><div className="alpha-metric"><span>PROFIT FACTOR</span><b>{fmt(promotion.metrics.profitFactor,2)}</b></div><div className="alpha-metric"><span>MAX DRAWDOWN</span><b>{fmt(promotion.metrics.maxDrawdownPercent,2)}%</b></div></div><div className="alpha-checks">{promotion.checks.map(c=><div key={c.id}><span>{c.passed?<CheckCircle2 className="up" size={15}/>:<XCircle className="down" size={15}/>}<b>{c.id.replaceAll('_',' ')}</b></span><small>{c.detail} Actual: {typeof c.actual==='object'?JSON.stringify(c.actual):String(c.actual??'—')} · Required: {String(c.required)}</small></div>)}</div><p className="alpha-footnote">{promotion.note} {promotion.limitations.join(' ')}</p></>}
   {!promotion&&<p className="alpha-footnote">Requires 30 closed paper trades, at least 14 days of observations, profit factor ≥ 1.20, positive expectancy, drawdown ≤ 10%, complete signal traceability and a positive same-currency out-of-sample replay. Passing only permits independent governance review.</p>}
  </section>
 </div>;
}
