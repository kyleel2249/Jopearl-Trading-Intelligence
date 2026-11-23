import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './lib/api.js';

const fmt = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined,{maximumFractionDigits:4});
const profilesFallback = [
  ['spot_trend','Spot trend'],['perp_momentum','Perpetual momentum'],['mean_reversion','Mean reversion'],
  ['breakout','Breakout'],['defi_rotation','DeFi rotation'],['meme_new_pair','New pair / meme'],
  ['equity_swing','Equity swing'],['macro_rotation','Macro rotation']
];

export default function UniversalEngine({ localPrivateAccess = false }) {
  const [profiles,setProfiles]=useState([]);
  const [coverage,setCoverage]=useState(null);
  const [exchange,setExchange]=useState('binance');
  const [symbol,setSymbol]=useState('BTC/USDT');
  const [profileId,setProfileId]=useState('spot_trend');
  const [market,setMarket]=useState(null);
  const [evaluation,setEvaluation]=useState(null);
  const [extraEvidence,setExtraEvidence]=useState({});
  const [query,setQuery]=useState('ETH');
  const [token,setToken]=useState('');
  const [dex,setDex]=useState(null);
  const [macro,setMacro]=useState(null);
  const [risk,setRisk]=useState(null);
  const [performance,setPerformance]=useState(null);
  const [portfolio,setPortfolio]=useState(null);
  const [strategyScorecards,setStrategyScorecards]=useState(null);
  const [controlStatus,setControlStatus]=useState('');
  const [controlBusy,setControlBusy]=useState(false);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(false);
  const canUsePrivateApi = localPrivateAccess || Boolean(token);

  useEffect(()=>{apiFetch('/api/universal/profiles').then(r=>r.json()).then(d=>setProfiles(Object.entries(d.profiles||{}).map(([id,p])=>({id,...p})))).catch(()=>setProfiles([]));
    apiFetch('/api/universal/coverage',{cache:'no-store'}).then(r=>r.json()).then(setCoverage).catch(()=>setCoverage(null));
  },[]);

  const loadMarket=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const r=await apiFetch('/api/universal/market/'+encodeURIComponent(exchange)+'/'+encodeURIComponent(symbol)+'?timeframe=1h',{cache:'no-store'});
      const d=await r.json();if(!r.ok)throw new Error(d.error||'Market evidence unavailable');
      setMarket(d);
      const ev=d.evidence||{};
      const payload={profileId,evidence:{...extraEvidence,momentumPct:extraEvidence.momentumPct??ev.momentumPct,relativeVolume:extraEvidence.relativeVolume??ev.relativeVolume,timeframeAlignment:extraEvidence.timeframeAlignment??ev.timeframeAlignment,orderBookImbalance:ev.orderBookImbalance,fundingRate:extraEvidence.fundingRate??ev.fundingRate,rsi14:extraEvidence.rsi14??ev.rsi14,liquidityUsd:extraEvidence.liquidityUsd??ev.visibleDepthUsd}};
      const evalRes=await apiFetch('/api/universal/strategy/evaluate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const result=await evalRes.json();if(evalRes.ok)setEvaluation(result);
    }catch(e){setError(e.message);}finally{setLoading(false);}
  },[exchange,symbol,profileId,extraEvidence]);

  const loadMacro=useCallback(async()=>{
    try{const r=await apiFetch('/api/universal/macro',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Macro sources unavailable');setMacro(d);}catch(e){setError(e.message);}
  },[]);
  const loadDex=useCallback(async(event)=>{
    if(event)event.preventDefault();setLoading(true);setError('');
    try{const r=await apiFetch('/api/universal/dex/search?q='+encodeURIComponent(query),{headers:{'x-jpti-api-token':token},cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'DEX search unavailable');setDex(d);}catch(e){setError(e.message);}finally{setLoading(false);}
  },[query,token]);
  const loadPrivate=useCallback(async()=>{
    setLoading(true);setError('');
    try{
      const headers={'x-jpti-api-token':token};
      const [r1,r2,r3,r4]=await Promise.all([apiFetch('/api/universal/risk',{headers,cache:'no-store'}),apiFetch('/api/universal/performance',{headers,cache:'no-store'}),apiFetch('/api/universal/portfolio',{headers,cache:'no-store'}),apiFetch('/api/universal/strategy/scorecards?days=90&minTrades=20',{headers,cache:'no-store'})]);
      const [a,b,c,d]=await Promise.all([r1.json(),r2.json(),r3.json(),r4.json()]);
      if(!r1.ok)throw new Error(a.error||'Unified risk unavailable');if(!r2.ok)throw new Error(b.error||'Performance report unavailable');if(!r3.ok)throw new Error(c.error||'Portfolio valuation unavailable');if(!r4.ok)throw new Error(d.error||'Strategy scorecards unavailable');
      setRisk(a);setPerformance(b);setPortfolio(c);setStrategyScorecards(d);
    }catch(e){setError(e.message);}finally{setLoading(false);}
  },[token]);

  const setGlobalControl=useCallback(async(action)=>{
    setControlBusy(true);setError('');setControlStatus('');
    try{
      const r=await apiFetch('/api/universal/control',{method:'POST',headers:{'content-type':'application/json','x-jpti-api-token':token},
        body:JSON.stringify({action,reason:'Universal Engine operator control'})});
      const d=await r.json();if(!r.ok)throw new Error(d.error||'Global control update failed');
      setControlStatus(action==='pause_new_entries'?'Global T-Bots entry pause recorded.':'Global T-Bots entry pause cleared.');
      await loadPrivate();
    }catch(e){setError(e.message);}finally{setControlBusy(false);}
  },[token,loadPrivate]);

  useEffect(()=>{loadMacro();},[loadMacro]);

  const selected=profiles.find(p=>p.id===profileId);
  return <section className="glass-panel detail-workspace universal-engine">
    <span className="eyebrow">CROSS-ASSET INTELLIGENCE · UNIFIED RISK · STRATEGY RESEARCH</span>
    <h3>Universal trading intelligence engine</h3>
    <p>One evidence and strategy layer for crypto spot, perpetuals, DEX tokens, DeFi, equities and macro-sensitive markets. It evaluates data and risk; it does not automatically place orders.</p>
    <div className="risk-list">
      <p>• Six-agent T-Bots paper engine remains the DEX execution simulator.</p>
      <p>• Exchange capabilities, market hours, instrument rules and data coverage remain venue-specific.</p>
      <p>• Strategy scores are research evidence, not calibrated probabilities or guaranteed signals.</p>
    </div>

    <div className="section-heading"><div><span className="eyebrow">DATA COVERAGE & PROVIDER READINESS</span><h3>Universal market coverage</h3></div><span className="subtle-note">{coverage?.exchangeCatalog?.supportedVenueCount??'—'} CCXT venues indexed</span></div>
    {coverage&&<><div className="scanner-table"><div><span>ASSET CLASS</span><span>READINESS</span><span>AVAILABLE SOURCES</span><span>EXECUTION SCOPE</span></div>{coverage.assetClasses.map(item=><div key={item.id}><b>{item.label}</b><span>{item.status.replaceAll('_',' ')}</span><span>{item.availableSources.join(', ')||'None'}</span><span>{item.execution}</span></div>)}</div>
    <p className="subtle-note">Configured watchlists: {coverage.watchlists?.cexEntriesConfigured??0} CEX · {coverage.watchlists?.dexEntriesConfigured??0} DEX. Assessment: {coverage.assessment}. This is configuration/catalog visibility, not a live provider health check or confirmation of symbol entitlement.</p>
    <p className="subtle-note">{coverage.caveats?.join(' ')}</p></>}
        <div className="section-heading"><div><span className="eyebrow">STRATEGY PROFILE REGISTRY</span><h3>Asset-class strategy selection</h3></div></div>
    <div className="news-search">
      <select value={profileId} onChange={e=>setProfileId(e.target.value)}>{(profiles.length?profiles:profilesFallback.map(([id,label])=>({id,label}))).map(p=><option key={p.id} value={p.id}>{p.label||p.id.replaceAll('_',' ')}</option>)}</select>
      <select value={exchange} onChange={e=>setExchange(e.target.value)}><option value="binance">Binance</option><option value="bitget">Bitget</option><option value="bybit">Bybit</option><option value="okx">OKX</option><option value="kraken">Kraken</option><option value="coinbase">Coinbase</option></select>
      <input value={symbol} onChange={e=>setSymbol(e.target.value)} placeholder="BASE/QUOTE"/>
      <button onClick={loadMarket} disabled={loading}>{loading?'Evaluating…':'Load market evidence'}</button>
    </div>
    {selected&&<p className="subtle-note">{selected.description||selected.horizon}. Supported asset classes: {(selected.assetClasses||[]).join(', ')}. Timeframes: {(selected.timeframes||[]).join(', ')}.</p>}
    <div className="news-search">
      <input type="number" step="0.1" placeholder="Manual momentum %" value={extraEvidence.momentumPct??''} onChange={e=>setExtraEvidence(v=>({...v,momentumPct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" step="0.1" placeholder="Manual relative volume x" value={extraEvidence.relativeVolume??''} onChange={e=>setExtraEvidence(v=>({...v,relativeVolume:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" min="-1" max="1" step="0.1" placeholder="MTF alignment -1 to +1" value={extraEvidence.timeframeAlignment??''} onChange={e=>setExtraEvidence(v=>({...v,timeframeAlignment:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" placeholder="Verified liquidity / visible depth USD" value={extraEvidence.liquidityUsd??''} onChange={e=>setExtraEvidence(v=>({...v,liquidityUsd:e.target.value===''?null:Number(e.target.value)}))}/>
    </div>
    <p className="subtle-note">Manual evidence overrides should be backed by a named provider, timestamp and verified instrument identity. They are not independently authenticated by this form.</p>
    {profileId==='defi_rotation'&&<div className="news-search">
      <input type="number" step="0.1" placeholder="Verified protocol TVL change %" value={extraEvidence.tvlChangePct??''} onChange={e=>setExtraEvidence(v=>({...v,tvlChangePct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" step="0.1" placeholder="Verified protocol fees change %" value={extraEvidence.feesChangePct??''} onChange={e=>setExtraEvidence(v=>({...v,feesChangePct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" min="0" max="100" placeholder="Protocol risk score 0–100" value={extraEvidence.protocolRiskScore??''} onChange={e=>setExtraEvidence(v=>({...v,protocolRiskScore:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" placeholder="Verified pool liquidity USD" value={extraEvidence.liquidityUsd??''} onChange={e=>setExtraEvidence(v=>({...v,liquidityUsd:e.target.value===''?null:Number(e.target.value)}))}/>
      <p className="subtle-note">Enter values only from a verified protocol/token mapping and current provider evidence. Symbol matching alone is not protocol identity.</p>
    </div>}
    {profileId==='equity_swing'&&<div className="news-search">
      <input type="number" min="0" placeholder="Days to next earnings event" value={extraEvidence.earningsRiskDays??''} onChange={e=>setExtraEvidence(v=>({...v,earningsRiskDays:e.target.value===''?null:Number(e.target.value)}))}/>
    </div>}
    {profileId==='macro_rotation'&&<div className="news-search">
      <select value={extraEvidence.macroBias||'neutral'} onChange={e=>setExtraEvidence(v=>({...v,macroBias:e.target.value}))}><option value="risk-on">Risk-on</option><option value="neutral">Neutral</option><option value="risk-off">Risk-off</option></select>
      <input type="number" step="0.1" placeholder="Macro momentum %" value={extraEvidence.macroMomentumPct??''} onChange={e=>setExtraEvidence(v=>({...v,macroMomentumPct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" step="0.1" placeholder="Relative strength %" value={extraEvidence.relativeStrengthPct??''} onChange={e=>setExtraEvidence(v=>({...v,relativeStrengthPct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" step="0.1" placeholder="Dollar index change %" value={extraEvidence.dollarIndexChangePct??''} onChange={e=>setExtraEvidence(v=>({...v,dollarIndexChangePct:e.target.value===''?null:Number(e.target.value)}))}/>
      <input type="number" step="1" placeholder="Rate differential bps" value={extraEvidence.rateDifferentialBps??''} onChange={e=>setExtraEvidence(v=>({...v,rateDifferentialBps:e.target.value===''?null:Number(e.target.value)}))}/>
    </div>}
    {profileId==='mean_reversion'&&<div className="news-search">
      <input type="number" min="0" max="100" placeholder="RSI 14" value={extraEvidence.rsi14??''} onChange={e=>setExtraEvidence(v=>({...v,rsi14:e.target.value===''?null:Number(e.target.value)}))}/>
    </div>}
    {market&&<><div className="quote-consensus-stats">
      <div><span>LAST PRICE</span><b>{fmt(market.ticker?.last)}</b></div>
      <div><span>MOMENTUM WINDOW</span><b>{market.evidence?.momentumPct==null?'—':fmt(market.evidence.momentumPct)+'%'}</b></div>
      <div><span>RELATIVE VOLUME</span><b>{fmt(market.evidence?.relativeVolume)}x</b></div>
      <div><span>BOOK IMBALANCE</span><b>{market.evidence?.orderBookImbalance==null?'—':fmt(market.evidence.orderBookImbalance*100)+'%'}</b></div>
    </div>
    <div className="risk-list">{(market.council?.agents||[]).map(a=><p key={a.id}><b>{a.specialty||a.id}</b> · {a.bias||'insufficient data'} · {(a.evidence||[]).map(x=>x.metric+': '+x.value).join(', ')}</p>)}</div>
    <p className="subtle-note">{(market.limitations||[]).join(' ')}</p></>}
    {evaluation&&<div className="quote-consensus-stats"><div><span>PROFILE SCORE</span><b>{evaluation.score}/100</b></div><div><span>BIAS</span><b>{evaluation.bias}</b></div><div><span>STATUS</span><b>{evaluation.status.replaceAll('_',' ')}</b></div><div><span>MISSING EVIDENCE</span><b>{evaluation.missingEvidence.join(', ')||'None'}</b></div></div>}

    <div className="section-heading"><div><span className="eyebrow">MULTI-CHAIN TOKEN DISCOVERY</span><h3>DEX asset universe</h3></div></div>
    <form className="news-search" onSubmit={loadDex}><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Token name, symbol or contract"/><input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token"/><button disabled={loading||(!token&&!localPrivateAccess)||query.trim().length<2}>{loading?'Searching…':'Search DEX universe'}</button></form>
    {dex&&<><div className="quote-consensus-stats"><div><span>PAIR RESULTS</span><b>{dex.pairs?.length||0}</b></div><div><span>CHAINS</span><b>{(dex.chains||[]).join(', ')||'—'}</b></div><div><span>DATA SOURCE</span><b>{dex.source}</b></div><div><span>UPDATED</span><b>{new Date(dex.fetchedAt).toLocaleTimeString()}</b></div></div>
    <div className="scanner-table"><div><span>CHAIN / PAIR</span><span>PRICE USD</span><span>LIQUIDITY</span><span>24H VOLUME</span><span>EVIDENCE</span></div>{(dex.pairs||[]).slice(0,30).map((p,i)=><div key={p.chain+':'+p.pairAddress+':'+i}><b>{p.chain} · {p.base?.symbol}/{p.quote?.symbol}</b><span>{fmt(p.priceUsd)}</span><span>{fmt(p.liquidityUsd)}</span><span>{fmt(p.volume24hUsd)}</span><strong>{p.evidence?.score??'—'}/100</strong></div>)}</div>
    <p className="subtle-note">{dex.coverage}</p></>}

    <div className="section-heading"><div><span className="eyebrow">GLOBAL REGIME</span><h3>Crypto, DeFi & macro context</h3></div><button className="refresh-button" onClick={loadMacro}>Refresh macro</button></div>
    {macro&&<><div className="quote-consensus-stats"><div><span>CRYPTO MARKET CAP</span><b>{fmt(macro.crypto?.marketCapUsd)}</b></div><div><span>BTC DOMINANCE</span><b>{fmt(macro.crypto?.btcDominancePercent)}%</b></div><div><span>DEFI TVL</span><b>{fmt(macro.defi?.totalValueLockedUsd)}</b></div><div><span>FED FUNDS</span><b>{fmt(macro.macro?.fedFundsLatest)}%</b></div></div>
    <p className="subtle-note">Sources: {Object.entries(macro.sources||{}).map(([k,v])=>k+': '+v.status).join(' · ')}. Missing providers remain unavailable, not zero.</p></>}

    <div className="section-heading"><div><span className="eyebrow">PORTFOLIO-WIDE CONTROL</span><h3>Unified risk & performance</h3></div></div>
    <div className="news-search"><input type="password" value={token} onChange={e=>setToken(e.target.value)} placeholder="JPTI API token"/><button onClick={loadPrivate} disabled={loading||!canUsePrivateApi}>{loading?'Loading…':'Load risk, performance & portfolio'}</button></div>
    {risk&&<><div className="news-search"><button onClick={()=>setGlobalControl('pause_new_entries')} disabled={controlBusy||!canUsePrivateApi}>Pause all new T-Bots entries</button><button onClick={()=>setGlobalControl('resume_new_entries')} disabled={controlBusy||!token}>Resume new entries</button></div>{controlStatus&&<p className="subtle-note">{controlStatus}</p>}<div className="quote-consensus-stats"><div><span>NEW ENTRIES</span><b>{risk.newEntriesAllowed?'ALLOWED':'PAUSED'}</b></div><div><span>GLOBAL PAUSE</span><b>{risk.globalPaused?'ON':'OFF'}</b><span>LOSS STREAK</span><b>{risk.consecutiveLosses}</b></div><div><span>24H USD LOSS</span><b>{fmt(risk.rolling24hUsdLoss)}</b></div><div><span>DAILY LIMIT</span><b>{fmt(risk.maxDailyLossUsd)}</b></div></div><p className="subtle-note">{(risk.pauseReasons||[]).join(' · ')||'No configured shared pause condition currently breached'}. Existing exits remain enabled. {risk.caveat}</p></>}

    {strategyScorecards&&<><div className="section-heading"><div><span className="eyebrow">STRATEGY FEEDBACK LOOP</span><h3>Historical strategy scorecards</h3></div><span className="subtle-note">Last {strategyScorecards.windowDays} days · paper trades only</span></div>
      {strategyScorecards.scorecards?.length?<div className="scanner-table"><div><span>STRATEGY PROFILE</span><span>TRADES / WIN RATE</span><span>EXPECTANCY</span><span>PROFIT FACTOR</span><span>SAMPLE QUALITY</span></div>{strategyScorecards.scorecards.map(row=><div key={row.strategyProfile}><b>{row.strategyProfile.replaceAll('_',' ')}</b><span>{row.trades} · {fmt(row.winRatePercent)}%</span><span>{fmt(row.expectancyUsdPerTrade)} USD</span><span>{row.profitFactor==null?'No losses':fmt(row.profitFactor)}</span><strong>{row.sampleQuality.replaceAll('_',' ')}</strong></div>)}</div>:<p className="subtle-note">No closed T-Bots paper trades are recorded in this lookback window. Scorecards will populate as tagged results are persisted.</p>}
      <p className="subtle-note">{strategyScorecards.caveat}</p></>}
    {performance&&<><div className="quote-consensus-stats"><div><span>T-BOTS CLOSED PAPER TRADES</span><b>{performance.paperStrategy.closedTrades}</b></div><div><span>PAPER WIN RATE</span><b>{performance.paperStrategy.winRatePercent==null?'—':fmt(performance.paperStrategy.winRatePercent)+'%'}</b></div><div><span>PAPER REALIZED PNL</span><b>{fmt(performance.paperStrategy.realizedPnlUsd)} USD</b></div><div><span>EXCHANGE FILLS</span><b>{performance.exchangeExecution.fillCount}</b></div></div><p className="subtle-note">{performance.caveat}</p></>}
    {portfolio&&<><div className="section-heading"><div><span className="eyebrow">RECORDED EXCHANGE INVENTORY</span><h3>Spot portfolio mark-to-market</h3></div><span className="subtle-note">{portfolio.positions?.length||0} recorded open positions</span></div>
      {Object.keys(portfolio.byQuote||{}).length>0?<><div className="quote-consensus-stats">{Object.entries(portfolio.byQuote).map(([quote,row])=><div key={quote}><span>{quote} · COST BASIS</span><b>{fmt(row.costBasis)}</b><span>MARKET VALUE</span><b>{fmt(row.marketValue)}</b><span>UNREALIZED PNL</span><b>{fmt(row.unrealizedPnl)}</b></div>)}</div>
      <div className="scanner-table"><div><span>VENUE / SYMBOL</span><span>QUANTITY</span><span>AVG COST</span><span>MARK</span><span>UNREALIZED PNL</span></div>{portfolio.positions.map((p,i)=><div key={p.exchange+':'+p.accountId+':'+p.symbol+':'+i}><b>{p.exchange} · {p.symbol}</b><span>{fmt(p.quantity)}</span><span>{fmt(p.averageCost)} {p.quote}</span><span>{p.status==='marked'?fmt(p.markPrice):'Unavailable'}</span><strong>{p.status==='marked'?fmt(p.unrealizedPnl)+' '+p.quote:'Unmarked'}</strong></div>)}</div></>:<p className="subtle-note">No open spot inventory can currently be reconstructed from recorded exchange fills.</p>}
      <p className="subtle-note">{portfolio.valuation} {portfolio.caveat}</p>
      <p className="subtle-note">Unmatched sell quantity by symbol: {Object.entries(portfolio.unmatchedSellQuantityBySymbol||{}).map(([q,v])=>q+' '+fmt(v)).join(' · ')||'None recorded'}. Cash balances and unrecorded opening inventory are not included.</p>
    </>}
    {error&&<p className="quote-error">{error}</p>}
  </section>;
}
