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
async function loadCandles(db,query){const rows=await db.prepare("SELECT observed_at,payload,quality FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol=? AND observation_kind='ohlcv' AND timeframe=? ORDER BY observed_at ASC LIMIT 12000").bind(query.exchange,query.marketType,query.symbol,query.timeframe).all();return(rows.results||[]).map(candle).filter(r=>r.length>=6&&r.every(Number.isFinite));}
async function loadForward(db,strategyId){const rows=await db.prepare("SELECT t.* FROM jpti_paper_trades t JOIN jpti_paper_agents a ON a.agent_id=t.agent_id WHERE t.status='closed' AND (a.agent_id=? OR json_extract(a.payload,'$.strategyId')=?) ORDER BY t.closed_at ASC LIMIT 12000").bind(strategyId,strategyId).all();const trades=(rows.results||[]).map(mapTrade);const metrics=calculatePaperMetrics(trades,PAPER_POLICY.initialEquityUsd);return{...metrics,closedTrades:metrics.closedTrades,riskBreaches:metrics.riskBreaches,observationDays:metrics.observationDays};}
async function loadHistoricalMarketEvents(db,query,from,to,env={}){
 const [stream,micro]=await Promise.all([
  db.prepare("SELECT exchange,event_kind AS kind,observed_at,payload FROM jpti_market_stream_events WHERE exchange=? AND market_type=? AND symbol=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at ASC LIMIT 40000").bind(query.exchange,query.marketType,query.symbol,from,to).all().catch(()=>({results:[]})),
  db.prepare("SELECT exchange,observation_kind AS kind,observed_at,payload FROM jpti_microstructure_observations WHERE exchange=? AND market_type=? AND symbol=? AND observed_at>=? AND observed_at<=? ORDER BY observed_at ASC LIMIT 40000").bind(query.exchange,query.marketType,query.symbol,from,to).all().catch(()=>({results:[]}))
 ]);
 const remote=[];
 const base=String(env.JPTI_MARKET_STREAM_URL||'').replace(/\\/$/,'');
 if(base&&env.JPTI_API_TOKEN){try{const url=new URL(base+'/history');url.searchParams.set('exchange',query.exchange);url.searchParams.set('marketType',query.marketType);url.searchParams.set('symbol',query.symbol);url.searchParams.set('since',from);url.searchParams.set('until',to);url.searchParams.set('limit','20000');const response=await fetch(url,{headers:{'x-jpti-api-token':env.JPTI_API_TOKEN,'accept':'application/json'}});if(response.ok){const body=await response.json();for(const row of body.events||[])remote.push({exchange:query.exchange,kind:row.event_kind,observed_at:row.observedAt,payload:row.payload});}}catch{}}
 const unique=new Map();for(const row of [...(stream.results||[]),...(micro.results||[]),...remote]){const p=safeJson(row.payload,{}),ts=Date.parse(row.observed_at);if(!Number.isFinite(ts))continue;const key=[row.exchange,row.kind,row.observed_at,JSON.stringify(p)].join('|');unique.set(key,{exchange:row.exchange,kind:row.kind,ts,payload:p});}
 return[...unique.values()].sort((a,b)=>a.ts-b.ts);
}
function createMarketDataAt(events,windowMs){
 let cursor=0,active=[];
 return timestamp=>{
  while(cursor<events.length&&events[cursor].ts<=timestamp){active.push(events[cursor++]);}
  const floor=timestamp-windowMs;while(active.length&&active[0].ts<floor)active.shift();
  const books=new Map(),buy=0,sell=0;let buyNotional=0,sellNotional=0;const funding=new Map(),oi=new Map();
  for(const event of active){const p=event.payload||{};
   if(event.kind==='orderbook'){const value=Number(p.reconstructed?.notionalImbalance??p.notionalImbalance);if(Number.isFinite(value))books.set(event.exchange,value);}
   if(event.kind==='trade'){const value=Number(p.quoteNotional??(Number(p.price)*Number(p.quantity)));if(value>0&&p.side==='buy')buyNotional+=value;else if(value>0&&p.side==='sell')sellNotional+=value;}
   if(event.kind==='funding'&&Number.isFinite(Number(p.rate)))funding.set(event.exchange,Number(p.rate));
   if(event.kind==='open_interest'&&Number.isFinite(Number(p.openInterest)))oi.set(event.exchange,Number(p.openInterest));
  }
  const bookValues=[...books.values()],flowTotal=buyNotional+sellNotional;
  return{orderBookImbalance:bookValues.length?bookValues.reduce((a,b)=>a+b,0)/bookValues.length:null,tradeFlowImbalance:flowTotal?(buyNotional-sellNotional)/flowTotal:null,fundingRate:funding.size?[...funding.values()].reduce((a,b)=>a+b,0)/funding.size:null,openInterest:oi.size?[...oi.values()].reduce((a,b)=>a+b,0)/oi.size:null,venues:[...new Set(active.map(x=>x.exchange))],eventCount:active.length};
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
  const marketEvents=await loadHistoricalMarketEvents(env.JPTI_DB,query,from,to,env),marketDataAt=createMarketDataAt(marketEvents,TIMEFRAME_MS[query.timeframe]);
  const replay=replayStrategy({candles,strategyId:query.strategyId,startingEquity:10000,riskPerTradePct:.25,feeRate:.0006,slippageBps:5,spreadBps:3,maxDrawdownPct:10,monteCarloIterations:1000,marketDataAt});
  if(replay.status!=='completed')return json(409,{error:'Historical replay could not complete.',replay,promotion:'BLOCKED',liveExecutionAuthorized:false});
  const forward=await loadForward(env.JPTI_DB,query.strategyId);
  const decayRatio=replay.backtest.expectancyR>0?forward.expectancyR/replay.backtest.expectancyR:null;
  const decayDetected=decayRatio!==null&&(decayRatio<.5||forward.profitFactor<replay.backtest.profitFactor*.5);
  const evidence={backtest:replay.backtest,outOfSample:replay.outOfSample,monteCarlo:replay.monteCarlo,forward,risk:{riskBreaches:replay.risk.riskBreaches+forward.riskBreaches},decayRatio,decayDetected,evidenceAgeHours:0};
  const verdict=evaluateStrategyEvidence(evidence),createdAt=new Date().toISOString(),runId=crypto.randomUUID(),status=verdict.passed?'LIVE_READY':'RESEARCH_ONLY';
  if(body.submit===true){await env.JPTI_DB.prepare('INSERT INTO jpti_strategy_validation_runs(run_id,strategy_id,symbol,exchange,market_type,timeframe,status,candle_count,backtest_json,heldout_json,monte_carlo_json,forward_json,risk_json,verdict_json,data_from,data_to,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(runId,query.strategyId,query.symbol,query.exchange,query.marketType,query.timeframe,status,candles.length,JSON.stringify(replay.backtest),JSON.stringify(replay.outOfSample),JSON.stringify(replay.monteCarlo),JSON.stringify(forward),JSON.stringify(evidence.risk),JSON.stringify(verdict),from,to,createdAt).run();}
  return json(200,{runId,strategyId:query.strategyId,status,submitted:body.submit===true,candleCount:candles.length,marketDataEvents:marketEvents.length,backtest:replay.backtest,outOfSample:replay.outOfSample,monteCarlo:replay.monteCarlo,forward,risk:evidence.risk,decay:{ratio:decayRatio,detected:decayDetected},verdict,liveExecutionAuthorized:false,humanApprovalRequired:true,note:'Server-generated evidence only. Client-supplied pass flags and metrics are ignored; no exchange orders can be placed.'});
 }catch(error){const missing=/no such table/i.test(String(error?.message||''));return json(missing?503:400,{error:missing?'Required validation or market-history table is missing. Apply migrations 0014, 0016 and 0017; promotion is blocked.':String(error?.message||error).slice(0,260),liveExecutionAuthorized:false,promotion:'BLOCKED'});}
}
