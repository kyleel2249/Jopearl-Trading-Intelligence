import { TRADING_SESSIONS, getSessionSnapshot } from './session-intelligence.js';

const SESSION_MEMORY_KEY = 'jpti.session-memory.v1';
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const validCandles=(rows=[])=>rows.map(c=>Array.isArray(c)?c.slice(0,6):[c?.timestamp,c?.open,c?.high,c?.low,c?.close,c?.volume]).filter(c=>c.length>=6&&c.every(v=>Number.isFinite(Number(v)))&&Number(c[0])>0&&Number(c[2])>=Number(c[3])).map(c=>c.map(Number)).sort((a,b)=>a[0]-b[0]);
const localParts=(timestamp,zone)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(timestamp)).map(p=>[p.type,p.value]));
function keyFor(timestamp,zone){const p=localParts(timestamp,zone);return p.year+'-'+p.month+'-'+p.day;}
function withinSession(minute,session){const [oh,om]=session.open.split(':').map(Number),[ch,cm]=session.close.split(':').map(Number);return minute>=oh*60+om&&minute<ch*60+cm;}
function sessionAt(timestamp){const snapshot=getSessionSnapshot(timestamp);return snapshot.sessions.filter(s=>s.active);}
export function sessionForecastAdjustment(candles,{symbol='unknown',timeframe='unknown',now=Date.now(),baseConfidence=50}={}){
 const rows=validCandles(candles);const current=sessionAt(now);if(!rows.length||!current.length)return {status:'insufficient',activeSessions:current.map(s=>s.name),confidence:clamp(baseConfidence,0,100),adjustment:0,reason:'No active session or valid candle sample'};
 const returns=rows.slice(-80).map((c,i,a)=>i?Math.log(c[4]/a[i-1][4]):null).filter(Number.isFinite);
 const baseDrift=mean(returns)||0,baseVol=mean(returns.map(r=>r*r))||0;
 const relevant=current.map(s=>{const sessionRows=rows.filter(c=>{const p=localParts(c[0],s.timezone);const minute=Number(p.hour)*60+Number(p.minute);return withinSession(minute,s);});const rs=sessionRows.slice(1).map((c,i)=>Math.log(c[4]/sessionRows[i][4])).filter(Number.isFinite);return {id:s.id,name:s.name,n:rs.length,drift:mean(rs)||0,vol:mean(rs.map(r=>r*r))||0};});
 const pooled= relevant.filter(s=>s.n>=5), drift=pooled.length?mean(pooled.map(s=>s.drift)):baseDrift, vol=pooled.length?mean(pooled.map(s=>s.vol)):baseVol;
 const direction=drift>0?'bullish':drift<0?'bearish':'neutral';const volatilityRatio=baseVol>0?Math.sqrt(vol/baseVol):1;
 const adjustment=clamp((direction==='neutral'?0:Math.sign(drift)*Math.min(8,Math.abs(drift)*10000)),-8,8);
 return {status:'ready',symbol,timeframe,activeSessions:current.map(s=>s.name),sampleCount:pooled.reduce((n,s)=>n+s.n,0),direction,confidence:clamp(baseConfidence+adjustment,5,95),adjustment:Number(adjustment.toFixed(2)),sessionVolatilityRatio:Number(volatilityRatio.toFixed(3)),sessionDrift:drift,baselineDrift:baseDrift,reason:pooled.length?'Historical active-session returns adjust baseline forecast confidence.':'Session history is sparse; baseline candle returns used.'};
}
export function detectSessionLiquiditySweeps(candles,{now=Date.now(),lookbackSessions=12,confirmationBars=6}={}){
 const rows=validCandles(candles),levels=[],events=[];if(rows.length<3)return {status:'insufficient',events,levels};
 for(const session of TRADING_SESSIONS){
  const grouped=new Map();
  for(const c of rows){const p=localParts(c[0],session.timezone),min=Number(p.hour)*60+Number(p.minute);if(!withinSession(min,session))continue;const k=p.year+'-'+p.month+'-'+p.day;let bucket=grouped.get(k);if(!bucket)grouped.set(k,bucket={date:k,high:-Infinity,low:Infinity,open:c[1],last:c[4],volume:0,candles:[]});bucket.high=Math.max(bucket.high,c[2]);bucket.low=Math.min(bucket.low,c[3]);bucket.last=c[4];bucket.volume+=c[5];bucket.candles.push(c);}
  const days=[...grouped.values()].sort((a,b)=>a.date.localeCompare(b.date)),recent=days.slice(-lookbackSessions-1),completed=recent.slice(0,-1),latest=recent.at(-1),prior=completed.at(-1);
  if(prior)levels.push({session:session.name,date:prior.date,high:prior.high,low:prior.low,kind:'prior-session'});
  const todayKey=keyFor(now,session.timezone),todayRange=grouped.get(todayKey);
  if(todayRange)levels.push({session:session.name,date:todayRange.date,high:todayRange.high,low:todayRange.low,kind:'current-session-range'});
  if(session.id==='tokyo'&&latest)levels.push({session:'Asia/Tokyo',date:latest.date,high:latest.high,low:latest.low,kind:'asian-range'});
 }
 const levelMap=new Map();
 for(const l of levels){const k=[l.session,l.date,l.kind,l.high,l.low].join('|');if(!levelMap.has(k))levelMap.set(k,l);}
 const uniqueLevels=[...levelMap.values()];
 const maxWindow=Math.max(2,Math.min(confirmationBars,12));
 for(const level of uniqueLevels){
  for(const side of ['buy-side','sell-side']){
   const price=side==='buy-side'?level.high:level.low;
   if(!Number.isFinite(price))continue;
   for(let i=1;i<rows.length-1;i++){
    const c=rows[i],prev=rows[i-1];
    const crossed=side==='buy-side'?c[2]>price&&prev[2]<=price:c[3]<price&&prev[3]>=price;
    if(!crossed)continue;
    const sweep={type:'liquidity-sweep',phase:'sweep-detected',side,session:level.session,level:price,kind:level.kind,timestamp:c[0],candleIndex:i,wickExcursion:Number((side==='buy-side'?c[2]-price:price-c[3]).toPrecision(8))};
    events.push(sweep);
    let reclaimIndex=-1;
    for(let j=i+1;j<=Math.min(rows.length-1,i+maxWindow);j++){
     const next=rows[j];
     if(side==='buy-side'?next[4]<price:next[4]>price){reclaimIndex=j;break;}
    }
    if(reclaimIndex<0){events.push({...sweep,phase:'reclaim-pending',expiresAtCandleIndex:Math.min(rows.length-1,i+maxWindow)});continue;}
    const reclaim=rows[reclaimIndex],reclaimEvent={...sweep,phase:'reclaim-confirmed',reclaimTimestamp:reclaim[0],reclaimCandleIndex:reclaimIndex,reclaimClose:reclaim[4],barsToReclaim:reclaimIndex-i};
    events.push(reclaimEvent);
    let displacementIndex=-1;
    for(let k=reclaimIndex+1;k<=Math.min(rows.length-1,reclaimIndex+maxWindow);k++){
      const follow=rows[k],range=follow[2]-follow[3],body=Math.abs(follow[4]-follow[1]),bodyRatio=range>0?body/range:0;
      const displaced=side==='buy-side'?follow[4]<reclaim[3]&&follow[4]<follow[1]:follow[4]>reclaim[2]&&follow[4]>follow[1];
      if(displaced&&bodyRatio>=.45){displacementIndex=k;events.push({...reclaimEvent,phase:'displacement-confirmed',displacementTimestamp:follow[0],displacementCandleIndex:k,displacementClose:follow[4],bodyRatio:Number(bodyRatio.toFixed(3)),barsToDisplacement:k-reclaimIndex});break;}
    }
    if(displacementIndex<0)events.push({...reclaimEvent,phase:'displacement-pending'});
   }
  }
 }
 return {status:'ready',events:events.slice(-120),levels:uniqueLevels.slice(-24),checkedAt:new Date(now).toISOString(),candleCount:rows.length,confirmationWindowBars:maxWindow,method:'multi-stage wick sweep → close reclaim → directional displacement; unconfirmed stages remain pending'};
}
export function sessionRiskAssessment(candles,{now=Date.now(),baseRiskPercent=1,volatilityPercent=null}={}){
 const rows=validCandles(candles),sessions=getSessionSnapshot(now),active=sessions.sessions.filter(s=>s.active),last=rows.at(-1);
 const ranges=rows.slice(-20).map(c=>c[2]-c[3]).filter(v=>v>0),avgRange=mean(ranges),currentRange=last?last[2]-last[3]:null;
 const ratio=avgRange&&currentRange?currentRange/avgRange:1;const lowLiquidity=!active.length,opening=active.some(s=>s.elapsedMinutes<30),overlap=active.length>1,abnormal=ratio>=2.5||Number(volatilityPercent)>=2.5;
 let multiplier=1;const reasons=[];if(lowLiquidity){multiplier*=.5;reasons.push('Outside defined major sessions: reduce exposure');}if(opening){multiplier*=.75;reasons.push('Session opening window: reduce exposure');}if(overlap){multiplier*=1;reasons.push('Session overlap: liquidity opportunity identified, risk cap retained');}if(abnormal){multiplier*=.5;reasons.push('Abnormal candle range/volatility: cut risk');}
 return {riskPercent:Number((clamp(baseRiskPercent,0,10)*multiplier).toFixed(4)),multiplier:Number(multiplier.toFixed(3)),activeSessions:active.map(s=>s.name),lowLiquidity,opening,overlap,abnormal,rangeRatio:Number((ratio||1).toFixed(3)),reasons,mode:abnormal||lowLiquidity?'defensive':'standard',orderAuthorization:false};
}
export function sessionPerformanceComparison(candles,{now=Date.now()}={}){
 const rows=validCandles(candles), result={};for(const session of TRADING_SESSIONS){const grouped=new Map();rows.forEach(c=>{const p=localParts(c[0],session.timezone),minute=Number(p.hour)*60+Number(p.minute);if(!withinSession(minute,session))return;const k=p.year+'-'+p.month+'-'+p.day;let d=grouped.get(k);if(!d)grouped.set(k,d={open:c[1],high:-Infinity,low:Infinity,last:c[4],volume:0,n:0});d.high=Math.max(d.high,c[2]);d.low=Math.min(d.low,c[3]);d.last=c[4];d.volume+=c[5];d.n++;});const days=[...grouped.values()],range=days.map(d=>d.high-d.low),direction=days.map(d=>d.last>d.open?1:d.last<d.open?-1:0);result[session.id]={name:session.name,observations:days.length,averageRange:mean(range),averageRangePercent:mean(days.map(d=>(d.high-d.low)/d.open*100)),averageVolume:mean(days.map(d=>d.volume)),directionalBias:mean(direction),upDays:direction.filter(d=>d>0).length,downDays:direction.filter(d=>d<0).length};}
 return {status:rows.length?'ready':'insufficient',sessions:result,candleCount:rows.length,asOf:new Date(now).toISOString()};
}
export function readSessionMemory(){try{if(typeof localStorage==='undefined')return [];const data=JSON.parse(localStorage.getItem(SESSION_MEMORY_KEY)||'[]');return Array.isArray(data)?data:[];}catch{return [];}}
export function recordSessionOutcome(record){if(!record||!['win','loss','breakeven'].includes(record.outcome))return {ok:false,error:'Outcome must be win, loss or breakeven.'};const row={id:record.id||((globalThis.crypto?.randomUUID?.())||String(Date.now())),createdAt:record.createdAt||new Date().toISOString(),session:record.session||'unknown',symbol:record.symbol||'unknown',strategy:record.strategy||'unknown',volatility:record.volatility||'unknown',outcome:record.outcome,returnR:record.returnR!==null&&record.returnR!==undefined&&record.returnR!==''&&Number.isFinite(Number(record.returnR))?Number(record.returnR):null,notes:String(record.notes||'').slice(0,500)};try{const memory=readSessionMemory();memory.unshift(row);const trimmed=memory.slice(0,2000);if(typeof localStorage!=='undefined')localStorage.setItem(SESSION_MEMORY_KEY,JSON.stringify(trimmed));return {ok:true,record:row,count:trimmed.length};}catch{return {ok:false,error:'Session memory could not be persisted in this browser.'};}}
export function summarizeSessionMemory(records=readSessionMemory()){const grouped={};records.forEach(r=>{const k=[r.session,r.symbol,r.strategy,r.volatility].join('|');const g=grouped[k]|| (grouped[k]={session:r.session,symbol:r.symbol,strategy:r.strategy,volatility:r.volatility,trades:0,wins:0,losses:0,breakevens:0,totalR:0,scored:0});g.trades++;if(r.outcome==='win')g.wins++;if(r.outcome==='loss')g.losses++;if(r.outcome==='breakeven')g.breakevens++;if(r.returnR!==null&&r.returnR!==undefined&&r.returnR!==''&&Number.isFinite(Number(r.returnR))){g.totalR+=Number(r.returnR);g.scored++;}});return Object.values(grouped).map(g=>({...g,winRate:g.trades?(g.wins/g.trades*100):0,averageR:g.scored?g.totalR/g.scored:null}));}
