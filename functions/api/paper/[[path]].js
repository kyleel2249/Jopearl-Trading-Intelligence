import { PAPER_AGENTS, AGENT_RESOURCES, PAPER_POLICY, derivePaperSignal, calculatePaperMetrics, assessAgentKpis, simulatePaperFill, settlePaperTrade } from '../../../src/paper-trading-engine.js';

const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','x-jpti-runtime':'cloudflare-pages-paper'};
const response=(status,body)=>new Response(JSON.stringify(body),{status,headers});
const iso=()=>new Date().toISOString();
const num=v=>Number.isFinite(Number(v))?Number(v):0;
async function authorized(request,env){
 const expected=String(env.JPTI_JOURNAL_TOKEN||env.JPTI_API_TOKEN||'');
 const provided=String(request.headers.get('x-jpti-api-token')||request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'');
 if(!expected)return{ok:false,status:503,error:'JPTI private API token is not configured.'};
 const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',new TextEncoder().encode(expected)),crypto.subtle.digest('SHA-256',new TextEncoder().encode(provided))]);
 const x=new Uint8Array(a),y=new Uint8Array(b);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];
 return d===0?{ok:true}:{ok:false,status:401,error:'Private API authorization failed.'};
}
async function bitget(path){
 const res=await fetch('https://api.bitget.com'+path,{headers:{accept:'application/json'},cf:{cacheTtl:0}});
 if(!res.ok)throw new Error('Bitget public market endpoint returned HTTP '+res.status);
 const data=await res.json();if(String(data.code)!=='00000')throw new Error(data.msg||'Bitget market feed returned an error.');
 return data.data;
}
async function marketSnapshot(symbol){
 const normalized=String(symbol||'BTCUSDT').toUpperCase().replace('/','').replace(':USDT','');
 if(!/^[A-Z0-9]{5,24}$/.test(normalized))throw new Error('Invalid Bitget USDT perpetual symbol.');
 const [rawCandles,rawTicker]=await Promise.all([
  bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=1m&limit=100'),
  bitget('/api/v2/mix/market/ticker?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES')
 ]);
 const candles=(Array.isArray(rawCandles)?rawCandles:[]).map(r=>r.map(Number)).sort((a,b)=>a[0]-b[0]);
 const t=Array.isArray(rawTicker)?rawTicker[0]:rawTicker;
 const ticker={last:num(t?.lastPr),bid:num(t?.bidPr),ask:num(t?.askPr),timestamp:num(t?.ts)};
 if(!(ticker.last>0)||candles.length<36)throw new Error('Bitget returned insufficient valid ticker/candle data.');
 const age=Date.now()-ticker.timestamp;
 if(!ticker.timestamp||age>30000||age< -5000)throw new Error('Bitget ticker is stale or has an invalid timestamp; paper entries are paused.');
 return {symbol:normalized,candles,ticker,source:'Bitget public USDT-FUTURES',receivedAt:iso(),ageMs:age};
}
async function ensureAgents(db){
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
 const successor={...agent,id,name:agent.name+' '+generation,role:agent.role+' · Candidate '+generation,generation,tier:'RESEARCH',status:'active',promotedAt:null,resources:[...AGENT_RESOURCES],permissions:{paper:true,live:false},parentAgentId:agent.id,createdAt:iso(),lifecycleNote:'Automatic successor; starts with $1 virtual capital.'};
 await db.prepare("INSERT OR IGNORE INTO jpti_paper_agents(agent_id,tier,virtual_equity_usd,status,payload) VALUES (?,'RESEARCH',?,'active',?)").bind(id,PAPER_POLICY.initialEquityUsd,JSON.stringify(successor)).run();
 return successor;
}
async function promoteOrRetire(db,agent,metrics,kpi){
 const row=await db.prepare('SELECT tier,status FROM jpti_paper_agents WHERE agent_id=?').bind(agent.id).first();
 if(!row)return null;
 if(kpi.eligibleForPromotion&&row.tier==='RESEARCH'){
  const at=iso(),payload={...agent,tier:'LIVE_READY',status:'live_ready',promotedAt:at,liveReadiness:{approved:true,liveExecutionAuthorized:false,requiresHumanApproval:true},resources:[...AGENT_RESOURCES,'Live deployment and exchange-minimum preflight']};
  await db.prepare("UPDATE jpti_paper_agents SET tier='LIVE_READY',status='live_ready',promoted_at=?,updated_at=?,payload=? WHERE agent_id=?").bind(at,at,JSON.stringify(payload),agent.id).run();
  const successor=await spawnSuccessor(db,agent);
  return {status:'LIVE_READY',promotedAt:at,successorId:successor.id};
 }
 if(metrics.maxDrawdownPct>=PAPER_POLICY.maxDrawdownPct&&row.status==='active'){
  const at=iso(),payload={...agent,status:'suspended',suspensionReason:'Maximum drawdown limit reached.',suspendedAt:at,permissions:{paper:false,live:false}};
  await db.prepare("UPDATE jpti_paper_agents SET status='suspended',updated_at=?,payload=? WHERE agent_id=?").bind(at,JSON.stringify(payload),agent.id).run();
  return {status:'SUSPENDED',reason:payload.suspensionReason};
 }
 if(metrics.closedTrades>=100&&metrics.netPnlUsd<0&&metrics.profitFactor<0.8&&metrics.expectancyR<0&&row.status==='active'){
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
export async function runCycle(db,symbol){
 await ensureAgents(db);
 const market=await marketSnapshot(symbol);
 const report={mode:'PAPER_ONLY',source:market.source,symbol:market.symbol,marketTimestamp:new Date(market.ticker.timestamp).toISOString(),receivedAt:market.receivedAt,ageMs:market.ageMs,opened:[],closed:[],skipped:[],agents:[]};
 for(const agent of await loadAgents(db)){
  if(agent.status!=='active'&&agent.status!=='live_ready')continue;
  const rows=await allTrades(db,agent.id),trades=rows.map(toTrade);
  const open=trades.find(t=>t.status==='open'&&t.symbol===market.symbol);
  if(open){
   const realizedToday=trades.filter(t=>t.status==='closed'&&String(t.closedAt||'').slice(0,10)===iso().slice(0,10)).reduce((s,t)=>s+num(t.netPnlUsd),0);
   const unrealizedToday=trades.filter(t=>t.status==='open').reduce((s,t)=>{const move=(market.ticker.last-num(t.entryPrice))*num(t.quantity)*(t.direction==='LONG'?1:-1);return s+move-num(t.entryFeeUsd)-market.ticker.last*num(t.quantity)*PAPER_POLICY.feeRate;},0);
   const dailyCircuit=realizedToday+unrealizedToday<=-(PAPER_POLICY.initialEquityUsd*PAPER_POLICY.maxDailyLossPct/100);
   const hitStop=open.direction==='LONG'?market.ticker.last<=open.stop_price:market.ticker.last>=open.stop_price;
   const hitTarget=open.direction==='LONG'?market.ticker.last>=open.target_price:market.ticker.last<=open.target_price;
   const timed=Date.now()-Date.parse(open.opened_at)>60*60*1000;
   if(hitStop||hitTarget||timed||dailyCircuit){
    const reason=dailyCircuit?'daily-loss-circuit-breaker':hitStop?'stop-loss':hitTarget?'take-profit':'time-exit';
    const settled=settlePaperTrade({...open,direction:open.direction,entryPrice:num(open.entry_price),quantity:num(open.quantity),entryFeeUsd:num(open.entry_fee_usd),riskUsd:num(open.risk_usd)},market.ticker.last);
    const payload={...open,...settled,exitReason:reason,closedAt:iso(),source:'simulated-last-price'};
    await db.prepare("UPDATE jpti_paper_trades SET status='closed',closed_at=?,exit_price=?,exit_fee_usd=?,gross_pnl_usd=?,net_pnl_usd=?,r_multiple=?,payload=? WHERE trade_id=? AND status='open'")
     .bind(payload.closedAt,settled.exitPrice,settled.exitFeeUsd,settled.grossPnlUsd,settled.netPnlUsd,settled.rMultiple,JSON.stringify(payload),open.trade_id).run();
    report.closed.push({agentId:agent.id,tradeId:open.trade_id,...settled,reason});
   }
  }
  const signal=derivePaperSignal(market.candles,market.ticker,agent.strategyId||agent.id);
  const currentRows=await allTrades(db,agent.id),current=currentRows.map(toTrade);
  const openNow=current.filter(t=>t.status==='open').length;
  const metrics=calculatePaperMetrics(current,agent.virtualEquityUsd||PAPER_POLICY.initialEquityUsd);
  const outOfSampleCount=current.filter(t=>t.status==='closed'&&t.outOfSample===true).length;
  const kpi=assessAgentKpis(metrics,PAPER_POLICY,outOfSampleCount);
  const lifecycle=await promoteOrRetire(db,agent,metrics,kpi);
  if(lifecycle)report.agents.push({agentId:agent.id,lifecycle});
  const savedTier=await db.prepare('SELECT tier FROM jpti_paper_agents WHERE agent_id=?').bind(agent.id).first();\n  await saveAgent(db,agent.id,metrics,kpi,savedTier?.tier||agent.tier||'RESEARCH');
  const dailyLoss=current.filter(t=>t.status==='closed'&&String(t.closedAt||'').slice(0,10)===iso().slice(0,10)).reduce((s,t)=>s+Math.min(0,num(t.netPnlUsd)),0);
  let action='NO_ENTRY',reason=signal.reason;
  if(signal.action==='SIGNAL'&&signal.features&&Number.isFinite(signal.features.spreadPct)&&signal.features.spreadPct<=0.15&&signal.features.atrPct>0&&openNow<PAPER_POLICY.maxOpenPositions&&metrics.maxDrawdownPct<PAPER_POLICY.maxDrawdownPct&&dailyLoss>-(metrics.equityUsd*PAPER_POLICY.maxDailyLossPct/100)){
   const price=market.ticker.last,stopDistance=Math.max(price*0.0035,price*signal.features.atrPct/100*1.2),riskUsd=metrics.equityUsd*PAPER_POLICY.riskPerTradePct/100;
   const allInRiskPerUnit=stopDistance+price*(PAPER_POLICY.feeRate*2+(PAPER_POLICY.slippageBps*2+PAPER_POLICY.spreadBps/2)/10000);
   const quantity=Math.min(riskUsd/allInRiskPerUnit,Math.max(0,metrics.equityUsd)/(price*(1+PAPER_POLICY.feeRate)));
   if(quantity>0&&Number.isFinite(quantity)){
    const fill=simulatePaperFill({direction:signal.direction,price,quantity});
    const stop=fill.entryPrice+(signal.direction==='LONG'?-stopDistance:stopDistance),target=fill.entryPrice+(signal.direction==='LONG'?stopDistance*1.5:-stopDistance*1.5);
    const tradeId=crypto.randomUUID(),openedAt=iso();
    const trade={tradeId,agentId:agent.id,symbol:market.symbol,direction:signal.direction,status:'open',openedAt,entryPrice:fill.entryPrice,quantity,stopPrice:stop,targetPrice:target,riskUsd,entryFeeUsd:fill.entryFeeUsd,regime:signal.features.regime,sourceCandleAt:signal.features.closedCandleAt,signal,fill,mode:'PAPER_ONLY',validationPhase:current.filter(t=>t.status==='closed').length>=150?'FORWARD_VALIDATION':'DEVELOPMENT',outOfSample:current.filter(t=>t.status==='closed').length>=150};
    try{
     await db.prepare("INSERT INTO jpti_paper_trades(trade_id,agent_id,symbol,direction,status,opened_at,entry_price,quantity,stop_price,target_price,risk_usd,entry_fee_usd,regime,source_candle_at,payload) VALUES(?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?)")
      .bind(tradeId,agent.id,market.symbol,signal.direction,openedAt,fill.entryPrice,quantity,stop,target,riskUsd,fill.entryFeeUsd,signal.features.regime,signal.features.closedCandleAt,JSON.stringify(trade)).run();
     report.opened.push(trade);action='PAPER_ORDER_OPENED';reason='Simulated entry accepted after market freshness and capital gates.';
    }catch(e){if(!String(e.message||e).includes('UNIQUE'))throw e;reason='Duplicate closed-candle signal ignored (idempotency gate).';}
   }
  }else if(signal.action==='SIGNAL')reason='Entry blocked by spread, risk, drawdown, daily-loss or position-cap gate.';
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
  agents.push({...agent,...stored,id:agent.id,tier:row?.tier||'RESEARCH',status:row?.status||'active',virtualEquityUsd:num(row?.virtual_equity_usd)||PAPER_POLICY.initialEquityUsd,promotedAt:row?.promoted_at||null,metrics,kpi,openTrades:trades.filter(t=>t.status==='open').slice(0,5),recentTrades:trades.slice(0,8)});
 }
 const openTrades=agents.flatMap(a=>a.openTrades.map(t=>({...t,agentName:a.name})));
 return {mode:'PAPER_ONLY',liveExecutionAuthorized:false,exchangeOrdersCreated:0,policy:PAPER_POLICY,agents,openTrades,updatedAt:iso()};
}
export async function dailyReview(db){
 const dash=await dashboard(db),date=iso().slice(0,10);
 const summary={date,mode:'PAPER_ONLY',fleet:{total:dash.agents.length,research:dash.agents.filter(a=>a.tier==='RESEARCH').length,liveReady:dash.agents.filter(a=>a.tier==='LIVE_READY').length,suspended:dash.agents.filter(a=>a.status==='suspended').length,retired:dash.agents.filter(a=>a.status==='retired').length,capitalPerNewAgentUsd:PAPER_POLICY.initialEquityUsd},agents:dash.agents.map(a=>({agentId:a.id,name:a.name,tier:a.tier,metrics:a.metrics,kpi:a.kpi,openPositions:a.openTrades.length})),capitalProtection:{maxDrawdownLimitPct:PAPER_POLICY.maxDrawdownPct,dailyLossLimitPct:PAPER_POLICY.maxDailyLossPct,liveOrdersAllowed:false},dataQuality:'Review uses persisted simulated fills and fee/slippage estimates; it does not certify future profitability.'};
 for(const agent of dash.agents){
  const lifecycle=await promoteOrRetire(db,agent,agent.metrics,agent.kpi);
  if(lifecycle){const item=summary.agents.find(a=>a.agentId===agent.id);if(item){item.tier=lifecycle.status;item.lifecycle=lifecycle;}}
 }
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
  if(request.method==='GET'&&path==='reviews'){
   const rows=await env.JPTI_DB.prepare('SELECT payload FROM jpti_paper_reviews ORDER BY review_date DESC LIMIT 30').all();
   return response(200,{reviews:(rows.results||[]).map(r=>JSON.parse(r.payload))});
  }
  if(request.method==='POST'&&path==='cycle'){
   const body=await request.json().catch(()=>({}));return response(200,await runCycle(env.JPTI_DB,body.symbol||'BTCUSDT'));
  }
  if(request.method==='POST'&&path==='daily-review')return response(200,{review:await dailyReview(env.JPTI_DB)});
  return response(404,{error:'Unknown paper trading endpoint.'});
 }catch(error){return response(502,{error:String(error?.message||error).slice(0,300),mode:'PAPER_ONLY',newEntriesPaused:true});}
}
