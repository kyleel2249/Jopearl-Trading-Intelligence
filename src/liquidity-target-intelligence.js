import { TRADING_SESSIONS } from './session-intelligence.js';

const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
const validRows=(input=[])=>input.map(r=>Array.isArray(r)?r.slice(0,6).map(Number):[r?.timestamp,r?.open,r?.high,r?.low,r?.close,r?.volume].map(Number))
 .filter(r=>r.length===6&&r.every(Number.isFinite)&&r[0]>0&&r[1]>0&&r[2]>=r[3]&&r[4]>0).sort((a,b)=>a[0]-b[0]);
const tfMs=value=>{const m=String(value||'1h').match(/^(\d+)(m|h|d|w)$/i);return m?Number(m[1])*({m:60000,h:3600000,d:86400000,w:604800000})[m[2].toLowerCase()]:3600000;};
const pct=(a,b)=>b?Math.abs(a-b)/Math.abs(b)*100:Infinity;
function sessionNames(ts){return TRADING_SESSIONS.filter(s=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts)).map(x=>[x.type,x.value]));const n=Number(p.hour)*60+Number(p.minute),[oh,om]=s.open.split(':').map(Number),[ch,cm]=s.close.split(':').map(Number);return n>=oh*60+om&&n<ch*60+cm;}).map(s=>s.name);}
function atr(rows,period=14){const ranges=rows.slice(-period).map((r,i,a)=>{const prev=rows[rows.length-a.length+i-1];return Math.max(r[2]-r[3],prev?Math.abs(r[2]-prev[4]):0,prev?Math.abs(r[3]-prev[4]):0);});return mean(ranges);}
function pivots(rows,radius=2){
 const highs=[],lows=[];
 for(let i=radius;i<rows.length-radius;i++){
  const r=rows[i],left=rows.slice(i-radius,i),right=rows.slice(i+1,i+radius+1);
  if(left.every(x=>r[2]>=x[2])&&right.every(x=>r[2]>x[2]))highs.push({price:r[2],index:i,timestamp:r[0],kind:'swing-high'});
  if(left.every(x=>r[3]<=x[3])&&right.every(x=>r[3]<x[3]))lows.push({price:r[3],index:i,timestamp:r[0],kind:'swing-low'});
 }
 return {highs,lows};
}
function clusterLevels(points,side,last,atrValue){
 const tolerance=Math.max(last*.0006,(atrValue||last*.002)*.12);
 const groups=[];
 for(const p of points){
  let group=groups.find(g=>Math.abs(g.center-p.price)<=tolerance);
  if(!group){group={center:p.price,points:[]};groups.push(group);}
  group.points.push(p);group.center=mean(group.points.map(x=>x.price));
 }
 return groups.map(g=>({id:side+'-'+g.points[0].timestamp+'-'+g.points.length,side,price:g.center,touches:g.points.length,
  firstSeen:g.points[0].timestamp,lastSeen:g.points.at(-1).timestamp,ageBars:points.at(-1)?.index-g.points.at(-1).index||0,
  equal:g.points.length>=2,source:g.points.length>=2?'equal-highs/lows':'confirmed-swing',indices:g.points.map(x=>x.index)}))
 .filter(g=>side==='buy-side'?g.price>last:g.price<last);
}
function rankPool(pool,last,atrValue,totalBars){
 const distance=Math.abs(pool.price-last),atrDistance=atrValue>0?distance/atrValue:Infinity;
 const proximity=clamp(40-atrDistance*8,0,40),touches=clamp((pool.touches-1)*9,0,27);
 const freshness=clamp(15-(pool.ageBars/Math.max(1,totalBars))*15,0,15),equal=pool.equal?18:0;
 return {...pool,distance,distancePercent:pct(pool.price,last),atrDistance,score:Math.round(clamp(proximity+touches+freshness+equal,0,100))};
}
function latestSweep(rows,levels,side){
 const last=rows.at(-1);if(!last)return null;
 const pool=[...levels].sort((a,b)=>Math.abs(last[4]-a.price)-Math.abs(last[4]-b.price))[0];
 if(!pool)return null;
 const swept=side==='bullish'?last[3]<pool.price&&last[4]>pool.price:last[2]>pool.price&&last[4]<pool.price;
 if(!swept)return null;
 const body=Math.abs(last[4]-last[1]),range=Math.max(1e-12,last[2]-last[3]);
 return {direction:side,level:pool.price,sweepWick:side==='bullish'?last[3]:last[2],timestamp:last[0],pool,
  displacement:body/range>=.55&&(side==='bullish'?last[4]>last[1]:last[4]<last[1]),bodyRatio:body/range};
}
function detectAt(rows,tf,now){
 if(rows.length<12)return null;
 const closed=rows.filter(r=>r[0]+tf<=now);
 const sample=closed.length>=8?closed:rows;
 if(sample.length<8)return null;
 const p=pivots(sample,2),last=sample.at(-1),a=atr(sample);
 const lowPools=clusterLevels(p.lows,'sell-side',last[4],a),highPools=clusterLevels(p.highs,'buy-side',last[4],a);
 const bull=latestSweep(sample,lowPools,'bullish'),bear=latestSweep(sample,highPools,'bearish');
 const sweep=bull||bear;if(!sweep)return null;
 const targets=sweep.direction==='bullish'?highPools:lowPools;
 const target=targets.sort((x,y)=>Math.abs(x.price-last[4])-Math.abs(y.price-last[4]))[0];
 const risk=Math.abs(last[4]-sweep.sweepWick),reward=target?Math.abs(target.price-last[4]):null,rr=risk>0&&reward!=null?reward/risk:null;
 const volumes=sample.slice(-21,-1).map(r=>r[5]),base=mean(volumes),volumeRatio=base>0?last[5]/base:null;
 const active=sessionNames(last[0]).length>0;
 const score=clamp(35+(sweep.displacement?20:0)+(volumeRatio!=null&&volumeRatio>=1.5?12:0)+(sweep.pool.equal?8:0)+(rr!=null?clamp(rr*7,0,15):0)+(active?10:0),0,100);
 return {direction:sweep.direction,side:sweep.direction==='bullish'?'long':'short',status:score>=65&&rr>=1.5?'watch':'monitor',
  score:Math.round(score),entry:last[4],invalidation:sweep.sweepWick+(sweep.direction==='bullish'?-1:1)*(a||risk||0)*.08,
  target:target?.price??null,rewardRisk:rr==null?null:Number(rr.toFixed(2)),atr:a,volumeRatio,
  liquidityPool:sweep.pool,session:sessionNames(last[0]).join(' + ')||'Outside configured sessions',
  evidence:{sweep:true,displacement:sweep.displacement,bodyRatio:Number(sweep.bodyRatio.toFixed(2)),relativeVolume:volumeRatio==null?null:Number(volumeRatio.toFixed(2)),equalLevel:sweep.pool.equal},
  timestamp:new Date(last[0]).toISOString(),method:'Closed-candle sweep/reclaim + displacement + nearest opposing liquidity pool. Heuristic watch condition; not an order signal.'};
}
export function analyzeLiquidityTargets(input=[],{timeframe='15m',now=Date.now(),maxTargets=5}={}){
 const rows=validRows(input),tf=tfMs(timeframe),forming=rows.filter(r=>r[0]+tf>now),closed=rows.filter(r=>r[0]+tf<=now);
 const sample=closed.length>=12?closed:rows,latest=sample.at(-1),p=sample.length>=5?pivots(sample,2):{highs:[],lows:[]},a=atr(sample);
 const last=latest?.[4]??null;
 const pools=last==null?[]:[...clusterLevels(p.highs,'buy-side',last,a),...clusterLevels(p.lows,'sell-side',last,a)]
  .map(x=>rankPool(x,last,a,sample.length)).sort((x,y)=>y.score-x.score);
 const buy=pools.filter(x=>x.side==='buy-side').sort((x,y)=>y.score-x.score).slice(0,maxTargets);
 const sell=pools.filter(x=>x.side==='sell-side').sort((x,y)=>y.score-x.score).slice(0,maxTargets);
 const setup=detectAt(rows,tf,now);
 const swingHighs=p.highs.slice(-8).reverse(),swingLows=p.lows.slice(-8).reverse();
 const nearestBuy=buy.slice().sort((x,y)=>Math.abs(x.price-last)-Math.abs(y.price-last))[0]||null;
 const nearestSell=sell.slice().sort((x,y)=>Math.abs(x.price-last)-Math.abs(y.price-last))[0]||null;
 const inducement=setup?{state:'possible-inducement',direction:setup.direction,level:setup.liquidityPool.price,confirmedBy:'wick-through-and-close-back-inside',timestamp:setup.timestamp}:null;
 return {status:last==null?'insufficient':'ready',asOf:new Date(now).toISOString(),timeframe,last,atr:a,
  pools:{buySide:buy,sellSide:sell},swingPoints:{highs:swingHighs,lows:swingLows},
  targets:{above:nearestBuy,below:nearestSell},setup,inducement,
  formingCandles:forming.length,closedCandles:closed.length,
  summary:setup?setup.direction+' liquidity sweep; '+setup.status+' setup candidate':nearestBuy||nearestSell?'Liquidity targets ranked from confirmed swing structure':'Waiting for sufficient confirmed swing points',
  limitations:'Targets are heuristic liquidity pools derived from loaded OHLCV pivots. Equal highs/lows are clustered within a volatility-adjusted tolerance. No order-book depth or stop-location data is available; scores are ranking heuristics, not probabilities.'};
}
export function backtestLiquidityPatterns(input=[],{timeframe='15m',horizon=12,minimumScore=65}={}){
 const rows=validRows(input),tf=tfMs(timeframe),trades=[];
 for(let i=20;i<rows.length-horizon;i++){
  const now=rows[i][0]+tf,analysis=analyzeLiquidityTargets(rows.slice(0,i+1),{timeframe,now});
  const s=analysis.setup;if(!s||s.score<minimumScore||s.rewardRisk==null||s.rewardRisk<1)continue;
  const future=rows.slice(i+1,i+1+horizon);let outcome='expired',r=0,exit=null;
  const risk=Math.abs(s.entry-s.invalidation),target=s.target;
  for(const bar of future){
   const stop=s.side==='long'?bar[3]<=s.invalidation:bar[2]>=s.invalidation;
   const take=target!=null&&(s.side==='long'?bar[2]>=target:bar[3]<=target);
   if(stop&&take){outcome='ambiguous';r=0;exit=bar[0];break;}
   if(stop){outcome='loss';r=-1;exit=bar[0];break;}
   if(take){outcome='win';r=s.rewardRisk;exit=bar[0];break;}
  }
  trades.push({timestamp:s.timestamp,side:s.side,score:s.score,outcome,returnR:r,exitAt:exit,horizonBars:horizon});
 }
 const resolved=trades.filter(x=>x.outcome==='win'||x.outcome==='loss'),wins=resolved.filter(x=>x.outcome==='win');
 return {sampleSize:trades.length,resolved:resolved.length,wins:wins.length,losses:resolved.length-wins.length,
  winRate:resolved.length?wins.length/resolved.length*100:null,expectancyR:resolved.length?resolved.reduce((n,x)=>n+x.returnR,0)/resolved.length:null,
  ambiguous:trades.filter(x=>x.outcome==='ambiguous').length,expired:trades.filter(x=>x.outcome==='expired').length,
  trades:trades.slice(-100).reverse(),methodology:'Chronological OHLCV replay with a fixed forward horizon. If stop and target are touched in the same candle, the result is marked ambiguous and excluded from win rate. Fees, slippage and funding are not included.'};
}
