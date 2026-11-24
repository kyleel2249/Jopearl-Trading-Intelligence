import React, { useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, Gauge, RefreshCw, ShieldAlert, Waves } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import { analyze24hLiquidity } from './session-liquidity-engine.js';

const price = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined,{maximumFractionDigits:8});
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : (Number(value)>0?'+':'')+Number(value).toFixed(2)+'%';

function LevelCard({label,level,side}) {
 const Icon=side==='high'?ArrowUpRight:ArrowDownRight;
 return <article className={'sli-level-card '+side}>
  <span><Icon size={15}/>{label}</span><strong>{price(level?.price)}</strong>
  <small>{level?.session||'Awaiting attribution'} · {level?.source==='exchange-24h-ticker'?'Exchange 24h ticker':'Candle estimate'}</small>
  <em>{level?.interaction?.state?.replaceAll('-',' ')||'unavailable'}</em>
 </article>;
}

export default function SessionLiquidityIntelligence({exchange,symbol,marketType='spot',timeframe='1h',candles=[],tickerSnapshot=null,fetchTicker=true}) {
 const [ticker,setTicker]=useState(null);
 const [tickerState,setTickerState]=useState('loading');
 const [refresh,setRefresh]=useState(0);
 useEffect(()=>{
  let alive=true;
  if(!fetchTicker){setTicker(tickerSnapshot);setTickerState(tickerSnapshot?'live ticker':'candle fallback');return()=>{alive=false;};}
  const load=async()=>{
   if(marketType==='cfd'){setTicker(null);setTickerState('candle fallback');return;}
   try{
    const response=await apiFetch('/api/exchanges/'+encodeURIComponent(exchange)+'/ticker/'+encodeURIComponent(symbol.trim().toUpperCase().replace('/','-')),{cache:'no-store'});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Ticker unavailable');
    if(alive){setTicker(data);setTickerState('live ticker');}
   }catch{if(alive){setTicker(null);setTickerState('candle fallback');}}
  };
  load();
  const timer=setInterval(load,30000);
  return()=>{alive=false;clearInterval(timer);};
 },[exchange,symbol,marketType,refresh,fetchTicker,tickerSnapshot]);
 const analytics=useMemo(()=>analyze24hLiquidity(candles,{timeframe,ticker}),[candles,timeframe,ticker]);
 const change=analytics.change24h;
 return <section className="glass-panel sli-panel" aria-label="24-hour high low and session liquidity intelligence">
  <div className="panel-title"><div><span className="eyebrow">ROLLING 24H · SESSION ATTRIBUTION · LIQUIDITY</span><h3>24H High / Low Intelligence</h3></div><span className="live-tag"><i/> {tickerState.toUpperCase()}</span></div>
  <div className="sli-level-grid"><LevelCard label="24H HIGH" level={analytics.levels.high} side="high"/><LevelCard label="24H LOW" level={analytics.levels.low} side="low"/></div>
  <div className="sli-metrics">
   <article><small>LAST PRICE</small><b>{price(analytics.last)}</b></article>
   <article><small>24H CHANGE</small><b className={change>0?'up':change<0?'down':''}>{pct(change)}</b></article>
   <article><small>24H RANGE</small><b>{price(analytics.range.absolute)}</b></article>
   <article><small>RANGE POSITION</small><b>{analytics.range.positionPercent==null?'—':analytics.range.positionPercent.toFixed(1)+'%'}</b><small>{analytics.range.location}</small></article>
   <article><small>DISTANCE TO HIGH</small><b>{pct(analytics.proximity.distanceToHighPercent)}</b></article>
   <article><small>DISTANCE TO LOW</small><b>{pct(analytics.proximity.distanceToLowPercent)}</b></article>
  </div>
  <div className="sli-range-track" role="img" aria-label={'Price position within 24-hour range: '+(analytics.range.positionPercent==null?'unavailable':analytics.range.positionPercent.toFixed(1)+' percent')}>
   <span style={{left:(analytics.range.positionPercent??0)+'%'}}/>
  </div>
  <div className="sli-section-title"><span><Waves size={14}/> SESSION OWNERSHIP</span><small>{analytics.candleCount} bars in rolling window</small></div>
  <div className="sli-session-grid">{analytics.sessions.map(session=><article key={session.id}><b>{session.name}</b><span>H {price(session.high)} · L {price(session.low)}</span><small>{session.candles?session.candles+' candles · range '+price(session.range):'No candles in window'}</small></article>)}</div>
  <div className="sli-section-title"><span><Gauge size={14}/> MARKET CONDITION</span><small>Descriptive analytics · no order execution</small></div>
  <div className="sli-condition-grid">
   <article><small>Latest range / average</small><b>{analytics.volatility.latestRangeMultiple==null?'—':analytics.volatility.latestRangeMultiple.toFixed(2)+'×'}</b></article>
   <article><small>Recent volume / baseline</small><b>{analytics.volatility.volumeMultiple==null?'—':analytics.volatility.volumeMultiple.toFixed(2)+'×'}</b></article>
   <article><small>Previous UTC day H / L</small><b>{price(analytics.levels.previousUtcDay.high)} / {price(analytics.levels.previousUtcDay.low)}</b></article>
  </div>
  {!!analytics.alerts.length&&<div className="sli-alerts">{analytics.alerts.map(alert=><p key={alert.code} className={'sli-alert '+alert.severity}><ShieldAlert size={14}/><span>{alert.message}</span></p>)}</div>}
  {!analytics.alerts.length&&<p className="subtle-note"><Activity size={13}/> No 24-hour level interaction or volatility alert is currently confirmed by the loaded data.</p>}
  <p className="subtle-note">{analytics.methodology}</p>
  <button type="button" className="sli-refresh" onClick={()=>setRefresh(value=>value+1)}><RefreshCw size={13}/> Refresh ticker snapshot</button>
 </section>;
}
