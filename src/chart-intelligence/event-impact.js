// Event-impact prediction is direction-neutral unless a numeric surprise is supplied against a consensus.
const clamp=(v,a=0,b=100)=>Math.max(a,Math.min(b,v));
const importanceWeight={low:.25,medium:.55,high:.8,critical:1};
export function predictEventImpact({events=[],now=Date.now(),horizonMinutes=240,history=[]}={}){
  const horizonMs=Math.max(1,horizonMinutes)*60_000;
  const relevant=(events||[]).filter(e=>e&&Number.isFinite(Date.parse(e.time||e.scheduledAt||e.publishedAt)))
    .map(e=>{const ts=Date.parse(e.time||e.scheduledAt||e.publishedAt),delta=ts-now,importance=String(e.importance||e.impact||"medium").toLowerCase();
      const providerScore=Number(e.providerImpactScore),base=Number.isFinite(providerScore)?Math.max(importanceWeight[importance]??.45,clamp(providerScore)/100):(importanceWeight[importance]??.45),proximity=delta<0?Math.max(0,1-Math.abs(delta)/horizonMs):Math.max(0,1-delta/horizonMs);
      const surprise=e.actual!=null&&e.forecast!=null&&Number.isFinite(Number(e.actual))&&Number.isFinite(Number(e.forecast))?Number(e.actual)-Number(e.forecast):null;
      const surpriseMagnitude=surprise==null?0:Math.min(1,Math.abs(surprise)/(Math.abs(Number(e.forecast)||1)*.1+1));
      const score=clamp(100*base*(.35+.65*proximity)*(1+.2*surpriseMagnitude));
      return{id:e.id||[e.source||"event",ts,e.title||e.name||"event"].join("|"),title:e.title||e.name||"Unnamed event",category:e.category||"macro",
        importance,scheduledAt:new Date(ts).toISOString(),minutesFromNow:Math.round(delta/60_000),impactScore:Math.round(score),
        surprise,actual:e.actual??null,forecast:e.forecast??null,source:e.source||"unspecified",sourceUrl:e.url||e.sourceUrl||null,country:e.country||null,currency:e.currency||null,assets:Array.isArray(e.assets)?e.assets:[],reference:e.reference||null,ticker:e.ticker||null,symbol:e.symbol||null,datePrecision:e.datePrecision||"source-reported",unlockValueUsd:e.unlockValueUsd??null,valueToMarketCapPct:e.valueToMarketCapPct??null,displayedDate:e.displayedDate??null,
        direction:"neutral",directionReason:surprise==null?"No actual-versus-consensus surprise; direction is intentionally neutral.":"Surprise direction is event-specific and requires an explicit signed mapping."};})
    .filter(e=>e.minutesFromNow<=horizonMinutes&&e.minutesFromNow>=-horizonMinutes).sort((a,b)=>b.impactScore-a.impactScore);
  const max=relevant[0]?.impactScore||0,active=relevant.filter(e=>e.impactScore>=45);
  const realized=(history||[]).filter(x=>Number.isFinite(Number(x.rangeMultiple))).slice(-100);
  const baseline=realized.length?realized.reduce((s,x)=>s+Number(x.rangeMultiple),0)/realized.length:null;
  const risk= max>=80?"critical":max>=60?"high":max>=35?"moderate":"low";
  return{status:"ready",generatedAt:new Date(now).toISOString(),horizonMinutes,impactScore:max,risk,active:active.length>0,
    events:relevant.slice(0,30),expectedVolatility:baseline==null?"uncalibrated baseline":baseline*(1+max/100),
    baselineSamples:realized.length,methodology:"Heuristic event proximity and importance ranking. Not a trained probability model; no bullish/bearish direction is inferred from headlines."};
}
