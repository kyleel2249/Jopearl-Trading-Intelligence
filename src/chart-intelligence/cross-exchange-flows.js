// Cross-venue flow aggregation. Public exchange metrics are proxies, not proof of institutional identity.
const clamp=(v,a=-1,b=1)=>Math.max(a,Math.min(b,v));
const n=v=>Number.isFinite(Number(v))?Number(v):null;
export function aggregateCrossExchangeFlows(venues,{now=Date.now(),maxAgeMs=180000}={}){
  const accepted=[],rejected=[];
  for(const v of venues||[]){
    const ts=Date.parse(v?.timestamp||"")||Number(v?.timestamp)||0,age=ts?now-ts:Infinity;
    if(!v?.venue||age<0||age>maxAgeMs){rejected.push({venue:v?.venue||"unknown",reason:age<0?"future timestamp":"missing or stale"});continue;}
    const spotBuy=n(v.spotBuyUsd),spotSell=n(v.spotSellUsd),perpBuy=n(v.perpAggressiveBuyUsd),perpSell=n(v.perpAggressiveSellUsd);
    const oiDelta=n(v.openInterestDeltaUsd),funding=n(v.fundingRate),book=n(v.orderBookImbalance);
    const spotTotal=(spotBuy??0)+(spotSell??0),perpTotal=(perpBuy??0)+(perpSell??0);
    const spotPressure=spotTotal?(spotBuy-spotSell)/spotTotal:null,perpPressure=perpTotal?(perpBuy-perpSell)/perpTotal:null;
    const parts=[];if(spotPressure!=null)parts.push({v:spotPressure,w:.4});if(perpPressure!=null)parts.push({v:perpPressure,w:.3});
    if(oiDelta!=null)parts.push({v:Math.sign(oiDelta)*Math.min(1,Math.abs(oiDelta)/(Math.abs(oiDelta)+1_000_000)),w:.15});
    if(book!=null)parts.push({v:clamp(book),w:.1});if(funding!=null)parts.push({v:clamp(-funding*1000),w:.05});
    const weight=parts.reduce((s,x)=>s+x.w,0),score=weight?parts.reduce((s,x)=>s+x.v*x.w,0)/weight:0;
    if(!parts.length){rejected.push({venue:v.venue,reason:"no usable flow metrics"});continue;}
    accepted.push({venue:v.venue,marketType:v.marketType||"unknown",timestamp:new Date(ts).toISOString(),ageMs:age,score:Number(score.toFixed(4)),
      spotPressure,perpetualPressure:perpPressure,openInterestDeltaUsd:oiDelta,fundingRate:funding,orderBookImbalance:book,
      metrics:parts.length,sourceQuality:v.sourceQuality||"public-market-proxy"});
  }
  const venueScore=accepted.length?accepted.reduce((s,x)=>s+x.score,0)/accepted.length:0;
  const dispersion=accepted.length>1?Math.sqrt(accepted.reduce((s,x)=>s+(x.score-venueScore)**2,0)/accepted.length):0;
  const confidence=Math.min(1,accepted.length/4)*Math.max(0,1-dispersion*.8)*Math.min(1,accepted.reduce((s,x)=>s+x.metrics,0)/12);
  return{status:accepted.length?"ready":"unavailable",score:Number(venueScore.toFixed(4)),confidence:Number(confidence.toFixed(3)),
    venueCount:accepted.length,venues:accepted,dispersion:Number(dispersion.toFixed(4)),rejected,
    bias:venueScore>.12?"buy-pressure":venueScore<-.12?"sell-pressure":"balanced",
    caveat:"Cross-venue public flow is an institutional-activity proxy. It cannot identify institutional traders without verified participant attribution."};
}
