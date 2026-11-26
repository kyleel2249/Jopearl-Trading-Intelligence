const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,Number.isFinite(Number(v))?Number(v):0));
const number=(v,fallback=null)=>v===null||v===undefined||v===''?fallback:Number.isFinite(Number(v))?Number(v):fallback;

export const AGENT_SAFETY_POLICY=Object.freeze({
  minimumHealthScore:70,minimumTrustScore:60,maxDataAgeMs:60000,
  maxDailyLossPct:2,maxDrawdownPct:5,maxConsecutiveLosses:4,
  maxLatencyMs:5000,maxErrorRate:.15,version:'1.0.0'
});

export function scoreAgentHealth(input={},policy=AGENT_SAFETY_POLICY){
  let score=100;
  const heartbeat=String(input.heartbeatStatus||'unknown').toLowerCase();
  const latency=number(input.latencyMs),errorRate=number(input.errorRate,0);
  const age=number(input.heartbeatAgeMs);
  if(['offline','blocked'].includes(heartbeat))score=0;
  else if(heartbeat==='degraded')score-=25;
  else if(heartbeat==='unknown')score-=15;
  if(latency!==null&&latency>policy.maxLatencyMs)score-=Math.min(25,10+(latency-policy.maxLatencyMs)/policy.maxLatencyMs*10);
  if(errorRate>policy.maxErrorRate)score-=Math.min(35,(errorRate-policy.maxErrorRate)*100);
  if(input.dataFresh===false)score-=35;
  if(age!==null&&age>120000)score-=Math.min(35,(age-120000)/120000*15);
  const violations=Math.max(0,number(input.riskViolations,0));
  score-=Math.min(50,violations*15);
  return {score:Math.round(clamp(score)),heartbeatStatus:heartbeat,latencyMs:latency,errorRate,dataFresh:input.dataFresh===true,healthBand:score>=85?'healthy':score>=70?'watch':'degraded'};
}

const CRITICAL_ANOMALIES=new Set(['unauthorised-access','unauthorized-access','unauthorised-order','unauthorized-order','policy-bypass','risk-override-attempt','risk-policy-override','credential-compromise','secret-access-attempt','secret-read-attempt','unauthorized-secret-access','exchange-write-attempt','withdrawal-attempt','ledger-tamper-attempt','duplicate-order-flood','prompt-injection']);
export function detectAgentAnomalies(events=[]){
  return (Array.isArray(events)?events:[]).filter(event=>event&&typeof event==='object').map(event=>{
    const type=String(event.type||event.eventType||'').trim().toLowerCase();
    const severity=CRITICAL_ANOMALIES.has(type)?'critical':['critical','high','medium','low','info'].includes(event.severity)?event.severity:'medium';
    return {type,severity,summary:String(event.summary||type||'Unclassified agent event').slice(0,300),at:event.at||event.observedAt||null,source:String(event.source||'agent-telemetry').slice(0,80)};
  }).filter(event=>event.type);
}

export function evaluateAgentSafety(input={},policy={}){
  const p={...AGENT_SAFETY_POLICY,...policy},health=scoreAgentHealth(input,p);
  const trust=clamp(number(input.trustScore,0)),age=number(input.dataAgeMs);
  const events=detectAgentAnomalies(input.anomalies),reasons=[];
  const add=(code,message)=>reasons.push({code,message});
  if(input.safetyStorageReady===false)add('SAFETY_STORAGE_UNAVAILABLE','Persistent fleet safety state is unavailable; new entries are disabled.');
  if(input.killSwitch===true)add('GLOBAL_KILL_SWITCH','Global operator kill switch is active.');
  if(input.circuitBreaker===true)add('FLEET_CIRCUIT_BREAKER','Fleet circuit breaker is tripped.');
  if(input.quarantined===true)add('AGENT_QUARANTINED','Agent is in quarantine and cannot open new risk.');
  if(['offline','blocked','suspended','retired'].includes(String(input.agentStatus||'').toLowerCase()))add('AGENT_NOT_ACTIVE','Agent status does not permit new entries.');
  if(input.dataFresh!==true||age===null||age>p.maxDataAgeMs)add('MARKET_DATA_UNSAFE','Market data is missing, stale or unverified.');
  if(health.score<p.minimumHealthScore)add('AGENT_HEALTH_LOW','Agent health score is below policy.');
  if(trust<p.minimumTrustScore)add('AGENT_TRUST_LOW','Agent trust score is below policy.');
  const dailyLoss=number(input.dailyLossPct,0),drawdown=number(input.drawdownPct,0),lossStreak=number(input.consecutiveLosses,0);
  if(dailyLoss>=p.maxDailyLossPct)add('DAILY_LOSS_LIMIT','Daily loss limit reached.');
  if(drawdown>=p.maxDrawdownPct)add('DRAWDOWN_LIMIT','Portfolio or agent drawdown limit reached.');
  if(lossStreak>=p.maxConsecutiveLosses)add('LOSS_STREAK_LIMIT','Consecutive-loss limit reached.');
  if(input.sessionAllowed!==true)add('SESSION_CLOSED','The configured trading session is not eligible for new entries.');
  if(input.strategySuspended===true)add('STRATEGY_SUSPENDED','Strategy is suspended pending fresh validation.');
  if(input.duplicateIntent===true)add('DUPLICATE_INTENT','A duplicate entry intent already exists.');
  if(input.oppositeIntentCollision===true)add('OPPOSITE_INTENT_COLLISION','Agents disagree on direction for the same instrument; entry is vetoed.');
  if(input.bookValid===false)add('ORDER_BOOK_INVALID','Order book is invalid after a sequence gap or recovery.');
  for(const event of events)if(event.severity==='critical')add('CRITICAL_AGENT_ANOMALY',event.type+': '+event.summary);
  const critical=events.some(event=>event.severity==='critical');
  const quarantine=critical||health.score<40||input.quarantineRequested===true;
  return {
    allowed:reasons.length===0,decision:reasons.length?'BLOCK':'PAPER_ELIGIBLE',
    status:quarantine?'QUARANTINED':reasons.length?'BLOCKED':'HEALTHY',
    health,trustScore:trust,reasons,anomalies:events,quarantine,
    permissions:{research:true,paper:reasons.length===0,live:false,withdrawals:false,credentialRead:false},
    liveExecutionAuthorized:false,policyVersion:p.version,evaluatedAt:new Date().toISOString()
  };
}

export function arbitrateAgentIntents(intents=[]){
  const groups=new Map();
  for(const raw of Array.isArray(intents)?intents:[]){
    const symbol=String(raw?.symbol||'').trim().toUpperCase(),side=String(raw?.direction||raw?.side||'').trim().toUpperCase();
    if(!symbol||!['LONG','SHORT'].includes(side))continue;
    const key=symbol,group=groups.get(key)||[];group.push({...raw,symbol,direction:side});groups.set(key,group);
  }
  const accepted=[],rejected=[],collisions=[];
  for(const [symbol,group] of groups){
    const directions=new Set(group.map(x=>x.direction));
    if(directions.size>1){collisions.push({symbol,agents:group.map(x=>x.agentId||'unknown'),directions:[...directions]});for(const intent of group)rejected.push({intent,reason:'opposite-direction collision'});continue;}
    const ranked=[...group].sort((a,b)=>(number(b.confidence,0)-number(a.confidence,0))||(number(b.score,0)-number(a.score,0)));
    accepted.push(ranked[0]);for(const intent of ranked.slice(1))rejected.push({intent,reason:'duplicate same-direction intent; one fleet entry per symbol per cycle'});
  }
  return {accepted,rejected,collisions,policy:'ONE_ENTRY_PER_SYMBOL_PER_CYCLE'};
}
