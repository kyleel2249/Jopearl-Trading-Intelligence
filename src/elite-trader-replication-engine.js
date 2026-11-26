// JPTI Elite Trader Replication Division (ETRD).
// Deterministic, evidence-gated trader assessment. It never places exchange orders.
const finite = (v) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const pct = (v) => finite(v);
export const ETRD_AGENTS = Object.freeze([
  ['ETR-01','Elite Hunter','candidate discovery and source-quality checks'],
  ['ETR-02','Performance Auditor','cross-checks reported performance and history'],
  ['ETR-03','Win-Rate Analyst','sample size and win-rate stability'],
  ['ETR-04','Profitability Analyst','net return, fees and copier PnL'],
  ['ETR-05','Drawdown Analyst','peak-to-trough loss and recovery profile'],
  ['ETR-06','Risk-Adjusted Ranker','Sharpe, Sortino and Calmar assessment'],
  ['ETR-07','Scalping Replica','scalping behaviour classification'],
  ['ETR-08','Day-Trading Replica','intraday behaviour classification'],
  ['ETR-09','Swing Replica','multi-session behaviour classification'],
  ['ETR-10','Futures Replica','leverage and derivatives exposure assessment'],
  ['ETR-11','Position Manager','holding time, scaling and exit behaviour'],
  ['ETR-12','Entry Precision','entry quality and adverse excursion'],
  ['ETR-13','Consistency Monitor','rolling-window stability and drift'],
  ['ETR-14','Elite Consensus','independent score and replica agreement'],
  ['ETR-15','Elite Risk Supervisor','final eligibility veto and capital protection']
].map(([id,name,mandate])=>({id,name,mandate,executionPermission:'none'})));
export const ETRD_POLICY = Object.freeze({
  version:'1.0.0', scoreWeights:{winRateConsistency:20,riskAdjustedReturns:20,maxDrawdown:15,netProfitability:15,periodConsistency:10,copierProfitability:10,historyAndSample:10},
  minimumTrades:100, minimumHistoryDays:90, minimumCopierPnl:0, maximumDrawdownPct:25,
  minimumScore:80, maxCandidates:100, coreSelections:10, requiredWindows:['7d','30d','90d','180d'],
  executionMode:'paper-only', liveExecutionAuthorized:false
});
function metric(candidate,key,window='90d') {
  const windows=candidate.windows||{};
  return finite(windows[window]?.[key] ?? candidate[key]);
}
function scoreWindowStability(c) {
  const values=['7d','30d','90d','180d'].map(w=>metric(c,'roiPct',w)).filter(v=>v!==null);
  if(values.length<3)return {score:0,coverage:values.length};
  const mean=values.reduce((a,b)=>a+b,0)/values.length;
  const variance=values.reduce((a,b)=>a+(b-mean)**2,0)/values.length;
  const cv=Math.sqrt(variance)/(Math.abs(mean)+1);
  const positiveConsistency=values.filter(v=>v>0).length/values.length;
  return {score:clamp(.7*positiveConsistency+.3*(1-cv),0,1),coverage:values.length};
}
function classifyStyle(c) {
  const days=finite(c.averageHoldingHours);
  if(days===null)return 'unclassified';
  if(days<1)return 'scalping';
  if(days<=24)return 'day-trading';
  return 'swing';
}
export function assessEliteTrader(raw={}, now=Date.now()) {
  const c={...raw};
  const errors=[];
  const id=String(c.traderId||c.id||'').trim().slice(0,120);
  const source=String(c.source||'').trim().slice(0,120);
  const retrievedAt=Date.parse(c.retrievedAt||'');
  if(!id)errors.push('missing_trader_id');
  if(!source)errors.push('missing_source');
  if(!Number.isFinite(retrievedAt)||now-retrievedAt>6*60*60*1000||retrievedAt>now+60000)errors.push('stale_or_missing_source_timestamp');
  const trades=finite(c.totalTrades),history=finite(c.historyDays),winRate=metric(c,'winRatePct'),drawdown=metric(c,'maxDrawdownPct');
  const roi=metric(c,'roiPct'),copierPnl=metric(c,'copierPnlUsd'),sharpe=metric(c,'sharpe'),sortino=metric(c,'sortino'),calmar=metric(c,'calmar');
  const missing=[];
  for(const [k,v] of Object.entries({totalTrades:trades,historyDays:history,winRatePct:winRate,maxDrawdownPct:drawdown,roiPct:roi,copierPnlUsd:copierPnl}))if(v===null)missing.push(k);
  const stability=scoreWindowStability(c);
  const components={
    winRateConsistency:winRate===null?0:clamp((winRate-35)/30,0,1)*.65+stability.score*.35,
    riskAdjustedReturns:[sharpe,sortino,calmar].some(v=>v!==null)?clamp(((sharpe??0)*.45+(sortino??0)*.35+(calmar??0)*.2)/3,0,1):0,
    maxDrawdown:drawdown===null?0:clamp(1-drawdown/40,0,1),
    netProfitability:roi===null?0:clamp((roi+5)/30,0,1),
    periodConsistency:stability.score,
    copierProfitability:copierPnl===null?0:copierPnl>0?clamp(.5+Math.log10(1+copierPnl)/4,.5,1):0,
    historyAndSample:trades===null||history===null?0:clamp(Math.min(trades/300,history/180),0,1)
  };
  const weights=ETRD_POLICY.scoreWeights;
  const score=Number(Object.entries(weights).reduce((s,[k,w])=>s+components[k]*w,0).toFixed(2));
  const gates=[
    [trades!==null&&trades>=ETRD_POLICY.minimumTrades,'insufficient_trade_sample'],
    [history!==null&&history>=ETRD_POLICY.minimumHistoryDays,'insufficient_history'],
    [drawdown!==null&&drawdown<=ETRD_POLICY.maximumDrawdownPct,'drawdown_limit_exceeded'],
    [copierPnl!==null&&copierPnl>ETRD_POLICY.minimumCopierPnl,'copier_profitability_not_positive'],
    [roi!==null&&roi>0,'non_positive_roi'],
    [stability.coverage>=3,'insufficient_window_coverage'],
    [missing.length===0,'missing_required_metrics'],
    [c.sourceAttested===true,'source_not_attested_by_operator'],\n    [errors.length===0,'source_integrity_failed']
  ];
  const failed=gates.filter(([ok])=>!ok).map(([,reason])=>reason);
  const eligible=failed.length===0&&score>=ETRD_POLICY.minimumScore;
  return {
    traderId:id||null,displayName:String(c.displayName||c.nickname||id||'Unidentified trader').slice(0,120),
    source:source||null,sourceUrl:c.sourceUrl?String(c.sourceUrl).slice(0,500):null,
    retrievedAt:Number.isFinite(retrievedAt)?new Date(retrievedAt).toISOString():null,
    score,grade:score>=95?'exceptional':score>=90?'elite':score>=85?'advanced':score>=80?'qualified':'not-qualified',
    eligible,status:eligible?'eligible':'rejected_or_unverified',failedGates:failed,missingMetrics:missing,
    components:Object.fromEntries(Object.entries(components).map(([k,v])=>[k,Number(v.toFixed(4))])),
    metrics:{totalTrades:trades,historyDays:history,winRatePct:winRate,maxDrawdownPct:drawdown,roiPct:roi,copierPnlUsd:copierPnl,sharpe,sortino,calmar,averageHoldingHours:finite(c.averageHoldingHours)},
    windowCoverage:stability.coverage,style:classifyStyle(c),
    windows:c.windows&&typeof c.windows==='object'?c.windows:{},
    riskFlags:[...(drawdown!==null&&drawdown>15?['elevated_drawdown']:[]),...(winRate!==null&&winRate>90&&trades!==null&&trades<300?['win_rate_sample_warning']:[]),...(finite(c.maxLeverage)>10?['high_leverage']:[]),...(c.recoveryTrading===true?['possible_recovery_trading']:[]),...(c.concentratedExposure===true?['concentrated_exposure']:[])],
    provenance:{verified:false,sourceSupplied:true,independentlyReconciled:false,warning:'Metrics are provider-reported until independently reconciled against authoritative Bitget records.'}
  };
}
export function rankEliteTraders(candidates=[],now=Date.now()) {
  const assessments=(Array.isArray(candidates)?candidates:[]).slice(0,ETRD_POLICY.maxCandidates).map(c=>assessEliteTrader(c,now));
  const eligible=assessments.filter(c=>c.eligible).sort((a,b)=>b.score-a.score||((b.metrics.copierPnlUsd||0)-(a.metrics.copierPnlUsd||0)));
  const selected=eligible.slice(0,ETRD_POLICY.coreSelections).map((c,i)=>({...c,rank:i+1,replicaTeam:{style:c.style,replicaMode:'paper',allocationPct:0,liveExecutionAuthorized:false}}));
  return {id:crypto.randomUUID(),generatedAt:new Date(now).toISOString(),policy:ETRD_POLICY,agentRoster:ETRD_AGENTS,
    candidateCount:assessments.length,eligibleCount:eligible.length,selectedCount:selected.length,
    selected,assessments:assessments.sort((a,b)=>b.score-a.score),
    execution:{mode:'paper-only',continuousMonitoringConfigured:false,liveExecutionAuthorized:false,ordersCreated:0,
      blockers:['No verified live Bitget trader feed is configured.','No live execution authorization or exchange trading adapter is active.','A Cloudflare scheduled trigger and alert delivery must be configured for unattended monitoring.']},
    audit:{scoreIsRankingHeuristic:true,profitabilityGuaranteed:false,metricsIndependentlyVerified:false}
  };
}
