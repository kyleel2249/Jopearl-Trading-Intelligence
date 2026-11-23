import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowDownRight, ArrowUpRight, AudioLines, Command, CornerDownLeft, Gauge, Radio, RefreshCw, ShieldCheck, TerminalSquare, TrendingUp, X } from 'lucide-react';
import { apiFetch } from './lib/api.js';
import { parseTerminalCommand } from './terminalCommands.js';

const DEFAULT_WATCHLIST = ['BTC/USDT','ETH/USDT','SOL/USDT','XRP/USDT'];
const WORKSPACES = ['Overview','Spot & Markets','Futures','AI Intelligence','Market Scanner','Financial & On-chain','Portfolio & Ledger','Risk Management','Trading Bots','Universal Engine','Backtesting Lab','Forecast & Strategy','Walk-Forward Lab','News & Events','Connection Settings'];
const fmt = value => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined,{maximumFractionDigits:6});
function readWatchlist(){try{const value=JSON.parse(localStorage.getItem('jpti.phase9.watchlist')||'null');return Array.isArray(value)?value.filter(x=>typeof x==='string').slice(0,12):DEFAULT_WATCHLIST;}catch{return DEFAULT_WATCHLIST;}}
function Metric({label,value,detail,icon:Icon,tone='blue'}){return <article className={'p9-metric tone-'+tone}><span className="p9-metric-icon"><Icon size={16}/></span><small>{label}</small><b>{value}</b><em>{detail}</em></article>;}

export default function InstitutionalTerminal({currentSymbol='BTC/USDT',onSymbolChange=()=>{},onNavigate=()=>{}}){
  const [watchlist,setWatchlist]=useState(readWatchlist);
  const [quotes,setQuotes]=useState([]);
  const [quoteStatus,setQuoteStatus]=useState('idle');
  const [quoteUpdated,setQuoteUpdated]=useState(null);
  const [command,setCommand]=useState('');
  const [history,setHistory]=useState([{kind:'system',text:'JPTI institutional terminal initialized. Type HELP to inspect available commands.'}]);
  const [apiState,setApiState]=useState({gateway:'checking',mode:'paper',scheduler:'unknown',jobs:0});
  const [activeTab,setActiveTab]=useState('COMMAND');
  const [apiToken,setApiToken]=useState('');
  const [risk,setRisk]=useState(null);
  const [riskStatus,setRiskStatus]=useState('not-run');
  const inputRef=useRef(null);
  const historyRef=useRef(null);
  const append=(kind,text)=>setHistory(items=>[...items.slice(-99),{kind,text,at:new Date().toISOString()}]);
  const refreshQuotes=useCallback(async()=>{
    setQuoteStatus('loading');
    try{
      const rows=await Promise.all(watchlist.map(async symbol=>{
        const response=await apiFetch('/api/exchanges/compare/ticker?symbol='+encodeURIComponent(symbol)+'&exchanges=binance,bitget,bybit,okx',{cache:'no-store'});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error||'Quote unavailable');
        return {symbol,...data};
      }));
      setQuotes(rows);setQuoteUpdated(new Date().toISOString());setQuoteStatus('live');
    }catch(error){setQuoteStatus('error');append('warning','Market data refresh: '+error.message);}
  },[watchlist]);
  const refreshStatus=useCallback(async()=>{
    try{
      const [h,o]=await Promise.all([apiFetch('/api/health',{cache:'no-store'}),apiFetch('/api/operations/overview',{cache:'no-store'})]);
      const health=await h.json(),ops=await o.json();
      setApiState({gateway:h.ok&&health.status==='ok'?'online':'offline',mode:health.mode||'paper',scheduler:ops.schedulerEnabled?'enabled':'disabled',jobs:(ops.jobs||[]).length});
    }catch{setApiState(s=>({...s,gateway:'offline'}));}
  },[]);
  useEffect(()=>{refreshQuotes();refreshStatus();const timer=setInterval(()=>{refreshQuotes();refreshStatus();},15000);return()=>clearInterval(timer);},[refreshQuotes,refreshStatus]);
  useEffect(()=>{try{localStorage.setItem('jpti.phase9.watchlist',JSON.stringify(watchlist));}catch{}},[watchlist]);
  useEffect(()=>{if(historyRef.current)historyRef.current.scrollTop=historyRef.current.scrollHeight;},[history]);
  const addSymbol=symbol=>{const normalized=String(symbol||'').trim().toUpperCase().replace('-', '/');if(!/^[A-Z0-9._]{2,20}\/[A-Z0-9._]{2,20}$/.test(normalized))return append('error','Invalid symbol. Use BASE/QUOTE, for example BTC/USDT.');if(watchlist.includes(normalized))return append('info',normalized+' is already on the watchlist.');if(watchlist.length>=12)return append('warning','Watchlist limit is 12 markets. Remove a market first.');setWatchlist(items=>[...items,normalized]);append('success','Added '+normalized+' to the local watchlist.');};
  const runCommand=async(raw)=>{
    const parsed=parseTerminalCommand(raw,WORKSPACES);
    append('input','operator@jpti:~$ '+raw);
    if(parsed.error){append('error',parsed.error);return;}
    switch(parsed.action){
      case 'help': append('system','COMMANDS  HELP · STATUS · REFRESH · OPEN <workspace> · SYMBOL <BASE/QUOTE> · WATCH <BASE/QUOTE> · UNWATCH <BASE/QUOTE> · RISK');append('system','Workspace names may be quoted. Commands are local UI controls; no shell or arbitrary code is executed.');break;
      case 'status': append('system','GATEWAY '+apiState.gateway.toUpperCase()+' · MODE '+apiState.mode.toUpperCase()+' · SCHEDULER '+apiState.scheduler.toUpperCase()+' · SERVICES '+apiState.jobs);append('system','MARKET FEED '+quoteStatus.toUpperCase()+' · WATCHLIST '+watchlist.length+' · LIVE EXECUTION LOCKED BY DEFAULT');break;
      case 'refresh': await Promise.all([refreshQuotes(),refreshStatus()]);append('success','Market and service telemetry refresh requested.');break;
      case 'open': onNavigate(parsed.value);append('success','Workspace selected: '+parsed.value);break;
      case 'symbol': onSymbolChange(parsed.value);append('success','Active chart symbol set to '+parsed.value+'.');break;
      case 'watch': addSymbol(parsed.value);break;
      case 'unwatch': if(!watchlist.includes(parsed.value))append('warning',parsed.value+' is not on the watchlist.');else{setWatchlist(items=>items.filter(x=>x!==parsed.value));append('success','Removed '+parsed.value+' from the watchlist.');}break;
      case 'risk':
        setRiskStatus('loading');
        try{const response=await apiFetch('/api/advanced/portfolio/risk',{headers:{'x-jpti-api-token':apiToken},cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'Risk analysis unavailable');setRisk(data);setRiskStatus('ready');append('success','Portfolio risk snapshot loaded. Review sample counts and data-quality warnings.');}
        catch(error){setRiskStatus('error');append('error','Risk analysis: '+error.message);}
        break;
      default: append('error','Unsupported command. Type HELP.');
    }
  };
  const submit=event=>{event.preventDefault();const raw=command.trim();if(!raw)return;setCommand('');runCommand(raw);};
  const marketRows=useMemo(()=>quotes.map(q=>({symbol:q.symbol,median:q.medianLast,spread:q.lastPriceSpreadPercent,venues:q.venueCount,observed:q.venues?.[0]?.timestamp})),[quotes]);
  return <div className="p9-terminal">
    <div className="p9-terminal-banner"><div><div className="p9-kicker"><span className="p9-live-dot"/> INSTITUTIONAL WORKSTATION <span className="p9-version">PHASE 09</span></div><h2>Command <em>Terminal</em></h2><p>Market intelligence, operator controls and risk visibility in one disciplined workspace.</p></div><div className="p9-banner-actions"><span className={'p9-state '+(apiState.gateway==='online'?'is-online':'is-offline')}><i/>{apiState.gateway==='online'?'GATEWAY ONLINE':'GATEWAY OFFLINE'}</span><span className="p9-paper"><ShieldCheck size={13}/> PAPER-FIRST</span></div></div>
    <div className="p9-metrics"><Metric label="API GATEWAY" value={apiState.gateway==='online'?'ONLINE':'OFFLINE'} detail="Local service health" icon={Activity} tone="blue"/><Metric label="EXECUTION MODE" value={apiState.mode.toUpperCase()} detail="Live orders remain locked" icon={ShieldCheck} tone="green"/><Metric label="MARKET WATCHLIST" value={watchlist.length+'/12'} detail={quoteStatus==='live'?'Public ticker snapshots':'Awaiting verified feed'} icon={Radio} tone="violet"/><Metric label="SCHEDULER" value={apiState.scheduler.toUpperCase()} detail={apiState.jobs+' registered services'} icon={Gauge} tone="amber"/></div>
    <div className="p9-terminal-grid">
      <section className="p9-panel p9-command-panel"><div className="p9-panel-head"><div><span className="p9-eyebrow">OPERATOR CONSOLE</span><h3><TerminalSquare size={17}/> Command interface</h3></div><button className="p9-icon-button" onClick={()=>setHistory([])} title="Clear terminal"><X size={15}/></button></div><div className="p9-console" ref={historyRef} role="log" aria-live="polite">{history.map((line,index)=><div className={'p9-line p9-'+line.kind} key={index}><span>{line.kind==='input'?'›':line.kind==='error'?'!':line.kind==='success'?'✓':'·'}</span><code>{line.text}</code></div>)}</div><form className="p9-command-form" onSubmit={submit}><span>jpti@operator</span><input ref={inputRef} value={command} onChange={e=>setCommand(e.target.value)} placeholder="Enter command — try HELP" aria-label="Terminal command"/><button type="submit" aria-label="Run command"><CornerDownLeft size={16}/></button></form><div className="p9-command-hints"><button onClick={()=>runCommand('HELP')}>HELP</button><button onClick={()=>runCommand('STATUS')}>STATUS</button><button onClick={()=>runCommand('REFRESH')}>REFRESH</button><button onClick={()=>runCommand('RISK')}>RISK</button></div></section>
      <section className="p9-panel p9-watch-panel"><div className="p9-panel-head"><div><span className="p9-eyebrow">MULTI-VENUE OBSERVATIONS</span><h3><TrendingUp size={17}/> Market watch</h3></div><button className="p9-icon-button" onClick={refreshQuotes} title="Refresh market data"><RefreshCw size={15}/></button></div><div className="p9-table-head"><span>MARKET</span><span>MEDIAN LAST</span><span>VENUES</span><span>DISPERSION</span></div>{marketRows.map(row=><button className="p9-market-row" key={row.symbol} onClick={()=>{onSymbolChange(row.symbol);onNavigate('Spot & Markets');}}><b>{row.symbol}</b><strong>{fmt(row.median)}</strong><span>{row.venues||0}/4</span><em>{row.spread==null?'—':Number(row.spread).toFixed(3)+'%'}</em></button>)}{!marketRows.length&&<div className="p9-empty">{quoteStatus==='loading'?'Connecting to public exchange feeds…':'No verified ticker observations. Start the local API and refresh.'}</div>}<div className="p9-add-market"><input id="p9-add-market" placeholder="Add market e.g. ADA/USDT" onKeyDown={e=>{if(e.key==='Enter'){addSymbol(e.currentTarget.value);e.currentTarget.value='';}}}/><span>ENTER TO ADD</span></div><small className="p9-footnote">Public ticker observations only. Not an executable arbitrage quote; fees, depth and latency are excluded. Updated {quoteUpdated?new Date(quoteUpdated).toLocaleTimeString():'—'}.</small></section>
    </div>
    <div className="p9-lower-grid"><section className="p9-panel"><div className="p9-panel-head"><div><span className="p9-eyebrow">WORKSPACE ROUTING</span><h3><Command size={17}/> Quick navigation</h3></div></div><div className="p9-workspace-grid">{WORKSPACES.slice(0,12).map(name=><button key={name} onClick={()=>onNavigate(name)}>{name}<span>↗</span></button>)}</div></section><section className="p9-panel p9-risk-panel"><div className="p9-panel-head"><div><span className="p9-eyebrow">QUANTITATIVE CONTROL</span><h3><ShieldCheck size={17}/> Portfolio risk snapshot</h3></div><span className={'p9-state '+(riskStatus==='ready'?'is-online':'is-muted')}>{riskStatus.replaceAll('-',' ').toUpperCase()}</span></div><p>Retrieve ledger-backed exposure, historical VaR and stress metrics. Private API authorization is required unless local private access is explicitly enabled.</p><input type="password" value={apiToken} onChange={e=>setApiToken(e.target.value)} placeholder="Local JPTI API token (held in memory only)"/><button className="p9-primary" onClick={()=>runCommand('RISK')} disabled={riskStatus==='loading'}>{riskStatus==='loading'?'Calculating…':'Run risk analysis'}</button>{risk&&<div className="p9-risk-results">{risk.portfolios?.map(p=><div key={p.quoteCurrency}><b>{p.quoteCurrency} · {fmt(p.grossExposure)} gross exposure</b><span>VaR 95% {p.historical?.var95Percent==null?'—':p.historical.var95Percent.toFixed(2)+'%'} · ES 95% {p.historical?.expectedShortfall95Percent==null?'—':p.historical.expectedShortfall95Percent.toFixed(2)+'%'}</span><small>{p.historical?.observations||0} observations · {p.positions?.length||0} positions</small></div>)}{!risk.portfolios?.length&&<small>No marked ledger positions available. No risk value has been fabricated.</small>}<small>{risk.limitations?.join(' ')}</small></div>}</section></div>
    <div className="p9-terminal-footer"><span><AudioLines size={13}/> MARKET DATA IS INDICATIVE</span><span>NO SHELL ACCESS · NO ARBITRARY CODE EXECUTION</span><span><ShieldCheck size={13}/> LIVE EXECUTION LOCKED</span></div>
  </div>;
}
