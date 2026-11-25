import { PAPER_AGENTS, AGENT_RESOURCES, PAPER_POLICY, derivePaperSignal, calculatePaperMetrics, assessAgentKpis, simulatePaperFill, settlePaperTrade } from '../../../src/paper-trading-engine.js';
import { evaluateRiskGate, adaptivePositionSize, updateDynamicStop, buildPartialExitPlan } from '../../../src/intelligence-foundation-engine.js';

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
 const [rawCandles,raw5m,raw15m,raw1h,rawTicker]=await Promise.all([
  bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=1m&limit=100'),
  bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=5m&limit=100'),
  bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=15m&limit=100'),
  bitget('/api/v2/mix/market/candles?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES&granularity=1H&limit=100'),
  bitget('/api/v2/mix/market/ticker?symbol='+encodeURIComponent(normalized)+'&productType=USDT-FUTURES')
 ]);
 const parseCandles=raw=>(Array.isArray(raw)?raw:[]).map(r=>r.map(Number)).sort((a,b)=>a[0]-b[0]);
 const candles=parseCandles(rawCandles),timeframes={'5m':parseCandles(raw5m),'15m':parseCandles(raw15m),'1H':parseCandles(raw1h)};
 const t=Array.isArray(rawTicker)?rawTicker[0]:rawTicker;
 const ticker={last:num(t?.lastPr),bid:num(t?.bidPr),ask:num(t?.askPr),timestamp:num(t?.ts)};
 if(!(ticker.last>0)||candles.length<36)throw new Error('Bitget returned insufficient valid ticker/candle data.');
 const age=Date.now()-ticker.timestamp;
 if(!ticker.timestamp||age>30000||age< -5000)throw new Error('Bitget ticker is stale or has an invalid timestamp; paper entries are paused.');
 return {symbol:normalized,candles,timeframes,ticker,source:'Bitget public USDT-FUTURES',receivedAt:iso(),ageMs:age};
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
 const successor={id,name:agent.name+' '+generation,role:agent.role+' · Candidate '+generation,responsibility:agent.responsibility,edge:agent.edge,strategyId:agent.strategyId,generation,tier:'RESEARCH',status:'active',promotedAt:null,resources:[...AGENT_RESOURCES],permissions:{paper:true,live:false},parentAgentId:agent.id,createdAt:iso(),lifecycleNote:'Automatic successor; starts with $1 virtual capital.'};
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
export async function runCycle(db,symbol){
 await ensureAgents(db);
 const market=await marketSnapshot(symbol);
 const report={mode:'PAPER_ONLY',source:market.source,symbol:market.symbol,marketTimestamp:new Date(market.ticker.timestamp).toISOString(),receivedAt:market.receivedAt,ageMs:market.ageMs,opened:[],closed:[],partialExits:[],skipped:[],agents:[]};
 const openRows=await db.prepare("SELECT symbol,direction,COUNT(*) AS count FROM jpti_paper_trades WHERE status='open' GROUP BY symbol,direction").all();
 const exposure={total:0,bySymbol:new Map(),byDirection:new Map()};
 let independentPolicy={maxRiskPercent:PAPER_POLICY.riskPerTradePct,maxNotionalUsd:2500,maxOpenPositions:PAPER_POLICY.maxFleetOpenPositions,maxDailyLossPercent:PAPER_POLICY.maxDailyLossPct,maxDrawdownPercent:PAPER_POLICY.maxDrawdownPct,maxCorrelationExposure:PAPER_POLICY.maxOpenPerSymbol,minimumRewardRisk:1.5,maxSpreadPercent:.15,maxDataAgeMs:60000,requireFreshData:true,circuitBreaker:false,killSwitch:false};
 try{const row=await db.prepare("SELECT policy_json FROM jpti_risk_policies WHERE policy_id='default'").first();if(row?.policy_json)independentPolicy={...independentPolicy,...JSON.parse(row.policy_json)};}catch{/* The existing paper gates remain active until migration 0010 is applied. */}
 report.riskVetoes=[];
 for(const row of openRows.results||[]){const count=num(row.count);exposure.total+=count;exposure.bySymbol.set(row.symbol,(exposure.bySymbol.get(row.symbol)||0)+count);exposure.byDirection.set(row.direction,(exposure.byDirection.get(row.direction)||0)+count);}
 for(const agent of await loadAgents(db)){
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
    open.quantity=remainingQuantity;open.risk_usd=remainingRisk;open.entry_fee_usd=remainingEntryFee;open.payload=JSON.stringify(partialState);
    report.partialExits.push({agentId:agent.id,tradeId:open.trade_id,fills:partialFills,remainingQuantity,realizedPartialPnlUsd:partialState.partialRealizedPnlUsd});
   }
   const realizedToday=trades.filter(t=>t.status==='closed'&&String(t.closedAt||'').slice(0,10)===iso().slice(0,10)).reduce((s,t)=>s+num(t.netPnlUsd),0);
   const unrealizedToday=trades.filter(t=>t.status==='open').reduce((s,t)=>{const move=(market.ticker.last-num(t.entryPrice))*num(t.quantity)*(t.direction==='LONG'?1:-1);return s+move-num(t.entryFeeUsd)-market.ticker.last*num(t.quantity)*PAPER_POLICY.feeRate;},0);
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
    const payload={...open,...settled,exitReason:reason,closedAt:iso(),source:'simulated-last-price',riskBreach:settled.rMultiple < -1.1};
    await db.prepare("UPDATE jpti_paper_trades SET status='closed',closed_at=?,exit_price=?,exit_fee_usd=?,gross_pnl_usd=?,net_pnl_usd=?,r_multiple=?,payload=? WHERE trade_id=? AND status='open'")
     .bind(payload.closedAt,settled.exitPrice,settled.exitFeeUsd,settled.grossPnlUsd,settled.netPnlUsd,settled.rMultiple,JSON.stringify(payload),open.trade_id).run();
    try{
     const outcome={exitReason:reason,exitPrice:settled.exitPrice,grossPnlUsd:settled.grossPnlUsd,netPnlUsd:settled.netPnlUsd,rMultiple:settled.rMultiple,partialExits:settled.partialExits||[],closedAt:payload.closedAt};
     await db.prepare("UPDATE jpti_trade_intelligence SET status='closed',closed_at=?,execution_json=?,outcome_json=?,updated_at=? WHERE trade_id=?").bind(payload.closedAt,JSON.stringify({exitFeeUsd:settled.exitFeeUsd,source:'simulated-last-price'}),JSON.stringify(outcome),payload.closedAt,open.trade_id).run();
     await db.prepare('INSERT INTO jpti_intelligence_memory(memory_id,scope,memory_type,title,content,source,evidence_status,confidence,importance,tags_json,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(),'global','paper-trade-lesson','Paper trade closed: '+market.symbol,JSON.stringify({tradeId:open.trade_id,agentId:agent.id,symbol:market.symbol,direction:open.direction,outcome}),'JPTI paper trade '+open.trade_id,'verified',.65,.75,JSON.stringify(['paper-trade','trade-outcome',market.symbol]),JSON.stringify({regime:open.regime}),payload.closedAt,payload.closedAt).run();
    }catch(error){console.error('[JPTI trade intelligence] Outcome mirror unavailable:',error?.message||error);}
    report.closed.push({agentId:agent.id,tradeId:open.trade_id,...settled,reason});exposure.total=Math.max(0,exposure.total-1);exposure.bySymbol.set(open.symbol,Math.max(0,(exposure.bySymbol.get(open.symbol)||0)-1));exposure.byDirection.set(open.direction,Math.max(0,(exposure.byDirection.get(open.direction)||0)-1));
   }
  }
  const signal=derivePaperSignal(market.candles,market.ticker,agent.strategyId||agent.id,{timeframes:market.timeframes});
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
  const sessionHour=new Date().getUTCHours(),sessionName=sessionHour<7?'ASIA':sessionHour<12?'LONDON':sessionHour<16?'LONDON_NEW_YORK_OVERLAP':sessionHour<22?'NEW_YORK':'ROLLOVER';
  let action='NO_ENTRY',reason=signal.reason;
  if(signal.action==='SIGNAL'&&!current.some(t=>t.symbol===market.symbol&&t.status==='closed'&&Date.now()-Date.parse(t.closedAt||0)<15*60*1000)&&sessionName!=='ROLLOVER'&&signal.features&&Number.isFinite(signal.features.spreadPct)&&signal.features.spreadPct<=0.15&&signal.features.atrPct>0&&signal.features.timeframeAgreement>=2&&openNow<PAPER_POLICY.maxOpenPositions&&exposure.total<PAPER_POLICY.maxFleetOpenPositions&&(exposure.bySymbol.get(market.symbol)||0)<PAPER_POLICY.maxOpenPerSymbol&&(exposure.byDirection.get(signal.direction)||0)<PAPER_POLICY.maxSameDirectionOpenPositions&&metrics.maxDrawdownPct<PAPER_POLICY.maxDrawdownPct&&dailyLoss>-(metrics.equityUsd*PAPER_POLICY.maxDailyLossPct/100)){
   const price=market.ticker.last,stopDistance=Math.max(price*0.0035,price*signal.features.atrPct/100*1.2);
   const sizing=adaptivePositionSize({equity:metrics.equityUsd,entryPrice:price,stopPrice:signal.direction==='LONG'?price-stopDistance:price+stopDistance,baseRiskPercent:PAPER_POLICY.riskPerTradePct,regime:signal.features.regime,confidence:Number(signal.confidence)||.65,correlationFactor:(exposure.bySymbol.get(market.symbol)||0)>0?.5:1},independentPolicy);
   const riskUsd=sizing.riskAmount;
   const allInRiskPerUnit=stopDistance+price*(PAPER_POLICY.feeRate*2+(PAPER_POLICY.slippageBps*2+PAPER_POLICY.spreadBps)/10000);
   const quantity=Math.min(sizing.quantity||0,riskUsd/allInRiskPerUnit,Math.max(0,metrics.equityUsd)/(price*(1+PAPER_POLICY.feeRate)));
   if(quantity>0&&Number.isFinite(quantity)){
    const riskDecision=evaluateRiskGate({riskPercent:riskUsd/Math.max(1,metrics.equityUsd)*100,notionalUsd:quantity*price,openPositions:openNow,dailyLossPercent:Math.abs(Math.min(0,dailyLoss))/Math.max(1,metrics.equityUsd)*100,drawdownPercent:metrics.maxDrawdownPct,rewardRisk:1.5,spreadPercent:signal.features.spreadPct,dataAgeMs:market.ageMs,dataFresh:Number(market.ageMs)<=Number(independentPolicy.maxDataAgeMs||60000),correlatedOpenPositions:exposure.bySymbol.get(market.symbol)||0,confidence:Number(signal.confidence)||.65},independentPolicy);
    if(!riskDecision.allowed){
     reason='Independent risk veto: '+riskDecision.violations.map(x=>x.code).join(', ');
     report.riskVetoes.push({agentId:agent.id,decision:riskDecision});
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
       .bind(tradeId,agent.id,agent.strategyId||null,market.symbol,'paper',signal.direction,'open',fingerprint,fill.entryPrice,stop,target,riskUsd,1.5,signal.features.regime,sessionName,Number(signal.confidence)||.65,JSON.stringify({signal,closedCandleAt:signal.features.closedCandleAt}),JSON.stringify([{agentId:agent.id,assessment:'PAPER_ENTRY_APPROVED'}]),JSON.stringify({fill,mode:'PAPER_ONLY'}),'{}','[]',openedAt,openedAt,openedAt).run();
     }catch(error){console.error('[JPTI trade intelligence] Entry mirror unavailable:',error?.message||error);}
     report.opened.push(trade);exposure.total+=1;exposure.bySymbol.set(market.symbol,(exposure.bySymbol.get(market.symbol)||0)+1);exposure.byDirection.set(signal.direction,(exposure.byDirection.get(signal.direction)||0)+1);action='PAPER_ORDER_OPENED';reason='Simulated entry accepted after market freshness, per-agent and fleet exposure gates.';
    }catch(e){if(!String(e.message||e).includes('UNIQUE'))throw e;reason='Duplicate closed-candle signal ignored (idempotency gate).';}
   }
    }
   }
  }else if(signal.action==='SIGNAL')reason='Entry blocked by spread, risk, drawdown, daily-loss, per-agent, fleet, symbol-concentration, direction-concentration or independent risk gate.';
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
 return {mode:'PAPER_ONLY',liveExecutionAuthorized:false,exchangeOrdersCreated:0,policy:PAPER_POLICY,agents,openTrades,updatedAt:iso()};
}
export async function dailyReview(db){
 const dash=await dashboard(db),date=iso().slice(0,10);
 const summary={date,mode:'PAPER_ONLY',fleet:{total:dash.agents.length,research:dash.agents.filter(a=>a.tier==='RESEARCH').length,liveReady:dash.agents.filter(a=>a.tier==='LIVE_READY').length,suspended:dash.agents.filter(a=>a.status==='suspended').length,retired:dash.agents.filter(a=>a.status==='retired').length,capitalPerNewAgentUsd:PAPER_POLICY.initialEquityUsd},agents:dash.agents.map(a=>({agentId:a.id,name:a.name,tier:a.tier,metrics:a.metrics,kpi:a.kpi,openPositions:a.openTrades.length})),capitalProtection:{maxDrawdownLimitPct:PAPER_POLICY.maxDrawdownPct,dailyLossLimitPct:PAPER_POLICY.maxDailyLossPct,maxFleetOpenPositions:PAPER_POLICY.maxFleetOpenPositions,maxOpenPerSymbol:PAPER_POLICY.maxOpenPerSymbol,maxSameDirectionOpenPositions:PAPER_POLICY.maxSameDirectionOpenPositions,liveOrdersAllowed:false},dataQuality:'Review uses persisted simulated fills and fee/slippage estimates; it does not certify future profitability.'};
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
