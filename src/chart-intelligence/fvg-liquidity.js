// Unified FVG + liquidity relationship analysis. Pure, deterministic and closed-candle based.
// This module enriches the canonical chart engine; it never creates a competing BUY/SELL signal.
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const finite=v=>Number.isFinite(Number(v));
const round=(v,n=6)=>finite(v)?Number(Number(v).toFixed(n)):null;
const candleTs=c=>Number(c?.[0]);
const candleHigh=c=>Number(c?.[2]);
const candleLow=c=>Number(c?.[3]);
const candleClose=c=>Number(c?.[4]);

function clusterLiquidity(pools, price, atr, toleranceAtr=.18){
  const valid=(pools||[]).filter(p=>finite(p.price)&&["high","low"].includes(p.side));
  const out=[];
  for(const side of ["high","low"]){
    const sorted=valid.filter(p=>p.side===side).sort((a,b)=>Number(a.price)-Number(b.price));
    for(const pool of sorted){
      const group=out.find(g=>g.side===side&&Math.abs(g.price-pool.price)<=atr*toleranceAtr);
      if(group){group.members.push(pool);group.price=group.members.reduce((s,x)=>s+Number(x.price),0)/group.members.length;}
      else out.push({side,price:Number(pool.price),members:[pool]});
    }
  }
  return out.map((g,i)=>{
    const nearestDistanceAtr=atr>0?Math.abs(g.price-price)/atr:null;
    const external=g.members.some(x=>x.kind==="EXTERNAL");
    const equal=g.members.some(x=>x.kind==="EQH"||x.kind==="EQL");
    const strength=clamp(.25+Math.min(g.members.length,4)*.09+(external?.2:0)+(equal?.12:0));
    return {id:"liq-cluster-"+i,side:g.side,price:round(g.price),members:g.members.length,
      kinds:[...new Set(g.members.map(x=>x.kind))],external,equal,strength:round(strength,3),
      distanceAtr:round(nearestDistanceAtr,3),status:"active"};
  });
}

function liquidityTargets(clusters, direction, entry, atr){
  const side=direction==="bullish"?"high":"low", sign=dirSign(direction);
  return clusters.filter(x=>x.side===side&&(x.price-entry)*sign>0)
    .sort((a,b)=>Math.abs(a.price-entry)-Math.abs(b.price-entry))
    .slice(0,4).map((x,i)=>({rank:i+1,price:x.price,source:"liquidity-cluster",strength:x.strength,
      distanceAtr:round(Math.abs(x.price-entry)/atr,3),id:x.id}));
}

function classifyLifecycle(fvg){
  if(fvg.status==="filled"||Number(fvg.fillPct)>=100)return "fully-mitigated";
  if(Number(fvg.fillPct)>0||fvg.status==="mitigated")return "partially-mitigated";
  if(fvg.status==="invalidated")return "invalidated";
  return "fresh";
}

/**
 * Correlates sweeps -> displacement -> same-direction FVG -> retest context.
 * Inputs are SMC objects generated from confirmed candles. No future bars are read.
 */
export function analyzeFvgLiquidity(smc, candles, {atr=0, timeframeMs=60_000, maxSweepToFvgBars=8, maxSweepAgeBars=24, now=Date.now()}={}){
  const items=smc?.items||[], pools=smc?.liquidity?.pools||[];
  const rows=(candles||[]).filter(c=>Array.isArray(c)&&c.length>=6&&c.every((v,i)=>i===0||finite(v))).sort((a,b)=>candleTs(a)-candleTs(b));
  const price=rows.length?candleClose(rows.at(-1)):null;
  if(!rows.length||!(atr>0))return {status:"insufficient",generatedAt:new Date(now).toISOString(),clusters:[],setups:[],activeFvgs:[],summary:{reason:"Closed candles or ATR are unavailable."}};
  const clusters=clusterLiquidity(pools,price,atr);
  const sweeps=items.filter(x=>x.kind==="LIQUIDITY_SWEEP"&&finite(x.ts));
  const gaps=items.filter(x=>x.kind==="FVG"&&finite(x.top)&&finite(x.bottom)&&x.top>x.bottom);
  const displacements=items.filter(x=>x.kind==="DISPLACEMENT");
  const structures=items.filter(x=>["BOS","CHoCH","MSS"].includes(x.kind));
  const setups=[];
  for(const sweep of sweeps){
    const direction=sweep.direction;
    const sweepIndex=rows.findIndex(c=>candleTs(c)===Number(sweep.ts));
    if(sweepIndex<0)continue;
    const impulse=displacements.find(d=>d.direction===direction&&d.ts>=sweep.ts&&d.ts<=sweep.ts+maxSweepToFvgBars*timeframeMs);
    const fvg=gaps.filter(g=>g.direction===direction&&g.ts>=sweep.ts&&g.ts<=sweep.ts+maxSweepToFvgBars*timeframeMs)
      .sort((a,b)=>a.ts-b.ts)[0];
    if(!fvg)continue;
    const structure=structures.filter(s=>s.direction===direction&&s.ts>=sweep.ts&&s.ts<=fvg.ts+2*timeframeMs).sort((a,b)=>a.ts-b.ts).at(-1)||null;
    const fvgAgeBars=Math.max(0,Math.floor((rows.at(-1)[0]-fvg.ts)/timeframeMs));
    const lifecycle=classifyLifecycle(fvg);
    const inZone=price<=fvg.top&&price>=fvg.bottom;
    const partiallyTouched=rows.some(c=>candleTs(c)>fvg.ts&&(candleLow(c)<=fvg.top&&candleHigh(c)>=fvg.bottom));
    const impulseQuality=clamp(Number(impulse?.strength??.35));
    const sweepQuality=clamp(Number(sweep.quality??sweep.strength??.35));
    const fvgSizeAtr=(fvg.top-fvg.bottom)/atr;
    const sizeQuality=clamp(fvgSizeAtr/.8);
    const freshness=lifecycle==="fresh" ? 1 : lifecycle==="partially-mitigated" ? 0.65 : lifecycle==="fully-mitigated" ? 0.25 : 0;
    const structureQuality=structure?(structure.kind==="MSS"?1:structure.kind==="CHoCH"?.8:.65):0;
    const ageQuality=clamp(1-fvgAgeBars/Math.max(1,maxSweepAgeBars));
    const mid=(fvg.top+fvg.bottom)/2;
    const ote=items.find(x=>x.direction===direction&&((direction==="bullish"&&x.kind==="OTE_BULLISH")||(direction==="bearish"&&x.kind==="OTE_BEARISH"))&&finite(x.top)&&finite(x.bottom))||null;
    const orderBlock=items.filter(x=>x.layer==="orderBlocks"&&x.direction===direction&&x.top!=null&&x.bottom!=null&&x.kind!=="BREAKER"&&x.status!=="invalidated").sort((a,b)=>Math.abs((a.top+a.bottom)/2-mid)-Math.abs((b.top+b.bottom)/2-mid))[0]||null;
    const oteOverlap=!!(ote&&Math.max(fvg.bottom,ote.bottom)<=Math.min(fvg.top,ote.top));
    const orderBlockOverlap=!!(orderBlock&&Math.max(fvg.bottom,orderBlock.bottom)<=Math.min(fvg.top,orderBlock.top));
    const dealing=smc?.dealingRange||null;
    const premiumDiscount=dealing?direction==="bullish"?(mid<=dealing.equilibrium?"discount":"premium"):(mid>=dealing.equilibrium?"premium":"discount"):"unavailable";
    const locationQuality=(premiumDiscount==="discount"&&direction==="bullish")||(premiumDiscount==="premium"&&direction==="bearish") ? 1 : premiumDiscount==="unavailable" ? 0.5 : 0;
    const score=Math.round(100*(.18*sweepQuality+.16*impulseQuality+.12*sizeQuality+.15*freshness+.12*structureQuality+.05*ageQuality+.08*(oteOverlap?1:0)+.08*(orderBlockOverlap?1:0)+.06*locationQuality));
    const targets=liquidityTargets(clusters,direction,mid,atr);
    const riskSide=direction==="bullish"?"low":"high";
    const opposing=clusters.filter(c=>c.side===riskSide).sort((a,b)=>Math.abs(a.price-mid)-Math.abs(b.price-mid))[0]||null;
    const state=lifecycle==="invalidated"?"invalidated":lifecycle==="fully-mitigated"?"consumed":inZone?"retest-in-zone":partiallyTouched?"retest-observed":fvgAgeBars>maxSweepAgeBars?"expired":"awaiting-retest";
    const reasons=[];
    if(!impulse)reasons.push("No same-direction displacement was recorded after the sweep.");
    if(!structure)reasons.push("No same-direction BOS, CHoCH or MSS followed the sweep.");
    if(lifecycle!=="fresh")reasons.push("The FVG has already been revisited; freshness is reduced.");
    if(!targets.length)reasons.push("No opposing-side liquidity target is mapped ahead of the entry zone.");
    setups.push({
      id:["FVG-LIQ",sweep.ts,fvg.ts,direction].join("|"),direction,state,score,
      sweep:{ts:sweep.ts,price:sweep.price,poolType:sweep.poolType,quality:round(sweepQuality,3)},
      displacement:impulse?{ts:impulse.ts,strength:round(impulseQuality,3)}:null,
      structure:structure?{kind:structure.kind,ts:structure.ts}:null,
      fvg:{ts:fvg.ts,top:round(fvg.top),bottom:round(fvg.bottom),mid:round(mid),sizeAtr:round(fvgSizeAtr,3),fillPct:fvg.fillPct??null,lifecycle},
      entryZone:{low:round(fvg.bottom),high:round(fvg.top),mid:round(mid),basis:"FVG retracement; wait for closed-candle confirmation"},
      invalidationReference:opposing?{price:opposing.price,source:"nearest opposing-side liquidity"}:null,
      targets,confluenceZones:{ote:ote?{top:ote.top,bottom:ote.bottom,overlap:oteOverlap}:null,orderBlock:orderBlock?{top:orderBlock.top,bottom:orderBlock.bottom,overlap:orderBlockOverlap,status:orderBlock.status}:null,premiumDiscount},metrics:{sweepQuality:round(sweepQuality,3),impulseQuality:round(impulseQuality,3),sizeQuality:round(sizeQuality,3),freshness:round(freshness,3),structureQuality:round(structureQuality,3),oteOverlap,orderBlockOverlap,premiumDiscount,ageBars:fvgAgeBars},
      confirmations:{sweep:true,displacement:!!impulse,structure:!!structure,freshFvg:lifecycle==="fresh",priceInsideFvg:inZone},
      reasons,source:"closed-candle-smc-correlation"
    });
  }
  setups.sort((a,b)=>b.score-a.score||b.sweep.ts-a.sweep.ts);
  const activeFvgs=gaps.map(g=>({...g,lifecycle:classifyLifecycle(g)})).filter(g=>g.lifecycle!=="invalidated");
  const latest=rows.at(-1)[0];
  return {status:"ready",generatedAt:new Date(now).toISOString(),asOf:new Date(latest).toISOString(),clusters,setups:setups.slice(0,30),activeFvgs,
    summary:{sweepCount:sweeps.length,correlatedSetupCount:setups.length,highQualityCount:setups.filter(s=>s.score>=75).length,
      bestSetup:setups[0]?.id??null,methodology:"Rule-based sweep-to-displacement-to-FVG correlation. Scores are confluence rankings, not probabilities or trade instructions."}};
}

export function scoreFvgLiquidityForConfluence(analysis, direction){
  if(analysis?.status!=="ready"||!analysis.setups?.length)return {available:false,value:0,weight:0};
  const sign=dirSign(direction), ranked=analysis.setups.slice(0,5);
  const value=ranked.reduce((sum,s)=>sum+(s.direction==="bullish"?1:-1)*s.score/100,0)/ranked.length;
  return {available:true,value:round(clamp(value,-1,1),3),weight:.12,
    evidence:ranked.map(s=>({id:s.id,direction:s.direction,score:s.score,state:s.state}))};
}
