const clamp=(v,min=0,max=100)=>Math.max(min,Math.min(max,v));
const numeric=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const directionOf=v=>v>0?'LONG':v<0?'SHORT':'NEUTRAL';
const vote=(agent,direction,weight,reason,available=true)=>({agent,direction,weight,reason,available});
export function runAgentDebate(snapshot,context=null,ranking=null){
 if(snapshot?.status!=='ready')return{status:'INSUFFICIENT_DATA',consensus:'NO_CONSENSUS',votes:[],support:0,oppose:0,neutral:0,confidence:0,riskVetoes:['INSUFFICIENT_MARKET_DATA'],decision:'NO_EDGE',summary:'Debate withheld because validated candle evidence is unavailable.'};
 const domains=snapshot.domains||{},scores=snapshot.scores||{},evidence=snapshot.evidence||[];
 const find=label=>evidence.find(x=>x.domain===label)?.score;
 const trend=domains.structure?.bias;
 const trendVote=trend==='bullish'?'LONG':trend==='bearish'?'SHORT':'NEUTRAL';
 const momentum=numeric(find('Momentum'))?(find('Momentum')>=55?'LONG':find('Momentum')<=45?'SHORT':'NEUTRAL'):'NEUTRAL';
 const flow=numeric(find('Flow proxy'))?(find('Flow proxy')>=55?'LONG':find('Flow proxy')<=45?'SHORT':'NEUTRAL'):'NEUTRAL';
 const position=Number(domains.structure?.rangePositionPercent);
 const liquidity=domains.liquidity?.sweepLow?'LONG':domains.liquidity?.sweepHigh?'SHORT':numeric(position)?(position<=20?'LONG':position>=80?'SHORT':'NEUTRAL'):'NEUTRAL';
 const regime=String(domains.regime?.label||'unknown');
 const regimeVote=/high-volatility/i.test(regime)?'NEUTRAL':trendVote;
 const rawDepth=context?.liquidity?.visibleDepth?.imbalancePct??context?.orderBookAnalysis?.imbalancePct;
 const depth=numeric(rawDepth)?Number(rawDepth):null;
 const depthVote=depth===null?'NEUTRAL':depth>5?'LONG':depth< -5?'SHORT':'NEUTRAL';
 const votes=[
  vote('Atlas · Structure',trendVote,1.25,trend?('EMA structure bias: '+trend):'Structure unavailable',!!trend&&trend!=='neutral'),
  vote('Pulse · Momentum',momentum,1.15,numeric(find('Momentum'))?'Momentum evidence '+find('Momentum')+'/100':'Momentum unavailable',numeric(find('Momentum'))),
  vote('Oracle · Participation',flow,1.1,numeric(find('Flow proxy'))?'Candle-volume participation proxy '+find('Flow proxy')+'/100':'Participation unavailable',numeric(find('Flow proxy'))),
  vote('Hawk · Liquidity',liquidity,.9,domains.liquidity?.sweepLow?'Recent low sweep and reclaim':domains.liquidity?.sweepHigh?'Recent high sweep and rejection':numeric(position)?'Range position '+position+'%':'Liquidity unavailable',!!domains.liquidity?.sweepLow||!!domains.liquidity?.sweepHigh||numeric(position)),
  vote('Weaver · Regime',regimeVote,1,regime+' regime; high volatility suppresses directional vote',!!domains.regime?.label),
  vote('Fox · Visible depth',depthVote,.75,depth===null?'No confirmed order-book depth in context':'Visible depth imbalance '+depth+'%',depth!==null)
 ];
 const available=votes.filter(v=>v.available),long=available.filter(v=>v.direction==='LONG'),short=available.filter(v=>v.direction==='SHORT'),neutral=available.filter(v=>v.direction==='NEUTRAL');
 const weight=available.reduce((s,v)=>s+v.weight,0),longWeight=long.reduce((s,v)=>s+v.weight,0),shortWeight=short.reduce((s,v)=>s+v.weight,0);
 const net=weight?(longWeight-shortWeight)/weight:0,consensus=Math.abs(net)>=.35?directionOf(net):'NO_CONSENSUS';
 const majority=Math.max(longWeight,shortWeight)/(weight||1);
 const riskVetoes=[];
 if(/high-volatility/i.test(regime))riskVetoes.push('HIGH_VOLATILITY_REGIME');
 if(!numeric(domains.flow?.relativeVolume))riskVetoes.push('PARTICIPATION_UNVERIFIED');
 if((snapshot.conflicts||[]).length>=2)riskVetoes.push('MULTIPLE_EVIDENCE_CONFLICTS');
 if(available.length<3)riskVetoes.push('INSUFFICIENT_INDEPENDENT_VOTES');
 if(consensus==='NO_CONSENSUS')riskVetoes.push('AGENT_DISAGREEMENT');
 if(context?.dataQuality?.stale===true)riskVetoes.push('STALE_MARKET_CONTEXT');
 const aligned=consensus==='LONG'?long:consensus==='SHORT'?short:[];
 const confidence=weight?Math.round(100*(aligned.reduce((s,v)=>s+v.weight,0)/weight)*Math.min(1,available.length/5)):0;
 const directionMatches=consensus==='LONG'?scores.directionalBias==='bullish':consensus==='SHORT'?scores.directionalBias==='bearish':false;
 const decision=consensus==='NO_CONSENSUS'?'NO_EDGE':riskVetoes.length?'WATCH_ONLY':directionMatches&&confidence>=65?'PAPER_REVIEW_CANDIDATE':'WATCH_ONLY';
 const dissent=consensus==='LONG'?short:consensus==='SHORT'?long:[...long,...short];
 const summary=consensus==='NO_CONSENSUS'?'Specialists do not have sufficient weighted agreement.':consensus+' weighted consensus; '+aligned.length+' supporting specialist(s), '+dissent.length+' dissenting specialist(s), '+neutral.length+' neutral specialist(s).';
 return{status:'COMPLETE',consensus,votes,support:aligned.length,oppose:dissent.length,neutral:neutral.length,available:available.length,confidence,netAgreement:Math.round(net*100),riskVetoes,decision,summary,methodology:'Deterministic role-based debate over shared OHLCV-derived evidence and optional visible-depth context. Specialists are explainable rule modules, not independent AI models or independent data sources.'};
}
export function auditDecision(snapshot,context=null){
 const debate=runAgentDebate(snapshot,context);
 return{debate,integrity:{closedCandleEvidence:snapshot?.status==='ready',missingDomains:snapshot?.dataQuality?.missingDomains||[],conflictCount:(snapshot?.conflicts||[]).length,source:snapshot?.dataQuality?.source||'unknown',freshness:snapshot?.dataQuality?.freshness||'unknown'},warnings:[...(snapshot?.dataQuality?.notes||[]),...debate.riskVetoes.map(x=>x.replaceAll('_',' ').toLowerCase())]};
}
