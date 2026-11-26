import { PAPER_AGENTS, AGENT_RESOURCES, PAPER_POLICY, derivePaperSignal, calculatePaperMetrics, assessAgentKpis, simulatePaperFill, settlePaperTrade } from '../../../src/paper-trading-engine.js';
import { evaluateRiskGate, adaptivePositionSize, updateDynamicStop, buildPartialExitPlan } from '../../../src/intelligence-foundation-engine.js';
import { verifyPrivateToken } from '../../private-auth.js';
import { evaluateTradingWindow } from '../../../src/lib/trading-calendar.js';
import { normalizeStreamRequest } from '../../../src/sequence-aware-stream-engine.js';
import { loadPromotionEvidence } from '../../../src/strategy-validation-engine.js';
import { evaluateAgentSafety, arbitrateAgentIntents } from '../../../src/lib/agent-safety-supervisor.js';
import { evaluateMultiAssetOpportunity } from '../../../src/multi-asset-intelligence-engine.js';

const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-jpti-runtime':'cloudflare-pages-paper'};
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers});
const iso=()=>new Date().toISOString();
const num=v=>Number.isFinite(Number(v))?Number(v):0;
const parseJson=(value,fallback={})=>{try{return JSON.parse(value??'');}catch{return fallback;}};
function authorized(request,env){
 return verifyPrivateToken(request,env,{unconfigured:'JPTI private API token is not configured.',rejected:'Private API authorization failed.'});
}
async function bitget(path){
 const res=await fetch('https://api.bitget.com'+path,{headers:{accept:'application/json'},cf:{cacheTtl:0}});
 if(!res.ok)throw new Error('Bitget public market endpoint returned HTTP '+res.status);
 const data=await res.json();if(String(data.code)!=='00000')throw new Error(data.msg||'Bitget market feed returned an error.');
 return data.data;
}
async function marketSnapshot(symbol,db){
 const normalized=String(symbol||'BTCUSDT').toUpperCase().replace('/','').replace(':USDT','');
 if(!/^[A-Z0-9]{5,24}$/.test(normalized))throw new Error('Invalid market symbol.');
 try{
  const [rawCandles,raw5m,raw15m,raw1h,rawTicker]=await Promise.all([
   bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=1m&limit=100'),
   bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=5m&limit=100'),
   bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=15m&limit=100'),
   bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=1H&limit=100'),
   bitget('/api/v2/mix/market/ticker?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES')
  ]);
  const parseCandles=raw=>(Array.isArray(raw)?raw:[]).map(r=>r.map(Number)).sort((a,b)=>a[0]-b[0]);
  const candles=parseCandles(rawCandles),timeframes={'5m':parseCandles(raw5m),'15m':parseCandles(raw15m),'1H':parseCandles(raw1h)};
  const t=Array.isArray(rawTicker)?rawTicker[0]:rawTicker,ticker={last:num(t?.lastPr),bid:num(t?.bidPr),ask:num(t?.askPr),timestamp:num(t?.ts)};
  if(!(ticker.last>0)||candles.length<36)throw new Error('Bitget returned insufficient valid ticker/candle data.');
  const age=Date.now()-ticker.timestamp;if(!ticker.timestamp||age>30000||age< -5000)throw new Error('Bitget ticker is stale or has an invalid timestamp.');
  return{symbol:normalized,candles,timeframes,ticker,source:'Bitget public USDT-FUTURES',receivedAt:iso(),ageMs:age};
 }catch(bitgetError){
  try{
   const pair=normalized.endsWith('USDT')?normalized.slice(0,-4)+'/USDT':normalized;
   const candidates=await db.prepare("SELECT exchange,market_type,MAX(observed_at) AS last_seen FROM jpti_market_observations WHERE symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe='1m' GROUP BY exchange,market_type ORDER BY last_seen DESC LIMIT 12").bind(normalized,pair).all();
   for(const candidate of candidates.results||[]){
    const [raw1m,raw5m,raw15m,raw1h,tickerRow]=await Promise.all([
     db.prepare("SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe='1m' ORDER BY observed_at DESC LIMIT 100").bind(candidate.exchange,candidate.market_type,normalized,pair).all(),
     db.prepare("SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe='5m' ORDER BY observed_at DESC LIMIT 100").bind(candidate.exchange,candidate.market_type,normalized,pair).all(),
     db.prepare("SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe='15m' ORDER BY observed_at DESC LIMIT 100").bind(candidate.exchange,candidate.market_type,normalized,pair).all(),
     db.prepare("SELECT observed_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ohlcv' AND timeframe IN ('1h','1H') ORDER BY observed_at DESC LIMIT 100").bind(candidate.exchange,candidate.market_type,normalized,pair).all(),
     db.prepare("SELECT observed_at,received_at,payload FROM jpti_market_observations WHERE exchange=? AND market_type=? AND symbol IN (?,?) AND observation_kind='ticker' ORDER BY observed_at DESC LIMIT 1").bind(candidate.exchange,candidate.market_type,normalized,pair).first()
    ]);
    const parseRows=rows=>(rows.results||[]).map(row=>{let p={};try{p=JSON.parse(row.payload||'{}')}catch{}if(Array.isArray(p))return p.map(Number);return[Date.parse(row.observed_at)||num(p.timestamp||p.ts),num(p.open??p.o),num(p.high??p.h),num(p.low??p.l),num(p.close??p.c),num(p.volume??p.v)];}).filter(r=>r.length>=6&&r.every(Number.isFinite)).sort((a,b)=>a[0]-b[0]);
    const candles=parseRows(raw1m),timeframes={'5m':parseRows(raw5m),'15m':parseRows(raw15m),'1H':parseRows(raw1h)};
    let p={};try{p=JSON.parse(tickerRow?.payload||'{}')}catch{}const timestamp=Date.parse(tickerRow?.observed_at)||num(p.timestamp||p.ts),ticker={last:num(p.last??p.lastPr??p.price??p.close),bid:num(p.bid??p.bidPr),ask:num(p.ask??p.askPr),timestamp};
    const age=Date.now()-timestamp;if(candles.length>=36&&ticker.last>0&&timestamp&&age<=120000&&age>=-5000)return{symbol:normalized,candles,timeframes,ticker,source:candidate.exchange+' '+candidate.market_type+' persisted D1 fallback',receivedAt:iso(),ageMs:age};
   }
   throw new Error('No fresh replicated OHLCV and ticker set was available.');
  }catch(fallbackError){throw new Error('Primary Bitget feed unavailable ('+String(bitgetError?.message||bitgetError).slice(0,100)+'); cross-exchange D1 fallback unavailable ('+String(fallbackError?.message||fallbackError).slice(0,120)+').');}
 }
}
export async function ensureAgents(db){
 for(const agent of PAPER_AGENTS){
  await db.prepare("INSERT OR IGNORE INTO jpti_paper_agents(agent_id,tier,virtual_equity_usd,status,payload) VALUES (?,'RESEARCH',?,'active',?)")
   .bind(agent.id,PAPER_POLICY.initialEquityUsd,JSON.stringify({...agent,permissions:{paper:true,live:false}})).run();
 }
}
async function loadAgents(db){
 const rows=await db.prepare("SELECT agent_id,tier,virtual_equity_usd,status,promoted_at,payload FROM jpti_paper_agents ORDER BY agent_id").all();
 return (rows.results||[]).map(row=>{let p={};try{p=JSON.parse(row.payload||'{}')}catch{}
  return {...p,id:row.agent_id,tier:row.tier,status:row.status,virtualEquityUsd:num(row.virtual_equity_usd),promotedAt:row.promoted_at||null,permissions:{paper:true,live:false}};
 });
}
async function spawnSuccessor(db,agent){
 const generation=num(agent.generation||1)+1,id=agent.id+'-g'+generation+'-'+Date.now().toString(36);
 const successor={id,name:agent.name+' '+generation,role:agent.role+' · Candidate '+generation,responsibility:agent.responsibility,edge:agent.edge,strategyId:agent.strategyId,generation,tier:'RESEARCH',status:'active',promotedAt:null,resources:[...AGENT_RESOURCES],permissions:{paper:true,live:false},parentAgentId:agent.id,createdAt:iso(),lifecycleNote:'Automatic successor; starts with $1 virtual capital.'};
 await db.prepare("INSERT OR IGNORE INTO jpti_paper_agents(agent_id,tier,virtual_equity_usd,status,payload) VALUES (?,'RESEARCH',?,'active',?)").bind(id,PAPER_POLICY.initialEquityUsd,JSON.stringify(successor)).run();
 return successor;
}
async function promoteOrRetire(db,agent,metrics,kpi){
 const row=await db.prepare('SELECT tier,status FROM jpti_paper_agents WHERE agent_id=?').bind(agent.id).first();
 if(!row)return null;
 const evidence=await loadPromotionEvidence(db,agent.strategyId||agent.id);
 if(evidence.allowed&&row.tier==='RESEARCH'){
  const at=iso(),payload={...agent,tier:'LIVE_READY',status:'live_ready',promotedAt:at,liveReadiness:{approved:false,liveExecutionAuthorized:false,requiresHumanApproval:true,validationStatus:evidence.verdict?.status||'LIVE_READY'},resources:[...AGENT_RESOURCES,'Live deployment and exchange-minimum preflight']};
  await db.prepare("UPDATE jpti_paper_agents SET tier='LIVE_READY',status='live_ready',promoted_at=?,updated_at=?,payload=? WHERE agent_id=?").bind(at,at,JSON.stringify(payload),agent.id).run();
  const successor=await spawnSuccessor(db,agent);
  return {status:'LIVE_READY',promotedAt:at,successorId:successor.id};
 }
 if(metrics.maxDrawdownPct>=PAPER_POLICY.maxDrawdownPct&&row.status==='active'){
  const at=iso(),payload={...agent,status:'suspended',suspensionReason:'Maximum drawdown limit reached.',suspendedAt:at,permissions:{paper:false,live:false}};
  await db.prepare("UPDATE jpti_paper_agents SET status='suspended',updated_at=?,payload=? WHERE agent_id=?").bind(at,JSON.stringify(payload),agent.id).run();
  return {status:'SUSPENDED',reason:payload.suspensionReason};
 }
 if(metrics.closedTrades>=100&&metrics.netPnlUsd<0&&metrics.profitFactor<0.8&&metrics.expectancyR<0&&(row.status==='active'||row.status==='suspended')){
  const at=iso(),payload={...agent,status:'retired',retiredAt:at,retirementReason:'Persistent negative expectancy and weak profit factor after 100 closed trades.',permissions:{paper:false,live:false}};
  await db.prepare("UPDATE jpti_paper_agents SET status='retired',updated_at=?,payload=? WHERE agent_id=?").bind(at,JSON.stringify(payload),agent.id).run();
  const successor=await spawnSuccessor(db,agent);
  return {status:'RETIRED',reason:payload.retirementReason,successorId:successor.id};
 }
 return null;
}
async function allTrades(db,agentId){
 const q=agentId
 ?await db.prepare('SELECT * FROM jpti_paper_trades WHERE agent_id=? ORDER BY opened_at DESC LIMIT 3000').bind(agentId).all()
 :await db.prepare('SELECT * FROM jpti_paper_trades ORDER BY opened_at DESC LIMIT 10000').all();
 return q.results||[];
}
function toTrade(row){let p={};try{p=JSON.parse(row.payload||'{}')}catch{}return {...row,...p,tradeId:row.trade_id,agentId:row.agent_id,status:row.status,openedAt:row.opened_at,closedAt:row.closed_at,entryPrice:row.entry_price,exitPrice:row.exit_price,quantity:row.quantity,riskUsd:row.risk_usd,entryFeeUsd:row.entry_fee_usd,exitFeeUsd:row.exit_fee_usd,netPnlUsd:row.net_pnl_usd,grossPnlUsd:row.gross_pnl_usd,rMultiple:row.r_multiple,regime:row.regime};}
async function saveAgent(db,agentId,metrics,kpi,tier){
 await db.prepare("UPDATE jpti_paper_agents SET tier=?,virtual_equity_usd=?,updated_at=?,payload=json_set(payload,'$.metrics',json(?),'$.kpi',json(?)) WHERE agent_id=?")
 .bind(tier,Math.max(0,PAPER_POLICY.initialEquityUsd+metrics.netPnlUsd),iso(),JSON.stringify(metrics),JSON.stringify(kpi),agentId).run();
}
/**
 * Mark-to-market for the daily-loss circuit breaker. A position can only be marked with the price of
 * its own symbol; positions on other symbols are carried at entry (entry fee only) instead of being
 * valued with an unrelated market's price, which previously produced spurious circuit-breaker exits.
 */
export function unrealizedPnlForSymbol(openTrades,symbol,lastPrice,feeRate){
 return (openTrades||[]).reduce((sum,t)=>{
  if(t.symbol!==symbol)return sum-num(t.entryFeeUsd);
  const move=(lastPrice-num(t.entryPrice))*num(t.quantity)*(t.direction==='LONG'?1:-1);
  return sum+move-num(t.entryFeeUsd)-lastPrice*num(t.quantity)*feeRate;
 },0);
}
export async function loadLiveMarketContext(db,marketSymbol,env={}){
 const rawSymbol=String(marketSymbol||'').toUpperCase();
 const pair=rawSymbol.includes('/')?rawSymbol:rawSymbol.endsWith('USDT')?rawSymbol.slice(0,-4)+'/USDT':rawSymbol;
 const compact=pair.replace('/','');
 const safe=async sql=>{try{return(await db.prepare(sql).bind(pair,compact).all()).results||[];}catch{return[];}};
 const [books,events,micro,streamStates]=await Promise.all([
  safe("SELECT exchange,market_type,symbol,last_sequence,book_valid,best_bid,best_ask,spread_bps,depth_imbalance,notional_imbalance,book_json,updated_at FROM jpti_market_stream_books WHERE symbol IN (?,?) ORDER BY updated_at DESC LIMIT 40"),
  safe("SELECT exchange,market_type,symbol,event_kind,event_id,sequence,observed_at,received_at,payload,quality FROM jpti_market_stream_events WHERE symbol IN (?,?) ORDER BY observed_at DESC LIMIT 500"),
  safe("SELECT exchange,market_type,symbol,observation_kind,event_id,observed_at,received_at,payload,quality FROM jpti_microstructure_observations WHERE symbol IN (?,?) ORDER BY observed_at DESC LIMIT 500"),
  safe("SELECT exchange,market_type,symbol,status,last_sequence,book_valid,last_event_at,updated_at FROM jpti_market_stream_state WHERE symbol IN (?,?) ORDER BY updated_at DESC LIMIT 40")
 ]);
 const parse=v=>{try{return JSON.parse(v||'{}')}catch{return{};}};
 const remote=[],since=new Date(Date.now()-120000).toISOString(),until=new Date().toISOString();
 const streamFetch=env.JPTI_MARKET_STREAM?.fetch?env.JPTI_MARKET_STREAM.fetch.bind(env.JPTI_MARKET_STREAM):fetch;
 const base=String(env.JPTI_MARKET_STREAM_URL||'').replace(/\/$/,'');
 const streamBase=env.JPTI_MARKET_STREAM?'https://jpti-market-stream-collector':base;
 const requests=[];
 for(const exchange of ['binance','bybit','okx','bitget'])for(const marketType of ['spot','usdt-m']){
  requests.push((async()=>{
   try{
    let response;
    if(env.MARKET_STREAMS){
     const config=normalizeStreamRequest({exchange,marketType,symbol:pair});
     const stub=env.MARKET_STREAMS.get(env.MARKET_STREAMS.idFromName(config.streamId));
     const url=new URL('https://stream-hub/history');url.searchParams.set('since',since);url.searchParams.set('until',until);url.searchParams.set('limit','2000');
     response=await stub.fetch(url.toString());
    }else if(streamBase){
     const url=new URL(streamBase+'/history');url.searchParams.set('exchange',exchange);url.searchParams.set('marketType',marketType);
     url.searchParams.set('symbol',pair);url.searchParams.set('since',since);url.searchParams.set('until',until);url.searchParams.set('limit','2000');
     response=await streamFetch(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)});
    }else return;
    if(response.ok){const body=await response.json();remote.push(...(body.events||[]).map(x=>({exchange,market_type:marketType,event_kind:x.event_kind,event_id:x.event_id,observed_at:x.observedAt,received_at:x.received_at,payload:x.payload,quality:x.quality})));}
   }catch{/* D1 indexes remain available when an individual stream is temporarily unavailable. */}
  })());
 }
 await Promise.all(requests);
 const eventCandidates=[...events.map(x=>({...x,payload:parse(x.payload),quality:parse(x.quality)})),...micro.map(x=>({...x,event_kind:x.observation_kind,payload:parse(x.payload),quality:parse(x.quality)})),...remote];
 const seenEvents=new Set(),parseEvents=eventCandidates.filter(x=>{const key=[x.exchange,x.market_type,x.event_kind,x.event_id||x.observed_at].join('|');if(seenEvents.has(key))return false;seenEvents.add(key);return true;});
 const now=Date.now(),freshnessMs=60000;
 const freshEvents=parseEvents.filter(x=>{const at=Date.parse(x.received_at||x.observed_at||'');return Number.isFinite(at)&&now-at<=freshnessMs&&at-now<=30000;});
 const latestBooks=new Map();
 for(const row of books){const updated=Date.parse(row.updated_at||'');if(Number(row.book_valid)!==1||!Number.isFinite(updated)||now-updated>freshnessMs||updated-now>30000)continue;const value=Number(row.notional_imbalance);if(Number.isFinite(value))latestBooks.set(row.exchange+'|'+row.market_type,{imbalance:value,bid:Number(row.best_bid),ask:Number(row.best_ask),marketType:row.market_type});}
 const eventBooks=new Map(),quotes=new Map(),funding=new Map(),openInterest=new Map();
 let buy=0,sell=0,liquidationBuy=0,liquidationSell=0;
 for(const row of freshEvents){
  const p=row.payload||{},key=row.exchange+'|'+row.market_type;
  if(row.event_kind==='orderbook'&&row.quality?.bookValid===true){
   const raw=p.reconstructed||p,value=Number(raw.notionalImbalance??p.notionalImbalance),bid=Number(raw.bestBid??p.bestBid),ask=Number(raw.bestAsk??p.bestAsk);
   if(Number.isFinite(value))eventBooks.set(key,{imbalance:value,bid,ask,marketType:row.market_type});
   if(bid>0&&ask>0)quotes.set(key,{bid,ask});
  }
  if(row.event_kind==='ticker'){const bid=Number(p.bid??p.bidPrice??p.bidPr),ask=Number(p.ask??p.askPrice??p.askPr);if(bid>0&&ask>0)quotes.set(key,{bid,ask});}
  if(row.event_kind==='trade'){const value=Number(p.quoteNotional??Number(p.price)*Number(p.quantity));if(value>0&&p.side==='buy')buy+=value;else if(value>0&&p.side==='sell')sell+=value;}
  if(row.event_kind==='funding'&&Number.isFinite(Number(p.rate)))funding.set(key,Number(p.rate));
  if(row.event_kind==='open_interest'&&Number.isFinite(Number(p.openInterest)))openInterest.set(key,Number(p.openInterest));
  if(row.event_kind==='liquidation'){const value=Number(p.quoteNotional??Number(p.price)*Number(p.quantity));if(value>0&&p.side==='buy')liquidationBuy+=value;else if(value>0&&p.side==='sell')liquidationSell+=value;}
 }
 const mergedBooks=new Map([...latestBooks,...eventBooks]),allBooks=[...mergedBooks.values()],preferred=allBooks.filter(x=>x.marketType==='usdt-m'),bookValues=preferred.length?preferred:allBooks;
 const quoteValues=[...quotes.values(),...bookValues.filter(x=>x.bid>0&&x.ask>0)],total=buy+sell;
 const bids=quoteValues.map(x=>x.bid).filter(x=>x>0),asks=quoteValues.map(x=>x.ask).filter(x=>x>0);
 const invalidStreamStates=streamStates.filter(x=>['gap','reconnecting','connecting','stopped','failed'].includes(String(x.status||'').toLowerCase())||Number(x.book_valid)!==1);
 const bookValid=allBooks.length>0?true:streamStates.length?false:undefined;
 const bookHealth={valid:bookValid,validVenueBooks:allBooks.length,streams:streamStates.length,invalidStreams:invalidStreamStates.length,checkedAt:new Date(now).toISOString()};
 return{
  symbol:pair,orderBooks:books.map(x=>({...x,book:parse(x.book_json)})),streamEvents:parseEvents,freshStreamEvents:freshEvents,microstructure:micro,streamStates,
  bookValid,bookHealth,venues:[...new Set([...books,...parseEvents].map(x=>x.exchange))],
  orderBookImbalance:bookValues.length?bookValues.reduce((a,b)=>a+b.imbalance,0)/bookValues.length:null,
  tradeFlowImbalance:total?(buy-sell)/total:null,
  fundingRate:funding.size?[...funding.values()].reduce((a,b)=>a+b,0)/funding.size:null,
  openInterest:openInterest.size?[...openInterest.values()].reduce((a,b)=>a+b,0)/openInterest.size:null,
  liquidationFlow:{buyNotional:liquidationBuy,sellNotional:liquidationSell,netNotional:liquidationBuy-liquidationSell},
  ticker:bids.length&&asks.length?{bid:bids.reduce((a,b)=>a+b,0)/bids.length,ask:asks.reduce((a,b)=>a+b,0)/asks.length}:null,
  freshestAt:[...books,...freshEvents].map(x=>x.observed_at||x.received_at||x.updated_at).filter(Boolean).sort().at(-1)||null
 };
}
function buildMultiAssetEvidence(market,context,signal,tradingWindow){
 const f=signal?.features||{},freshAt=Date.parse(context?.freshestAt||''),fresh=Number(market?.ageMs)<=60000&&Number.isFinite(freshAt)&&Date.now()-freshAt<=60000&&Date.now()-freshAt>=-5000;
 const bookNotional=(context?.orderBooks||[]).reduce((sum,row)=>{const book=row.book||{};const levels=[...(book.bids||[]),...(book.asks||[])].slice(0,40);return sum+levels.reduce((total,level)=>{const price=Array.isArray(level)?Number(level[0]):Number(level.price),qty=Array.isArray(level)?Number(level[1]):Number(level.quantity??level.size);return total+(price>0&&qty>0?price*qty:0);},0);},0);
 const bias=Object.values(f.timeframeBias||{}).map(Number).filter(v=>v===1||v===-1),alignment=bias.length?bias.reduce((sum,v)=>sum+v,0)/bias.length:null;
 const closed=market?.candles?.filter(row=>Array.isArray(row)&&row.length>=6).slice(-2,-1)[0],displacementPct=closed&&Number(closed[1])>0?Math.abs(Number(closed[4])-Number(closed[1]))/Number(closed[1])*100:null;
 const reliable=context?.bookValid===true&&(context?.freshStreamEvents||[]).length>0&&fresh;
 return {timestamp:context?.freshestAt||null,eventTimeReliable:reliable,dataQuality:reliable?'verified':'unverified',
  session:f.session||null,sessionOpen:tradingWindow?.eligible===true,price:Number(market.ticker.last),
  spreadBps:f.spreadPct==null?null:Number(f.spreadPct)*100,volatilityPct:f.atrPct,liquidityUsd:bookNotional,
  momentumPct:f.momentumPct,timeframeAlignment:alignment,relativeVolume:f.relativeVolume,
  orderBookImbalance:context?.orderBookImbalance,depthImbalance:context?.orderBookImbalance,tradeFlowImbalance:context?.tradeFlowImbalance,
  fundingRate:context?.fundingRate,displacementPct};
}

export async function runCycle(db,symbol,options={},env={}){
 if(!options.agentsEnsured)await ensureAgents(db);
 const tradingWindow=evaluateTradingWindow(options.now??Date.now());
 const market=await marketSnapshot(symbol,db);
 const liveMarketContext=await loadLiveMarketContext(db,market.symbol,env);
 const report={mode:'PAPER_ONLY',tradingWindow,liveMarketContext,source:market.source,symbol:market.symbol,marketTimestamp:new Date(market.ticker.timestamp).toISOString(),receivedAt:market.receivedAt,ageMs:market.ageMs,opened:[],closed:[],partialExits:[],skipped:[],agents:[],multiAssetReviews:[]};
 const openRows=await db.prepare("SELECT symbol,direction,COUNT(*) AS count FROM jpti_paper_trades WHERE status='open' GROUP BY symbol,direction").all();
 const exposure={total:0,bySymbol:new Map(),byDirection:new Map()};
 let independentPolicy={maxRiskPercent:PAPER_POLICY.riskPerTradePct,maxNotionalUsd:2500,maxOpenPositions:PAPER_POLICY.maxFleetOpenPositions,maxDailyLossPercent:PAPER_POLICY.maxDailyLossPct,maxDrawdownPercent:PAPER_POLICY.maxDrawdownPct,maxCorrelationExposure:PAPER_POLICY.maxOpenPerSymbol,minimumRewardRisk:1.5,maxSpreadPercent:.15,maxDataAgeMs:60000,requireFreshData:true,circuitBreaker:false,killSwitch:false};
 try{const row=await db.prepare("SELECT policy_json FROM jpti_risk_policies WHERE policy_id='default'").first();if(row?.policy_json)independentPolicy={...independentPolicy,...JSON.parse(row.policy_json)};}catch{/* The existing paper gates remain active until migration 0010 is applied. */}
 report.riskVetoes=[];
 let fleetSafety={available:false,killSwitch:false,circuitBreaker:false,status:'UNKNOWN',reasons:[]};
 try{
  const stored=await db.prepare("SELECT status,kill_switch,circuit_breaker,manual_resume_required,reasons_json FROM jpti_fleet_circuit_breakers WHERE scope_id='global'").first();
  if(stored){fleetSafety={available:true,killSwitch:Number(stored.kill_switch)===1,circuitBreaker:Number(stored.circuit_breaker)===1||stored.status==='TRIPPED',manualResumeRequired:Number(stored.manual_resume_required)===1,status:stored.status,reasons:parseJson(stored.reasons_json,[])};}
 }catch{/* Migration 0018 is applied by the production deployment workflow; legacy local DBs retain existing guards. */}
 report.fleetSafety=fleetSafety;
 report.agentSafety=[];
 for(const row of openRows.results||[]){const count=num(row.count);exposure.total+=count;exposure.bySymbol.set(row.symbol,(exposure.bySymbol.get(row.symbol)||0)+count);exposure.byDirection.set(row.direction,(exposure.byDirection.get(row.direction)||0)+count);}
 const fleetAgents=await loadAgents(db);
 const intentTicker=liveMarketContext.ticker?.bid>0&&liveMarketContext.ticker?.ask>0?{...market.ticker,...liveMarketContext.ticker}:market.ticker;
 const intentCandidates=fleetAgents.filter(agent=>agent.status==='active'||agent.status==='live_ready').map(agent=>{
  const signal=derivePaperSignal(market.candles,intentTicker,agent.strategyId||agent.id,{timeframes:market.timeframes,marketData:liveMarketContext});
  return signal.action==='SIGNAL'?{agentId:agent.id,symbol:market.symbol,direction:signal.direction,confidence:Number(signal.confidence)||.65,score:Number(signal.score)||0}:null;
 }).filter(Boolean);
 const intentArbitration=arbitrateAgentIntents(intentCandidates);
 const approvedIntentAgentIds=new Set(intentArbitration.accepted.map(x=>x.agentId));
 const collisionSymbols=new Set(intentArbitration.collisions.map(x=>x.symbol));
 report.intentArbitration={...intentArbitration,accepted:intentArbitration.accepted.map(x=>({agentId:x.agentId,symbol:x.symbol,direction:x.direction,confidence:x.confidence})),rejected:intentArbitration.rejected.map(x=>({agentId:x.intent.agentId,symbol:x.intent.symbol,direction:x.intent.direction,reason:x.reason}))};
 for(const agent of fleetAgents){
  if(agent.status!=='active'&&agent.status!=='live_ready')continue;
  const rows=await allTrades(db,agent.id),trades=rows.map(toTrade);
  const open=trades.find(t=>t.status==='open'&&t.symbol===market.symbol);
  if(open){
   const initialRiskDistance=num(open.risk_usd)/Math.max(1e-12,num(open.quantity));
   const stopUpdate=updateDynamicStop({direction:open.direction,entryPrice:num(open.entry_price),currentPrice:market.ticker.last,stopPrice:num(open.stop_price),initialRiskDistance});
   if(stopUpdate.updated){
    const updatedPayload={...JSON.parse(open.payload||'{}'),dynamicStop:stopUpdate};
    await db.prepare('UPDATE jpti_paper_trades SET stop_price=?,payload=? WHERE trade_id=? AND status=\'open\'').bind(stopUpdate.stopPrice,JSON.stringify(updatedPayload),open.trade_id).run();
    open.stop_price=stopUpdate.stopPrice;
   }
   let openPayload={};try{openPayload=JSON.parse(open.payload||'{}')}catch{}
   const initialQuantity=num(openPayload.initialQuantity)||num(open.quantity),initialRisk=num(openPayload.originalRiskUsd)||num(open.risk_usd),initialEntryFee=num(openPayload.originalEntryFeeUsd)||num(open.entry_fee_usd),initialDistance=initialRisk/Math.max(1e-12,initialQuantity),moveR=initialDistance>0?(market.ticker.last-num(open.entry_price))*(open.direction==='LONG'?1:-1)/initialDistance:0;
   const plan=openPayload.partialExitPlan?.exits||[],nextIndex=Number(openPayload.nextPartialExitIndex)||0,partialFills=[],partialState={...openPayload,initialQuantity,originalRiskUsd:initialRisk,originalEntryFeeUsd:initialEntryFee,partialRealizedPnlUsd:num(openPayload.partialRealizedPnlUsd),partialGrossPnlUsd:num(openPayload.partialGrossPnlUsd),partialExitFeesUsd:num(openPayload.partialExitFeesUsd),partialExits:Array.isArray(openPayload.partialExits)?openPayload.partialExits:[],nextPartialExitIndex:nextIndex};
   let remainingQuantity=num(open.quantity),remainingRisk=num(open.risk_usd),remainingEntryFee=num(open.entry_fee_usd),nextPartial=nextIndex;
   while(nextPartial<plan.length&&moveR>=Number(plan[nextPartial].r)&&remainingQuantity>1e-12){
    const level=plan[nextPartial],closeQuantity=Math.min(remainingQuantity,initialQuantity*Number(level.portion)),allocation=closeQuantity/initialQuantity;
    const partial=settlePaperTrade({...open,entryPrice:num(open.entry_price),quantity:closeQuantity,entryFeeUsd:initialEntryFee*allocation,riskUsd:initialRisk*allocation},market.ticker.last,PAPER_POLICY.feeRate,PAPER_POLICY.slippageBps,PAPER_POLICY.spreadBps);
    const fillRecord={r:Number(level.r),portion:allocation,quantity:closeQuantity,...partial,filledAt:iso()};
    partialFills.push(fillRecord);partialState.partialExits.push(fillRecord);partialState.partialRealizedPnlUsd+=partial.netPnlUsd;partialState.partialGrossPnlUsd+=partial.grossPnlUsd;partialState.partialExitFeesUsd+=partial.exitFeeUsd;
    remainingQuantity=Math.max(0,remainingQuantity-closeQuantity);remainingRisk=initialRisk*(remainingQuantity/initialQuantity);remainingEntryFee=initialEntryFee*(remainingQuantity/initialQuantity);nextPartial++;
   }
   if(nextPartial!==nextIndex){
    partialState.nextPartialExitIndex=nextPartial;
    await db.prepare("UPDATE jpti_paper_trades SET quantity=?,risk_usd=?,entry_fee_usd=?,payload=? WHERE trade_id=? AND status='open'").bind(remainingQuantity,remainingRisk,remainingEntryFee,JSON.stringify(partialState),open.trade_id).run();
    open.quantity=remainingQuantity;open.risk_usd=remainingRisk;open.riskUsd=remainingRisk;open.entry_fee_usd=remainingEntryFee;open.entryFeeUsd=remainingEntryFee;open.payload=JSON.stringify(partialState);
    report.partialExits.push({agentId:agent.id,tradeId:open.trade_id,fills:partialFills,remainingQuantity,realizedPartialPnlUsd:partialState.partialRealizedPnlUsd});
   }
   const realizedToday=trades.filter(t=>t.status==='closed'&&String(t.closedAt||'').slice(0,10)===iso().slice(0,10)).reduce((s,t)=>s+num(t.netPnlUsd),0);
   const unrealizedToday=unrealizedPnlForSymbol(trades.filter(t=>t.status==='open'),market.symbol,market.ticker.last,PAPER_POLICY.feeRate);
   const dailyCircuit=realizedToday+unrealizedToday<=-(PAPER_POLICY.initialEquityUsd*PAPER_POLICY.maxDailyLossPct/100);
   const hitStop=open.direction==='LONG'?market.ticker.last<=open.stop_price:market.ticker.last>=open.stop_price;
   const hitTarget=open.direction==='LONG'?market.ticker.last>=open.target_price:market.ticker.last<=open.target_price;
   const timed=Date.now()-Date.parse(open.opened_at)>60*60*1000;
   if(hitStop||hitTarget||timed||dailyCircuit){
    const reason=dailyCircuit?'daily-loss-circuit-breaker':hitStop?'stop-loss':hitTarget?'take-profit':'time-exit';
    const settledRaw=settlePaperTrade({...open,direction:open.direction,entryPrice:num(open.entry_price),quantity:num(open.quantity),entryFeeUsd:num(open.entry_fee_usd),riskUsd:num(open.risk_usd)},market.ticker.last,PAPER_POLICY.feeRate,PAPER_POLICY.slippageBps,PAPER_POLICY.spreadBps);
    let partialTotals={};try{partialTotals=JSON.parse(open.payload||'{}')}catch{}
    const originalRisk=num(partialTotals.originalRiskUsd)||num(open.risk_usd);
    const settled={...settledRaw,grossPnlUsd:num(partialTotals.partialGrossPnlUsd)+settledRaw.grossPnlUsd,netPnlUsd:num(partialTotals.partialRealizedPnlUsd)+settledRaw.netPnlUsd,exitFeeUsd:num(partialTotals.partialExitFeesUsd)+settledRaw.exitFeeUsd,rMultiple:(num(partialTotals.partialRealizedPnlUsd)+settledRaw.netPnlUsd)/Math.max(1e-12,originalRisk),partialExits:partialTotals.partialExits||[]};
    const {payload:_storedPayload,...openRecord}=open;const payload={...openRecord,...settled,exitReason:reason,closedAt:iso(),source:'simulated-last-price',riskBreach:settled.rMultiple < -1.1};
    await db.prepare("UPDATE jpti_paper_trades SET status='closed',closed_at=?,exit_price=?,exit_fee_usd=?,gross_pnl_usd=?,net_pnl_usd=?,r_multiple=?,payload=? WHERE trade_id=? AND status='open'")
     .bind(payload.closedAt,settled.exitPrice,settled.exitFeeUsd,settled.grossPnlUsd,settled.netPnlUsd,settled.rMultiple,JSON.stringify(payload),open.trade_id).run();
    try{
     const outcome={exitReason:reason,exitPrice:settled.exitPrice,grossPnlUsd:settled.grossPnlUsd,netPnlUsd:settled.netPnlUsd,rMultiple:settled.rMultiple,partialExits:settled.partialExits||[],closedAt:payload.closedAt};
     await db.prepare("UPDATE jpti_trade_intelligence SET status='closed',closed_at=?,execution_json=?,outcome_json=?,updated_at=? WHERE trade_id=?").bind(payload.closedAt,JSON.stringify({exitFeeUsd:settled.exitFeeUsd,source:'simulated-last-price'}),JSON.stringify(outcome),payload.closedAt,open.trade_id).run();
     await db.prepare('INSERT INTO jpti_intelligence_memory(memory_id,scope,memory_type,title,content,source,evidence_status,confidence,importance,tags_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),'global','paper-trade-lesson','Paper trade closed: '+market.symbol,JSON.stringify({tradeId:open.trade_id,agentId:agent.id,symbol:market.symbol,direction:open.direction,outcome}),'JPTI paper trade '+open.trade_id,'inferred',.65,.75,JSON.stringify(['paper-trade','trade-outcome',market.symbol]),JSON.stringify({regime:open.regime}),payload.closedAt,payload.closedAt).run();
     await db.prepare('INSERT INTO jpti_agent_scorecards(agent_id,metric_date,decisions,correct_decisions,evidence_contributions,risk_violations,useful_handoffs,metrics_json,updated_at) VALUES(?,?,1,?,0,0,0,?,?) ON CONFLICT(agent_id,metric_date) DO UPDATE SET decisions=decisions+1,correct_decisions=correct_decisions+excluded.correct_decisions,updated_at=excluded.updated_at').bind(agent.id,payload.closedAt.slice(0,10),settled.netPnlUsd>0?1:0,JSON.stringify({brierScore:.5,evidenceQuality:.7,researchContribution:.5}),payload.closedAt).run();
    }catch(error){console.error('[JPTI trade intelligence] Outcome mirror unavailable:',error?.message||error);}
    report.closed.push({agentId:agent.id,tradeId:open.trade_id,...settled,reason});exposure.total=Math.max(0,exposure.total-1);exposure.bySymbol.set(open.symbol,Math.max(0,(exposure.bySymbol.get(open.symbol)||0)-1));exposure.byDirection.set(open.direction,Math.max(0,(exposure.byDirection.get(open.direction)||0)-1));
   }
  }
  const decisionTicker=liveMarketContext.ticker?.bid>0&&liveMarketContext.ticker?.ask>0?{...market.ticker,...liveMarketContext.ticker}:market.ticker;
  const signal=derivePaperSignal(market.candles,decisionTicker,agent.strategyId||agent.id,{timeframes:market.timeframes,marketData:liveMarketContext});
  const currentRows=await allTrades(db,agent.id),current=currentRows.map(toTrade);
  const openNow=current.filter(t=>t.status==='open').length;
  const metrics=calculatePaperMetrics(current,PAPER_POLICY.initialEquityUsd);
  const outOfSampleCount=current.filter(t=>t.status==='closed'&&t.outOfSample===true).length;
  const kpi=assessAgentKpis(metrics,PAPER_POLICY,outOfSampleCount);
  const lifecycle=await promoteOrRetire(db,agent,metrics,kpi);
  if(lifecycle)report.agents.push({agentId:agent.id,lifecycle});
  const savedTier=await db.prepare('SELECT tier FROM jpti_paper_agents WHERE agent_id=?').bind(agent.id).first();
  await saveAgent(db,agent.id,metrics,kpi,savedTier?.tier||agent.tier||'RESEARCH');
  const dailyLoss=current.filter(t=>t.status==='closed'&&String(t.closedAt||'').slice(0,10)===iso().slice(0,10)).reduce((s,t)=>s+Math.min(0,num(t.netPnlUsd)),0);
  const validationEvidence=await loadPromotionEvidence(db,agent.strategyId||agent.id);
  const decayDetected=validationEvidence.verdict?.decayDetected===true;
  const [storedSafety,heartbeat,behaviorRows,trustRow]=await Promise.all([
   db.prepare('SELECT status,quarantined_until FROM jpti_agent_safety_state WHERE agent_id=?').bind(agent.id).first().catch(()=>null),
   db.prepare('SELECT status,last_seen,latency_ms,error_count FROM jpti_agent_heartbeats WHERE agent_id=?').bind(agent.id).first().catch(()=>null),
   db.prepare("SELECT event_type,severity,summary,observed_at FROM jpti_agent_behavior_events WHERE agent_id=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 50").bind(agent.id,new Date(Date.now()-24*60*60*1000).toISOString()).all().catch(()=>({results:[]})),
   db.prepare('SELECT trust_score FROM jpti_agent_trust_snapshots WHERE agent_id=? ORDER BY calculated_at DESC LIMIT 1').bind(agent.id).first().catch(()=>null)
  ]);
  const quarantineExpiry=Date.parse(storedSafety?.quarantined_until||''),quarantined=storedSafety?.status==='QUARANTINED'&&(!storedSafety.quarantined_until||!Number.isFinite(quarantineExpiry)||quarantineExpiry>Date.now());
  const dailyLossPct=Math.abs(Math.min(0,dailyLoss))/Math.max(1,metrics.equityUsd)*100;
  const safetyDecision=evaluateAgentSafety({
   agentStatus:agent.status,heartbeatStatus:heartbeat?.status||'unknown',
   heartbeatAgeMs:heartbeat?.last_seen?Math.max(0,Date.now()-Date.parse(heartbeat.last_seen)):null,
   latencyMs:heartbeat?.latency_ms??null,errorRate:heartbeat?.error_count?Math.min(1,Number(heartbeat.error_count)/10):0,
   trustScore:trustRow?.trust_score===undefined?Math.min(100,65+Math.min(35,current.filter(t=>t.status==='closed').length)):Number(trustRow.trust_score),
   safetyStorageReady:fleetSafety.available,
   anomalies:(behaviorRows.results||[]).map(x=>({type:x.event_type,severity:x.severity,summary:x.summary,at:x.observed_at})),
   dataAgeMs:market.ageMs,dataFresh:Number(market.ageMs)<=Number(independentPolicy.maxDataAgeMs||60000),
   dailyLossPct,drawdownPct:metrics.maxDrawdownPct,consecutiveLosses:metrics.currentConsecutiveLosses,
   killSwitch:fleetSafety.killSwitch||independentPolicy.killSwitch===true,
   circuitBreaker:fleetSafety.circuitBreaker||independentPolicy.circuitBreaker===true,
   quarantined,sessionAllowed:tradingWindow.eligible,
   strategySuspended:agent.tier==='SUSPENDED'||validationEvidence.verdict?.status==='SUSPENDED',
   duplicateIntent:signal.action==='SIGNAL'&&!approvedIntentAgentIds.has(agent.id),
   oppositeIntentCollision:collisionSymbols.has(market.symbol),
   // New risk requires at least one fresh, sequence-valid streamed order book; REST candles alone are insufficient.
   bookValid:liveMarketContext.bookValid===true,
   // Trade outcomes below -1.1R are strategy-performance evidence, not proof of a policy bypass.
   // Actual policy violations are supplied through high/critical governance behaviour events.
  });
  report.agentSafety.push({agentId:agent.id,...safetyDecision});
  try{
   const evaluatedAt=iso(),quarantinedUntil=safetyDecision.quarantine?(quarantined?storedSafety.quarantined_until:new Date(Date.now()+24*60*60*1000).toISOString()):null;
   await db.prepare("INSERT INTO jpti_agent_safety_state(agent_id,status,health_score,trust_score,reasons_json,quarantined_until,last_evaluated_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET status=excluded.status,health_score=excluded.health_score,trust_score=excluded.trust_score,reasons_json=excluded.reasons_json,quarantined_until=excluded.quarantined_until,last_evaluated_at=excluded.last_evaluated_at,updated_at=excluded.updated_at")
    .bind(agent.id,safetyDecision.status,safetyDecision.health.score,safetyDecision.trustScore,JSON.stringify(safetyDecision.reasons),quarantinedUntil,evaluatedAt,evaluatedAt).run();
   if(safetyDecision.quarantine){
    const incidentId=agent.id+':safety-quarantine:'+evaluatedAt.slice(0,10);
    await db.prepare("INSERT OR IGNORE INTO jpti_agent_safety_incidents(incident_id,agent_id,incident_type,severity,summary,evidence_json,status,detected_at) VALUES(?,?,'agent-quarantine','high',?,?,'open',?)")
     .bind(incidentId,agent.id,'Agent isolated by the safety supervisor.',JSON.stringify({reasons:safetyDecision.reasons,health:safetyDecision.health}),evaluatedAt).run();
   }
  }catch{/* The supervisor remains active in-process when a local DB has not applied migration 0018. */}
  const capitalHaltReasons=[];let capitalRiskMultiplier=1;
  // Risk-breach counts and maximum historical loss streaks are promotion analytics, not current-session kill conditions.
  if(metrics.currentConsecutiveLosses>=5)capitalHaltReasons.push('five-consecutive-loss current streak halt');
  else if(metrics.currentConsecutiveLosses>=3)capitalRiskMultiplier*=0.5;
  if(metrics.maxDrawdownPct>=PAPER_POLICY.maxDrawdownPct)capitalHaltReasons.push('maximum drawdown reached');
  else if(metrics.maxDrawdownPct>=PAPER_POLICY.maxDrawdownPct*0.5)capitalRiskMultiplier*=0.5;
  if(decayDetected)capitalHaltReasons.push('forward performance decay detected');
  const sessionName=tradingWindow.activeSessions.join(' + ')||'OUTSIDE_SESSION';
  let action='NO_ENTRY',reason=signal.reason;
  if(signal.action==='SIGNAL'&&safetyDecision.allowed&&tradingWindow.eligible&&!current.some(t=>t.symbol===market.symbol&&t.status==='closed'&&Date.now()-Date.parse(t.closedAt||0)<15*60*1000)&&sessionName!=='ROLLOVER'&&signal.features&&Number.isFinite(signal.features.spreadPct)&&signal.features.spreadPct<=0.15&&signal.features.atrPct>0&&signal.features.timeframeAgreement>=2&&openNow<PAPER_POLICY.maxOpenPositions&&exposure.total<PAPER_POLICY.maxFleetOpenPositions&&(exposure.bySymbol.get(market.symbol)||0)<PAPER_POLICY.maxOpenPerSymbol&&(exposure.byDirection.get(signal.direction)||0)<PAPER_POLICY.maxSameDirectionOpenPositions&&capitalHaltReasons.length===0&&metrics.maxDrawdownPct<PAPER_POLICY.maxDrawdownPct&&dailyLoss>-(metrics.equityUsd*PAPER_POLICY.maxDailyLossPct/100)){
   const price=market.ticker.last,stopDistance=Math.max(price*0.0035,price*signal.features.atrPct/100*1.2);
   const sizing=adaptivePositionSize({equity:metrics.equityUsd,entryPrice:price,stopPrice:signal.direction==='LONG'?price-stopDistance:price+stopDistance,baseRiskPercent:PAPER_POLICY.riskPerTradePct*capitalRiskMultiplier,regime:signal.features.regime,confidence:Number(signal.confidence)||.65,correlationFactor:(exposure.bySymbol.get(market.symbol)||0)>0?.5:1},independentPolicy);
   const targetRiskUsd=sizing.riskAmount;
   const allInRiskPerUnit=calculateAllInRiskPerUnit({entryPrice:price,stopDistance});
   const quantity=Math.min(sizing.quantity||0,targetRiskUsd/allInRiskPerUnit,Math.max(0,metrics.equityUsd)/(price*(1+PAPER_POLICY.feeRate)));
   const riskUsd=quantity*allInRiskPerUnit;
   if(quantity>0&&Number.isFinite(quantity)){
    const riskContext={riskUsd,riskBudgetUsd:Math.max(0,metrics.equityUsd*Number(independentPolicy.maxRiskPercent||.75)/100),riskPercent:riskUsd/Math.max(1,metrics.equityUsd)*100,notionalUsd:quantity*price,openPositions:exposure.total,dailyLossPercent:Math.abs(Math.min(0,dailyLoss))/Math.max(1,metrics.equityUsd)*100,drawdownPercent:metrics.maxDrawdownPct,rewardRisk:3,spreadPercent:signal.features.spreadPct,dataAgeMs:market.ageMs,dataFresh:Number(market.ageMs)<=Number(independentPolicy.maxDataAgeMs||60000),correlatedOpenPositions:exposure.bySymbol.get(market.symbol)||0,confidence:Number(signal.confidence)||.65};
    const riskDecision=evaluateRiskGate(riskContext,independentPolicy);
    const multiAssetEvidence=buildMultiAssetEvidence(market,liveMarketContext,signal,tradingWindow);
    const multiAssetDecision=evaluateMultiAssetOpportunity({assetClass:'crypto',symbol:market.symbol,marketType:'usdt-m',venue:'bitget',candles:market.candles,evidence:multiAssetEvidence,riskContext,riskPolicy:independentPolicy},{
     maxAgeMs:independentPolicy.maxDataAgeMs||60000,maxSpreadBps:(Number(independentPolicy.maxSpreadPercent)||.15)*100,maxVolatilityPct:4,minLiquidityUsd:10000,minConfidence:.55
    });
    if(multiAssetDecision.direction!==String(signal.direction).toLowerCase()){
     multiAssetDecision.veto.push('paper-signal-direction-disagreement');multiAssetDecision.eligible=false;multiAssetDecision.action='ABSTAIN';
    }
    report.multiAssetReviews.push({agentId:agent.id,decisionId:multiAssetDecision.decisionId,eligible:multiAssetDecision.eligible,direction:multiAssetDecision.direction,score:multiAssetDecision.score,confidence:multiAssetDecision.confidence,veto:multiAssetDecision.veto,specialistConsensus:multiAssetDecision.specialistConsensus,specialists:multiAssetDecision.specialists,shortTermIntelligence:multiAssetDecision.shortTermIntelligence});
    try{await db.prepare('INSERT INTO jpti_multi_asset_decisions(decision_id,asset_class,symbol,venue,agent_squad,direction,score,confidence,eligible,action,veto_json,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(multiAssetDecision.decisionId,'crypto',market.symbol,'bitget',agent.id,multiAssetDecision.direction,multiAssetDecision.score,multiAssetDecision.confidence,multiAssetDecision.eligible?1:0,multiAssetDecision.action,JSON.stringify(multiAssetDecision.veto),JSON.stringify(multiAssetEvidence),iso()).run();}catch(error){console.error('[JPTI multi-asset] Decision persistence unavailable:',error?.message||error);}
    if(!riskDecision.allowed||!multiAssetDecision.eligible){
     reason=!riskDecision.allowed?'Independent risk veto: '+riskDecision.violations.map(x=>x.code).join(', '):'Multi-asset specialist veto: '+multiAssetDecision.veto.join(', ');
     report.riskVetoes.push({agentId:agent.id,decision:riskDecision,multiAssetDecision});
     try{await db.prepare('INSERT INTO jpti_risk_events(event_id,event_type,severity,decision,reason,context_json,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'paper-entry-veto','warning','REJECT',reason,JSON.stringify({agentId:agent.id,symbol:market.symbol,riskDecision}),iso()).run();}catch{/* Risk event persistence is available after migration 0010. */}
    }else{
    const fill=simulatePaperFill({direction:signal.direction,price,quantity});
    const stop=fill.entryPrice+(signal.direction==='LONG'?-stopDistance:stopDistance),target=fill.entryPrice+(signal.direction==='LONG'?stopDistance*3:-stopDistance*3);
    const tradeId=crypto.randomUUID(),openedAt=iso();
    const trade={tradeId,agentId:agent.id,symbol:market.symbol,direction:signal.direction,status:'open',openedAt,entryPrice:fill.entryPrice,quantity,stopPrice:stop,targetPrice:target,riskUsd,entryFeeUsd:fill.entryFeeUsd,initialQuantity:quantity,originalRiskUsd:riskUsd,originalEntryFeeUsd:fill.entryFeeUsd,partialRealizedPnlUsd:0,partialGrossPnlUsd:0,partialExitFeesUsd:0,partialExits:[],nextPartialExitIndex:0,regime:signal.features.regime,session:sessionName,partialExitPlan:buildPartialExitPlan({entryPrice:fill.entryPrice,stopPrice:stop,direction:signal.direction}),sourceCandleAt:signal.features.closedCandleAt,signal,fill,mode:'PAPER_ONLY',validationPhase:current.filter(t=>t.status==='closed').length>=150?'FORWARD_VALIDATION':'DEVELOPMENT',outOfSample:current.filter(t=>t.status==='closed').length>=150};
    try{
     await db.prepare("INSERT INTO jpti_paper_trades(trade_id,agent_id,symbol,direction,status,opened_at,entry_price,quantity,stop_price,target_price,risk_usd,entry_fee_usd,regime,source_candle_at,payload) VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)")
      .bind(tradeId,agent.id,market.symbol,signal.direction,openedAt,fill.entryPrice,quantity,stop,target,riskUsd,fill.entryFeeUsd,signal.features.regime,signal.features.closedCandleAt,JSON.stringify(trade)).run();
     try{
      const fingerprint=[market.symbol,signal.direction,signal.features.regime,sessionName,'1m',agent.strategyId||agent.id].join('|');
      await db.prepare('INSERT INTO jpti_trade_intelligence(trade_id,agent_id,strategy_id,symbol,market_type,direction,status,setup_fingerprint,entry_price,stop_price,target_price,risk_amount,reward_risk,regime,session_name,confidence,evidence_json,agent_assessments_json,execution_json,outcome_json,lessons_json,opened_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
       .bind(tradeId,agent.id,agent.strategyId||null,market.symbol,'paper',signal.direction,'open',fingerprint,fill.entryPrice,stop,target,riskUsd,3,signal.features.regime,sessionName,Number(signal.confidence)||.65,JSON.stringify({signal,closedCandleAt:signal.features.closedCandleAt}),JSON.stringify([{agentId:agent.id,assessment:'PAPER_ENTRY_APPROVED'}]),JSON.stringify({fill,mode:'PAPER_ONLY'}),'{}','[]',openedAt,openedAt,openedAt).run();
     }catch(error){console.error('[JPTI trade intelligence] Entry mirror unavailable:',error?.message||error);}
     report.opened.push(trade);exposure.total+=1;exposure.bySymbol.set(market.symbol,(exposure.bySymbol.get(market.symbol)||0)+1);exposure.byDirection.set(signal.direction,(exposure.byDirection.get(signal.direction)||0)+1);action='PAPER_ORDER_OPENED';reason='Simulated entry accepted after market freshness, per-agent and fleet exposure gates.';
    }catch(e){if(!String(e.message||e).includes('UNIQUE'))throw e;reason='Duplicate closed-candle signal ignored (idempotency gate).';}
   }
    }
  }else if(signal.action==='SIGNAL')reason=!safetyDecision.allowed?'Agent safety supervisor veto: '+safetyDecision.reasons.map(x=>x.code).join(', '):capitalHaltReasons.length?'Capital protection halt: '+capitalHaltReasons.join('; '):'Entry blocked by spread, risk, drawdown, daily-loss, per-agent, fleet, symbol-concentration, direction-concentration or independent risk gate.';
  report.agents.push({agentId:agent.id,action,reason,signal,openPositions:openNow,metrics});
 }
 return report;
}
async function dashboard(db){
 await ensureAgents(db);
 const agents=[];
 for(const agent of await loadAgents(db)){
  const rows=await allTrades(db,agent.id),trades=rows.map(toTrade),metrics=calculatePaperMetrics(trades,PAPER_POLICY.initialEquityUsd);
  const outOfSample=trades.filter(t=>t.status==='closed'&&t.outOfSample===true).length;
  const kpi=assessAgentKpis(metrics,PAPER_POLICY,outOfSample);
  const row=await db.prepare('SELECT tier,status,promoted_at,virtual_equity_usd,payload FROM jpti_paper_agents WHERE agent_id=?').bind(agent.id).first();
  let stored={};try{stored=JSON.parse(row?.payload||'{}')}catch{}
  agents.push({...agent,...stored,id:agent.id,tier:row?.tier||'RESEARCH',status:row?.status||'active',virtualEquityUsd:row?.virtual_equity_usd==null?PAPER_POLICY.initialEquityUsd:num(row.virtual_equity_usd),promotedAt:row?.promoted_at||null,metrics,kpi,openTrades:trades.filter(t=>t.status==='open').slice(0,5),recentTrades:trades.slice(0,8)});
 }
 const openTrades=agents.flatMap(a=>a.openTrades.map(t=>({...t,agentName:a.name})));
 let safety={available:false,global:{status:'UNKNOWN',killSwitch:false,circuitBreaker:false},agents:[]};
 try{
  const global=await db.prepare("SELECT * FROM jpti_fleet_circuit_breakers WHERE scope_id='global'").first();
  const states=await db.prepare('SELECT agent_id,status,health_score,trust_score,reasons_json,quarantined_until,last_evaluated_at FROM jpti_agent_safety_state ORDER BY updated_at DESC LIMIT 100').all();
  safety={available:true,global:global?{status:global.status,killSwitch:Number(global.kill_switch)===1,circuitBreaker:Number(global.circuit_breaker)===1,manualResumeRequired:Number(global.manual_resume_required)===1,reasons:parseJson(global.reasons_json,[])}:{status:'CLOSED',killSwitch:false,circuitBreaker:false},agents:(states.results||[]).map(x=>({...x,reasons:parseJson(x.reasons_json,[])}))};
 }catch{/* A migration-required state is surfaced instead of inventing healthy telemetry. */}
 return {mode:'PAPER_ONLY',liveExecutionAuthorized:false,exchangeOrdersCreated:0,policy:PAPER_POLICY,agents,openTrades,safety,updatedAt:iso()};
}
export async function dailyReview(db){
 const dash=await dashboard(db),date=iso().slice(0,10);
 const summary={date,mode:'PAPER_ONLY',safety:dash.safety,fleet:{total:dash.agents.length,research:dash.agents.filter(a=>a.tier==='RESEARCH').length,liveReady:dash.agents.filter(a=>a.tier==='LIVE_READY').length,suspended:dash.agents.filter(a=>a.status==='suspended').length,retired:dash.agents.filter(a=>a.status==='retired').length,capitalPerNewAgentUsd:PAPER_POLICY.initialEquityUsd},agents:dash.agents.map(a=>({agentId:a.id,name:a.name,tier:a.tier,metrics:a.metrics,kpi:a.kpi,openPositions:a.openTrades.length,safety:dash.safety.agents.find(x=>x.agent_id===a.id)||null})),capitalProtection:{maxDrawdownLimitPct:PAPER_POLICY.maxDrawdownPct,dailyLossLimitPct:PAPER_POLICY.maxDailyLossPct,maxFleetOpenPositions:PAPER_POLICY.maxFleetOpenPositions,maxOpenPerSymbol:PAPER_POLICY.maxOpenPerSymbol,maxSameDirectionOpenPositions:PAPER_POLICY.maxSameDirectionOpenPositions,liveOrdersAllowed:false},dataQuality:'Review uses persisted simulated fills and fee/slippage estimates; it does not certify future profitability.'};
 for(const agent of dash.agents){
  const lifecycle=await promoteOrRetire(db,agent,agent.metrics,agent.kpi);
  if(lifecycle){const item=summary.agents.find(a=>a.agentId===agent.id);if(item){item.tier=lifecycle.status;item.lifecycle=lifecycle;}}
 }
 summary.fleet={...summary.fleet,liveReady:summary.agents.filter(a=>a.tier==='LIVE_READY').length,research:summary.agents.filter(a=>a.tier==='RESEARCH').length,suspended:summary.agents.filter(a=>a.tier==='SUSPENDED').length,retired:summary.agents.filter(a=>a.tier==='RETIRED').length};
 const id='paper-review:'+date;
 await db.prepare("INSERT INTO jpti_paper_reviews(review_id,review_date,payload) VALUES(?,?,?) ON CONFLICT(review_date) DO UPDATE SET payload=excluded.payload,created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  .bind(id,date,JSON.stringify(summary)).run();
 return summary;
}
export async function onRequest({request,env,params}){
 if(!env.JPTI_DB)return response(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'});
 const auth=await authorized(request,env);if(!auth.ok)return response(auth.status,{error:auth.error});
 const path=String(params?.path||'').replace(/^\/+|\/+$/g,'');
 try{
  if(request.method==='GET'&&path==='overview')return response(200,await dashboard(env.JPTI_DB));
  if(request.method==='GET'&&path==='safety'){
   const global=await env.JPTI_DB.prepare("SELECT * FROM jpti_fleet_circuit_breakers WHERE scope_id='global'").first();
   const states=await env.JPTI_DB.prepare('SELECT agent_id,status,health_score,trust_score,reasons_json,quarantined_until,last_evaluated_at FROM jpti_agent_safety_state ORDER BY updated_at DESC LIMIT 200').all();
   return response(200,{available:true,global:global?{status:global.status,killSwitch:Number(global.kill_switch)===1,circuitBreaker:Number(global.circuit_breaker)===1,manualResumeRequired:Number(global.manual_resume_required)===1,reasons:parseJson(global.reasons_json,[])}:null,agents:(states.results||[]).map(x=>({...x,reasons:parseJson(x.reasons_json,[])})),liveExecutionAuthorized:false});
  }
  if(request.method==='POST'&&path==='safety/kill-switch'){
   const body=await request.json().catch(()=>({})),enabled=body.enabled===true,reason=String(body.reason||'').trim();
   if(!reason||reason.length<8)return response(400,{error:'A reason of at least 8 characters is required.'});
   await env.JPTI_DB.prepare("INSERT OR IGNORE INTO jpti_fleet_circuit_breakers(scope_id,status,kill_switch,circuit_breaker,manual_resume_required,reasons_json,updated_by,updated_at) VALUES('global','CLOSED',0,0,0,'[]','system',?)").bind(iso()).run();
   const current=await env.JPTI_DB.prepare("SELECT circuit_breaker FROM jpti_fleet_circuit_breakers WHERE scope_id='global'").first();
   if(!enabled&&body.acknowledge!==true)return response(409,{error:'Explicit acknowledge:true is required to clear the operator kill switch.'});
   const circuitBreaker=enabled?1:Number(current?.circuit_breaker||0),status=enabled||circuitBreaker?'TRIPPED':'CLOSED',now=iso();
   await env.JPTI_DB.prepare("UPDATE jpti_fleet_circuit_breakers SET status=?,kill_switch=?,circuit_breaker=?,manual_resume_required=?,reasons_json=?,tripped_at=CASE WHEN ?=1 THEN COALESCE(tripped_at,?) ELSE NULL END,resume_at=NULL,updated_by='authenticated-operator',updated_at=? WHERE scope_id='global'")
    .bind(status,enabled?1:0,circuitBreaker,enabled||circuitBreaker?1:0,JSON.stringify(enabled?[{code:'OPERATOR_KILL_SWITCH',reason}]:circuitBreaker?[{code:'CIRCUIT_BREAKER_STILL_ACTIVE',reason:'Operator kill switch cleared; circuit breaker remains tripped.'}]:[]),enabled?1:0,now,now).run();
   return response(200,{updated:true,enabled,status,killSwitch:enabled,circuitBreaker:!!circuitBreaker,manualResumeRequired:!!(enabled||circuitBreaker),reason,liveExecutionAuthorized:false});
  }
  if(request.method==='POST'&&path==='safety/resume'){
   const body=await request.json().catch(()=>({})),reason=String(body.reason||'').trim();
   await env.JPTI_DB.prepare("INSERT OR IGNORE INTO jpti_fleet_circuit_breakers(scope_id,status,kill_switch,circuit_breaker,manual_resume_required,reasons_json,updated_by,updated_at) VALUES('global','CLOSED',0,0,0,'[]','system',?)").bind(iso()).run();
   if(body.acknowledge!==true||reason.length<8)return response(409,{error:'Explicit acknowledge:true and a reason of at least 8 characters are required to resume.'});
   const now=iso();
   await env.JPTI_DB.prepare("UPDATE jpti_fleet_circuit_breakers SET status='CLOSED',kill_switch=0,circuit_breaker=0,manual_resume_required=0,reasons_json='[]',tripped_at=NULL,resume_at=NULL,updated_by='authenticated-operator',updated_at=? WHERE scope_id='global'").bind(now).run();
   return response(200,{updated:true,status:'CLOSED',killSwitch:false,circuitBreaker:false,reason,liveExecutionAuthorized:false,note:'Paper entries may resume only after the normal market, strategy and capital-protection gates pass.'});
  }
  if(request.method==='GET'&&path==='reviews'){
   const rows=await env.JPTI_DB.prepare('SELECT payload FROM jpti_paper_reviews ORDER BY review_date DESC LIMIT 30').all();
   return response(200,{reviews:(rows.results||[]).map(r=>JSON.parse(r.payload))});
  }
  if(request.method==='POST'&&path==='cycle'){
   const body=await request.json().catch(()=>({}));return response(200,await runCycle(env.JPTI_DB,body.symbol||'BTCUSDT',{},env));
  }
  if(request.method==='POST'&&path==='daily-review')return response(200,{review:await dailyReview(env.JPTI_DB)});
  return response(404,{error:'Unknown paper trading endpoint.'});
 }catch(error){return response(502,{error:String(error?.message||error).slice(0,300),mode:'PAPER_ONLY',newEntriesPaused:true});}
}
