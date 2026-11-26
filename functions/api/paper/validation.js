import { verifyPrivateToken } from '../../private-auth.js';
import { replayStrategy } from '../../../src/strategy-replay-engine.js';
import { calculatePaperMetrics, PAPER_POLICY } from '../../../src/paper-trading-engine.js';
import { evaluateStrategyEvidence } from '../../../src/strategy-validation-engine.js';

const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:H});
const safeJson=(v,f={})=>{try{return typeof v==='string'?JSON.parse(v):v??f;}catch{return f;}};
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const TIMEFRAME_MS={'1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,'1h':3600000,'2h':7200000,'4h':14400000,'1d':86400000};

function candle(row){const p=safeJson(row.payload,{});if(Array.isArray(p))return p.map(Number);const t=Date.parse(row.observed_at)||n(p.timestamp||p.ts);return[t,n(p.open??p.o),n(p.high??p.h),n(p.low??p.l),n(p.close??p.c),n(p.volume??p.v)];}
function mapTrade(row){const p=safeJson(row.payload,{});return{...p,status:row.status,openedAt:row.opened_at,closedAt:row.closed_at,netPnlUsd:n(row.net_pnl_usd),rMultiple:n(row.r_multiple),riskBreach:p.riskBreach===true};}
async function loadCandles(db,query){const upper=query.timeframe==='1h'?'1H':query.timeframe;const compact=query.symbol.replace('/','');const rows=await db.prepare("SELECT observed_at,payload,quality FROM (SELECT observed_at,payload,quality FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe IN (?,?) ORDER BY observed_at DESC LIMIT 12000) ORDER BY observed_at ASC").bind(query.exchange,query.marketType,query.symbol,compact,query.timeframe,upper).all();return(rows.results||[]).map(candle).filter(r=>r.length>=6&&r.every(Number.isFinite));}
async function loadTimeframes(db,query){const labels=['5m','15m'];const entries=await Promise.all(labels.map(async timeframe=>{const compact=query.symbol.replace('/','');const rows=await db.prepare("SELECT observed_at,payload FROM (SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe=? ORDER BY observed_at DESC LIMIT 12000) ORDER BY observed_at ASC").bind(query.exchange,query.marketType,query.symbol,compact,timeframe).all().catch(()=>({results:[]}));return[timeframe,(rows.results||[]).map(candle).filter(r=>r.length>=6&&r.every(Number.isFinite))];}));const hour=await db.prepare("SELECT observed_at,payload FROM (SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol=? AND observation_kind='ohlcv' AND timeframe IN ('1h','1H') ORDER BY observed_at DESC LIMIT 12000) ORDER BY observed_at ASC").bind(query.exchange,query.marketType,query.symbol).all().catch(()=>({results:[]}));entries.push(['1H',(hour.results||[]).map(candle).filter(r=>r.length>=6&&r.every(Number.isFinite))]);return Object.fromEntries(entries);}
function createTimeframesAt(series){return timestamp=>Object.fromEntries(Object.entries(series).map(([label,rows])=>[label,rows.filter(row=>row[0]<=timestamp).slice(-100)]));}
async function loadRiskPolicy(db){try{const row=await db.prepare("SELECT policy_json FROM jpti_risk_policies WHERE policy_id='default'").first();return row?.policy_json?safeJson(row.policy_json,{}):{};}catch{return{};}}
async function loadForward(db,strategyId,symbol){const compact=symbol.replace('/','');const rows=await db.prepare("SELECT t.* FROM jpti_paper_trades t JOIN jpti_paper_agents a ON a.agent_id=t.agent_id WHERE t.status='closed' AND (a.agent_id=? OR json_extract(a.payload,'$.strategyId')=?) AND t.symbol IN (?,?) ORDER BY t.closed_at ASC LIMIT 12000").bind(strategyId,strategyId,symbol,compact).all();const trades=(rows.results||[]).map(mapTrade);const metrics=calculatePaperMetrics(trades,PAPER_POLICY.initialEquityUsd);return{...metrics,closedTrades:metrics.closedTrades,riskBreaches:metrics.riskBreaches,observationDays:metrics.observationDays};}
const SUPPORTED_EXCHANGES=['binance','bybit','okx','bitget'];
export async function loadHistoricalMarketEvents(db,query,from,to,env={}){
 const compact=query.symbol.replace('/','');
 const [stream,micro]=await Promise.all([
  db.prepare("SELECT exchange,event_kind AS kind,event_id,observed_at,payload FROM jpti_market_stream_events WHERE exchange IN ('binance','bybit','okx','bitget') AND market_type=? AND symbol IN (?,?) AND observed_at>=? AND observed_at<=? ORDER BY observed_at ASC LIMIT 80000").bind(query.marketType,query.symbol,compact,from,to).all().catch(()=>({results:[]})),
  db.prepare("SELECT exchange,observation_kind AS kind,event_id,observed_at,payload FROM jpti_microstructure_observations WHERE exchange IN ('binance','bybit','okx','bitget') AND market_type=? AND symbol IN (?,?) AND observed_at>=? AND observed_at<=? ORDER BY observed_at ASC LIMIT 80000").bind(query.marketType,query.symbol,compact,from,to).all().catch(()=>({results:[]}))
 ]);
 const remote=[],base=String(env.JPTI_MARKET_STREAM_URL||'').replace(/\/$/,'');
 const streamFetch=env.JPTI_MARKET_STREAM?.fetch?env.JPTI_MARKET_STREAM.fetch.bind(env.JPTI_MARKET_STREAM):fetch;
 const streamBase=env.JPTI_MARKET_STREAM?'https://jpti-market-stream-collector':base;
 if(streamBase){
  await Promise.all(SUPPORTED_EXCHANGES.map(async exchange=>{
   let cursor=to;
   for(let page=0;page<5;page++){
    try{
     const url=new URL(streamBase+'/history');
     url.searchParams.set('exchange',exchange);url.searchParams.set('marketType',query.marketType);
     url.searchParams.set('symbol',query.symbol);url.searchParams.set('since',from);
     url.searchParams.set('until',cursor);url.searchParams.set('limit','20000');
     const response=await streamFetch(url,{headers:{'accept':'application/json'},signal:AbortSignal.timeout(12000)});
     if(!response.ok)break;
     const body=await response.json(),batch=body.events||[];
     for(const row of batch)remote.push({exchange,kind:row.event_kind,event_id:row.event_id,observed_at:row.observedAt,payload:row.payload});
     if(batch.length<20000)break;
     const oldest=Date.parse(batch[0]?.observedAt||'');
     if(!Number.isFinite(oldest)||oldest<=Date.parse(from))break;
     cursor=new Date(oldest-1).toISOString();
    }catch{break;}
   }
  }));
 }
 const unique=new Map();
 for(const row of [...(stream.results||[]),...(micro.results||[]),...remote]){
  const p=safeJson(row.payload,{}),ts=Date.parse(row.observed_at);
  if(!Number.isFinite(ts)||!SUPPORTED_EXCHANGES.includes(String(row.exchange).toLowerCase()))continue;
  const key=[row.exchange,row.kind,row.event_id||row.observed_at,JSON.stringify(p)].join('|');
  unique.set(key,{exchange:row.exchange,kind:row.kind,ts,payload:p});
 }
 return[...unique.values()].sort((a,b)=>a.ts-b.ts);
}
export function createMarketDataAt(events,windowMs){
 let cursor=0,tradeQueue=[],buyNotional=0,sellNotional=0;
 const books=new Map(),funding=new Map(),oi=new Map();
 return timestamp=>{
  const floor=timestamp-windowMs;
  while(cursor<events.length&&events[cursor].ts<=timestamp){
   const event=events[cursor++],p=event.payload||{};
   if(event.kind==='orderbook'){
    const value=Number(p.reconstructed?.notionalImbalance??p.notionalImbalance);
    const bid=Number(p.reconstructed?.bestBid??p.bestBid),ask=Number(p.reconstructed?.bestAsk??p.bestAsk);
    if(Number.isFinite(value))books.set(event.exchange,{ts:event.ts,imbalance:value,bid,ask});
   }else if(event.kind==='trade'){
    const value=Number(p.quoteNotional??(Number(p.price)*Number(p.quantity)));
    if(value>0&&(p.side==='buy'||p.side==='sell')){
     tradeQueue.push({ts:event.ts,side:p.side,value,exchange:event.exchange});
     if(p.side==='buy')buyNotional+=value;else sellNotional+=value;
    }
   }else if(event.kind==='funding'&&Number.isFinite(Number(p.rate)))funding.set(event.exchange,{ts:event.ts,value:Number(p.rate)});
   else if(event.kind==='open_interest'&&Number.isFinite(Number(p.openInterest)))oi.set(event.exchange,{ts:event.ts,value:Number(p.openInterest)});
  }
  while(tradeQueue.length&&tradeQueue[0].ts<floor){const t=tradeQueue.shift();if(t.side==='buy')buyNotional-=t.value;else sellNotional-=t.value;}
  for(const [exchange,value] of books)if(value.ts<floor)books.delete(exchange);
  for(const [exchange,value] of funding)if(value.ts<floor)funding.delete(exchange);
  for(const [exchange,value] of oi)if(value.ts<floor)oi.delete(exchange);
  const bookValues=[...books.values()],flowTotal=buyNotional+sellNotional;
  const bids=bookValues.map(x=>x.bid).filter(x=>x>0),asks=bookValues.map(x=>x.ask).filter(x=>x>0);
  return{
   orderBookImbalance:bookValues.length?bookValues.reduce((sum,x)=>sum+x.imbalance,0)/bookValues.length:null,
   tradeFlowImbalance:flowTotal?(buyNotional-sellNotional)/flowTotal:null,
   fundingRate:funding.size?[...funding.values()].reduce((sum,x)=>sum+x.value,0)/funding.size:null,
   openInterest:oi.size?[...oi.values()].reduce((sum,x)=>sum+x.value,0)/oi.size:null,
   ticker:bids.length&&asks.length?{bid:bids.reduce((a,b)=>a+b,0)/bids.length,ask:asks.reduce((a,b)=>a+b,0)/asks.length}:null,
   venues:[...new Set([...books.keys(),...funding.keys(),...oi.keys(),...tradeQueue.map(x=>x.exchange).filter(Boolean)])],
   eventCount:tradeQueue.length+books.size+funding.size+oi.size
  };
 };
}
function normalizeQuery(body){const q={strategyId:String(body.strategyId||'').trim(),exchange:String(body.exchange||'bitget').toLowerCase(),marketType:String(body.marketType||'usdt-m').toLowerCase(),symbol:String(body.symbol||'BTC/USDT').toUpperCase(),timeframe:String(body.timeframe||'1m')};if(!/^[a-z0-9_-]{2,48}$/.test(q.strategyId))throw new Error('strategyId is required and must be a valid identifier.');if(!['binance','bybit','okx','bitget'].includes(q.exchange))throw new Error('Unsupported exchange.');if(!['spot','margin','usdt-m','coin-m','usdc-m'].includes(q.marketType))throw new Error('Unsupported market type.');if(!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(q.symbol))throw new Error('Use BASE/QUOTE symbol notation.');if(!Object.hasOwn(TIMEFRAME_MS,q.timeframe))throw new Error('Unsupported timeframe.');return q;}

export async function onRequest({request,env}){
 if(!env.JPTI_DB)return json(503,{error:'D1 binding JPTI_DB is unavailable; strategy validation and promotion are blocked.'});
 const auth=await verifyPrivateToken(request,env,{unconfigured:'JPTI private API token is not configured.',rejected:'Private API authorization failed.'});if(!auth.ok)return json(auth.status,{error:auth.error});
 try{
  if(request.method==='GET'){
   const id=String(new URL(request.url).searchParams.get('strategyId')||'').trim();if(!id)return json(400,{error:'strategyId query parameter is required.'});
   const row=await env.JPTI_DB.prepare('SELECT * FROM jpti_strategy_validation_runs WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1').bind(id).first();
   if(!row)return json(404,{error:'No validation evidence exists for this strategy.',promotion:'BLOCKED',liveExecutionAuthorized:false});
   return json(200,{runId:row.run_id,strategyId:id,status:row.status,candleCount:row.candle_count,backtest:safeJson(row.backtest_json),outOfSample:safeJson(row.heldout_json),monteCarlo:safeJson(row.monte_carlo_json),forward:safeJson(row.forward_json),risk:safeJson(row.risk_json),verdict:safeJson(row.verdict_json),createdAt:row.created_at,liveExecutionAuthorized:false});
  }
  if(request.method!=='POST')return json(405,{error:'Use GET or POST.'});
  const raw=await request.text();if(raw.length>8000)return json(413,{error:'Request exceeds 8 KB.'});
  const body=raw?JSON.parse(raw):{},query=normalizeQuery(body),candles=await loadCandles(env.JPTI_DB,query);
  if(candles.length<60)return json(409,{error:'Insufficient persisted OHLCV history for a defensible replay.',availableCandles:candles.length,requiredCandles:60,promotion:'BLOCKED',liveExecutionAuthorized:false});
  const from=new Date(candles[0][0]).toISOString(),to=new Date(candles.at(-1)[0]).toISOString();
  const [marketEvents,timeframes]=await Promise.all([loadHistoricalMarketEvents(env.JPTI_DB,query,from,to,env),loadTimeframes(env.JPTI_DB,query)]);
  const marketDataAt=createMarketDataAt(marketEvents,TIMEFRAME_MS[query.timeframe]),timeframesAt=createTimeframesAt(timeframes);
  const replay=replayStrategy({candles,strategyId:query.strategyId,startingEquity:10000,riskPerTradePct:.25,feeRate:.0006,slippageBps:5,spreadBps:3,maxDrawdownPct:PAPER_POLICY.maxDrawdownPct,monteCarloIterations:1000,marketDataAt,timeframesAt,riskPolicy:await loadRiskPolicy(env.JPTI_DB)});
  if(replay.status!=='completed')return json(409,{error:'Historical replay could not complete.',replay,promotion:'BLOCKED',liveExecutionAuthorized:false});
  const forward=await loadForward(env.JPTI_DB,query.strategyId,query.symbol);
  const decayRatio=replay.backtest.expectancyR>0?forward.expectancyR/replay.backtest.expectancyR:null;
  const decayDetected=decayRatio!==null&&(decayRatio<.5||forward.profitFactor<replay.backtest.profitFactor*.5);
  const evidence={backtest:replay.backtest,outOfSample:replay.outOfSample,monteCarlo:replay.monteCarlo,forward,risk:{riskBreaches:replay.risk.riskBreaches+forward.riskBreaches,drawdownHalt:replay.risk.drawdownHalt},decayRatio,decayDetected,evidenceAgeHours:(Date.now()-Date.parse(to))/3600000};
  const verdict=evaluateStrategyEvidence(evidence),createdAt=new Date().toISOString(),runId=crypto.randomUUID(),status=verdict.status;
  if(body.submit===true){await env.JPTI_DB.prepare('INSERT INTO jpti_strategy_validation_runs(run_id,strategy_id,symbol,exchange,market_type,timeframe,status,candle_count,backtest_json,heldout_json,monte_carlo_json,forward_json,risk_json,verdict_json,data_from,data_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(runId,query.strategyId,query.symbol,query.exchange,query.marketType,query.timeframe,status,candles.length,JSON.stringify(replay.backtest),JSON.stringify(replay.outOfSample),JSON.stringify(replay.monteCarlo),JSON.stringify(forward),JSON.stringify(evidence.risk),JSON.stringify(verdict),from,to,createdAt).run();}
  return json(200,{runId,strategyId:query.strategyId,status,submitted:body.submit===true,candleCount:candles.length,marketDataEvents:marketEvents.length,marketDataExchanges:[...new Set(marketEvents.map(event=>event.exchange))],backtest:replay.backtest,outOfSample:replay.outOfSample,monteCarlo:replay.monteCarlo,forward,risk:evidence.risk,decay:{ratio:decayRatio,detected:decayDetected},verdict,liveExecutionAuthorized:false,humanApprovalRequired:true,note:'Server-generated evidence only. Client-supplied pass flags and metrics are ignored; no exchange orders can be placed.'});
 }catch(error){const missing=/no such table/i.test(String(error?.message||''));return json(missing?503:400,{error:missing?'Required validation or market-history table is missing. Apply migrations 0014, 0016 and 0017; promotion is blocked.':String(error?.message||error).slice(0,260),liveExecutionAuthorized:false,promotion:'BLOCKED'});}
}
