const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,v));
const finite=v=>Number.isFinite(Number(v));
const round=(v,d=3)=>Number.isFinite(v)?Number(v.toFixed(d)):null;

export function scoreOpportunity(snapshot,context=null){
  const scores=snapshot?.scores||{},domains=snapshot?.domains||{},evidence=snapshot?.evidence||[];
  if(snapshot?.status!=='ready')return {status:'INSUFFICIENT_DATA',score:null,direction:'neutral',reasons:['Insufficient validated candle history.'],riskFlags:['DATA_GAP']};
  const mis=finite(scores.MIS)?Number(scores.MIS):50;
  const direction=scores.directionalBias==='bullish'?'LONG':scores.directionalBias==='bearish'?'SHORT':'NEUTRAL';
  const directional=Math.abs(mis-50)*2;
  const trend=domains.structure?.bias;
  const momentum=evidence.find(x=>x.domain==='Momentum')?.score;
  const flow=evidence.find(x=>x.domain==='Flow proxy')?.score;
  const aligned=direction==='LONG'?[trend==='bullish',finite(momentum)&&momentum>=55,finite(flow)&&flow>=55]
    :direction==='SHORT'?[trend==='bearish',finite(momentum)&&momentum<=45,finite(flow)&&flow<=45]:[];
  const confluence=aligned.length?aligned.filter(Boolean).length/aligned.length*100:0;
  const participation=finite(domains.flow?.relativeVolume)?clamp((Number(domains.flow.relativeVolume)-0.5)*50):35;
  const regime=domains.regime?.label||'unknown';
  const regimePenalty=/high-volatility/i.test(regime)?18:/compression/i.test(regime)?4:0;
  const conflicts=(snapshot.conflicts||[]).length;
  const conflictPenalty=Math.min(24,conflicts*8);
  const contextAvailable=!!context&&typeof context==='object';
  const depth=Number(context?.liquidity?.visibleDepth?.imbalancePct??context?.orderBookAnalysis?.imbalancePct);
  const depthAgreement=Number.isFinite(depth)&&direction!=='NEUTRAL'?(direction==='LONG'?(depth>0?8:-8):(depth<0?8:-8)):0;
  const score=clamp(directional*.45+confluence*.30+participation*.15+scores.confidence*.10+depthAgreement-regimePenalty-conflictPenalty);
  const riskFlags=[];
  if(/high-volatility/i.test(regime))riskFlags.push('HIGH_VOLATILITY');
  if(conflicts)riskFlags.push('EVIDENCE_CONFLICT');
  if(!contextAvailable)riskFlags.push('NO_LIVE_CONTEXT');
  if(!finite(domains.flow?.relativeVolume))riskFlags.push('PARTICIPATION_UNAVAILABLE');
  const reasons=[direction==='NEUTRAL'?'Directional evidence is mixed.':direction+' bias from the fused technical evidence.',aligned.filter(Boolean).length+' of '+aligned.length+' trend/momentum/flow checks aligned.',regime+' regime.',conflicts+' evidence conflict(s).'];
  return {status:score>=70&&direction!=='NEUTRAL'?'HIGH_PRIORITY':score>=52&&direction!=='NEUTRAL'?'WATCH':'LOW_PRIORITY',score:round(score,1),direction,confluencePercent:round(confluence,1),participationScore:round(participation,1),regime,riskFlags,reasons,confidenceType:'heuristic ranking score; not a probability',contextAvailable};
}

export function correlationFromCandles(left=[],right=[]){
  const returns=rows=>{const map=new Map();for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];const ta=Number(a?.[0]),tb=Number(b?.[0]),pa=Number(a?.[4]),pb=Number(b?.[4]);if(ta>0&&tb>ta&&pa>0&&pb>0)map.set(tb,Math.log(pb/pa));}return map;};
  const a=returns(left),b=returns(right),keys=[...a.keys()].filter(k=>b.has(k)).sort((x,y)=>x-y);
  if(keys.length<20)return {correlation:null,observations:keys.length,status:'INSUFFICIENT_OVERLAP'};
  const x=keys.map(k=>a.get(k)),y=keys.map(k=>b.get(k)),mx=x.reduce((s,v)=>s+v,0)/x.length,my=y.reduce((s,v)=>s+v,0)/y.length;
  const cov=x.reduce((s,v,i)=>s+(v-mx)*(y[i]-my),0),sx=Math.sqrt(x.reduce((s,v)=>s+(v-mx)**2,0)),sy=Math.sqrt(y.reduce((s,v)=>s+(v-my)**2,0));
  return {correlation:sx&&sy?round(cov/(sx*sy),3):null,observations:keys.length,status:sx&&sy?'READY':'ZERO_VARIANCE'};
}

export function buildOpportunityRadar(markets=[]){
  const ranked=markets.map(m=>({...m,ranking:scoreOpportunity(m.snapshot,m.context)}))
    .sort((a,b)=>(b.ranking.score??-1)-(a.ranking.score??-1));
  const correlations=[];
  for(let i=0;i<ranked.length;i++)for(let j=i+1;j<ranked.length;j++){
    const result=correlationFromCandles(ranked[i].candles,ranked[j].candles);
    correlations.push({left:ranked[i].symbol,right:ranked[j].symbol,...result});
  }
  const ready=ranked.filter(m=>m.ranking.score!==null);
  return {generatedAt:new Date().toISOString(),markets:ranked,correlations,summary:{scanned:markets.length,scored:ready.length,highPriority:ranked.filter(m=>m.ranking.status==='HIGH_PRIORITY').length,watch:ranked.filter(m=>m.ranking.status==='WATCH').length,insufficient:ranked.filter(m=>m.ranking.status==='INSUFFICIENT_DATA').length},methodology:'Heuristic ranking combines directional distance from neutral, trend/momentum/flow alignment, relative-volume participation, reported confidence, volatility regime, evidence conflicts and available visible-depth alignment. It is a sorting aid, not a calibrated probability or order instruction.',limitations:['Cross-market correlation uses aligned candle close-to-close log returns and requires at least 20 shared timestamps.','Order-book depth is a single snapshot and may change or disappear; it cannot prove spoofing or intent.','No missing data is silently replaced with a positive score.','No live order is created or authorized.']};
}
