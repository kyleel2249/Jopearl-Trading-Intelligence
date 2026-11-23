import React,{useEffect,useMemo,useState} from 'react';
import forecast24h from './range-forecast-engine.js';
import {apiFetch} from './lib/api.js';
import './RangeForecastEngine.css';
const fmt=(v)=>v==null||!Number.isFinite(Number(v))?'—':Number(v).toLocaleString(undefined,{maximumFractionDigits:6});
const pct=v=>v==null?'—':(Number(v)*100).toFixed(1)+'%';
export default function RangeForecastEngine({exchange='bitget',symbol='BTC/USDT',timeframe='1h',onForecastLevels=()=>{}}){
 const [candles,setCandles]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState(''),[forecast,setForecast]=useState(null);
 useEffect(()=>{let active=true;async function load(){setLoading(true);try{const market=symbol.replace('/','-'),r=await apiFetch('/api/exchanges/'+exchange+'/ohlcv/'+encodeURIComponent(market)+'?timeframe='+encodeURIComponent(timeframe)+'&limit=240',{cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'OHLCV feed unavailable');if(active){setCandles(d.candles||[]);setError('');}}catch(e){if(active)setError(e.message);}finally{if(active)setLoading(false);}}load();const timer=setInterval(load,30000);return()=>{active=false;clearInterval(timer);};},[exchange,symbol,timeframe]);
 const result=useMemo(()=>forecast24h(candles,{exchange,symbol,timeframe,simulations:1200}),[candles,exchange,symbol,timeframe]);
 useEffect(()=>{setForecast(result);onForecastLevels(result.status==='ready'?result.chartLevels:[]);},[result,onForecastLevels]);
 if(result.status!=='ready')return <section className="rfe-panel"><header><div><span>RFE · MONTE CARLO RANGE MODEL</span><h3>24-hour High / Low Forecast</h3></div><span>{loading?'Updating':'Awaiting data'}</span></header><p>{error||result.message||'Collecting market candles to run the forecast.'}</p></section>;
 const f=result.forecast,v=result.volatility;
 return <section className="rfe-panel"><header><div><span>RFE · {result.simulations.toLocaleString()} SYNTHETIC PATHS</span><h3>24-hour High / Low Forecast</h3><small>{result.exchange.toUpperCase()} · {result.symbol} · {result.timeframe} · Updated {new Date(result.generatedAt).toLocaleTimeString()}</small></div><span className="rfe-regime">{result.regime}</span></header>
 <div className="rfe-price-grid"><article><small>MEDIAN PROJECTED HIGH</small><strong>{fmt(f.medianHigh)}</strong><em>+{f.highPercent.toFixed(2)}%</em></article><article><small>MEDIAN PROJECTED LOW</small><strong>{fmt(f.medianLow)}</strong><em>{f.lowPercent.toFixed(2)}%</em></article><article><small>24H RANGE MIDPOINT</small><strong>{fmt(f.midpoint)}</strong></article><article><small>MEDIAN CLOSE ESTIMATE</small><strong>{fmt(f.medianClose)}</strong></article></div>
 <div className="rfe-bands"><div><b>70% MODEL RANGE</b><span>High band: {fmt(f.high70[0])} – {fmt(f.high70[1])}</span><span>Low band: {fmt(f.low70[0])} – {fmt(f.low70[1])}</span></div><div><b>90% MODEL RANGE</b><span>High band: {fmt(f.high90[0])} – {fmt(f.high90[1])}</span><span>Low band: {fmt(f.low90[0])} – {fmt(f.low90[1])}</span></div></div>
 <div className="rfe-probabilities"><article><small>TOUCH PRIOR HIGH</small><strong>{pct(result.probabilities.touchPriorHigh)}</strong><span>Historical nearest resistance: {fmt(result.liquidityTargets.above)}</span></article><article><small>TOUCH PRIOR LOW</small><strong>{pct(result.probabilities.touchPriorLow)}</strong><span>Historical nearest support: {fmt(result.liquidityTargets.below)}</span></article><article><small>UPSIDE BEFORE DOWNSIDE</small><strong>{pct(result.probabilities.upsideBeforeDownside)}</strong><span>Path-based model frequency</span></article></div>
 <div className="rfe-vol"><span>Annualized-style proxy is not used. 24h modeled volatility: <b>{v.realized24hPercent.toFixed(2)}%</b></span><span>ATR: {fmt(v.atr)} ({v.atrPercent.toFixed(2)}%)</span><span>Current: {fmt(result.currentPrice)}</span></div>
 <details><summary>Model assumptions and data limitations</summary><ul>{result.dataQuality.limitations.map((x,i)=><li key={i}>{x}</li>)}</ul><p>{result.dataQuality.validCandles} valid candles · Historical candle-return model only · Forecast expires {new Date(result.expiresAt).toLocaleString()}</p></details>
 </section>;
}
