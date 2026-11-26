export const STRATEGY_VALIDATION_POLICY=Object.freeze({version:'2.0.0',backtest:{minimumTrades:100,minimumProfitFactor:1.2,minimumExpectancyR:.05,maximumDrawdownPct:10},heldOut:{minimumTrades:30,minimumProfitFactor:1.0,minimumExpectancyR:0},monteCarlo:{maximumP95DrawdownPct:15,maximumRuinProbabilityPct:0},forward:{minimumTrades:30,minimumObservationDays:14,minimumProfitFactor:1.1,maximumDrawdownPct:5,maximumRiskBreaches:0,minimumDecayRatio:.5},freshnessHours:24});
const n=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const check=(id,ok,actual,target,detail)=>({id,passed:Boolean(ok),actual,target,detail});
export function evaluateStrategyEvidence(e={},policy=STRATEGY_VALIDATION_POLICY){const b=e.backtest||{},h=e.outOfSample||{},m=e.monteCarlo||{},f=e.forward||{},r=e.risk||{},fresh=n(e.evidenceAgeHours);
 const checks=[
 check('backtest_sample',n(b.closedTrades)>=policy.backtest.minimumTrades,n(b.closedTrades),policy.backtest.minimumTrades,'Minimum completed historical trades.'),
 check('backtest_profit_factor',n(b.profitFactor)>=policy.backtest.minimumProfitFactor,n(b.profitFactor),policy.backtest.minimumProfitFactor,'Net profit factor after fees, spread and slippage.'),
 check('backtest_expectancy',n(b.expectancyR)>policy.backtest.minimumExpectancyR,n(b.expectancyR),policy.backtest.minimumExpectancyR,'Positive expectancy after execution costs.'),
 check('backtest_drawdown',n(b.maxDrawdownPct)<=policy.backtest.maximumDrawdownPct,n(b.maxDrawdownPct),policy.backtest.maximumDrawdownPct,'Historical drawdown must remain inside policy.'),
 check('heldout_sample',n(h.closedTrades)>=policy.heldOut.minimumTrades,n(h.closedTrades),policy.heldOut.minimumTrades,'Untouched chronological holdout sample.'),
 check('heldout_profit_factor',n(h.profitFactor)>=policy.heldOut.minimumProfitFactor,n(h.profitFactor),policy.heldOut.minimumProfitFactor,'Held-out profit factor.'),
 check('heldout_expectancy',n(h.expectancyR)>policy.heldOut.minimumExpectancyR,n(h.expectancyR),policy.heldOut.minimumExpectancyR,'Held-out expectancy must remain positive.'),
 check('monte_carlo_drawdown',n(m.p95DrawdownPct)<=policy.monteCarlo.maximumP95DrawdownPct,n(m.p95DrawdownPct),policy.monteCarlo.maximumP95DrawdownPct,'95th percentile resampled drawdown.'),
 check('monte_carlo_ruin',n(m.ruinProbabilityPct)<=policy.monteCarlo.maximumRuinProbabilityPct,n(m.ruinProbabilityPct),policy.monteCarlo.maximumRuinProbabilityPct,'Probability of simulated equity ruin.'),
 check('risk_breaches',n(r.riskBreaches)===0,n(r.riskBreaches),0,'Any risk breach blocks qualification.'),
 check('drawdown_halt',r.drawdownHalt!==true,r.drawdownHalt===true, false,'A strategy halted for breaching the replay drawdown limit is suspended and cannot qualify.'),
 check('forward_sample',n(f.closedTrades)>=policy.forward.minimumTrades,n(f.closedTrades),policy.forward.minimumTrades,'Forward paper trade count.'),
 check('forward_duration',n(f.observationDays)>=policy.forward.minimumObservationDays,n(f.observationDays),policy.forward.minimumObservationDays,'Forward paper observation period.'),
 check('forward_profit_factor',n(f.profitFactor)>=policy.forward.minimumProfitFactor,n(f.profitFactor),policy.forward.minimumProfitFactor,'Forward paper profit factor.'),
 check('forward_drawdown',n(f.maxDrawdownPct)<=policy.forward.maximumDrawdownPct,n(f.maxDrawdownPct),policy.forward.maximumDrawdownPct,'Forward drawdown cap.'),
 check('forward_risk_breaches',n(f.riskBreaches)===policy.forward.maximumRiskBreaches,n(f.riskBreaches),policy.forward.maximumRiskBreaches,'Forward risk breaches.'),
 check('forward_decay',n(e.decayRatio)>=policy.forward.minimumDecayRatio&&e.decayDetected!==true,n(e.decayRatio),policy.forward.minimumDecayRatio,'Forward expectancy must retain at least half the backtest edge; decay blocks promotion.'),
 check('fresh_evidence',fresh!==null&&fresh>=0&&fresh<=policy.freshnessHours,fresh,policy.freshnessHours,'Backtest evidence must be fresh.')
 ];
 const failedChecks=checks.filter(x=>!x.passed).map(x=>x.id),passed=failedChecks.length===0,halted=r.drawdownHalt===true;
 return{policyVersion:policy.version,status:halted?'SUSPENDED':passed?'LIVE_READY':'RESEARCH_ONLY',passed,checks,failedChecks,decayDetected:e.decayDetected===true,decayRatio:n(e.decayRatio),liveExecutionAuthorized:false,humanApprovalRequired:true,permissions:{research:true,backtest:true,forwardPaper:true,liveReady:passed,liveExecution:false},evaluatedAt:new Date().toISOString()};
}
export async function loadPromotionEvidence(db,strategyId,now=Date.now()){try{const row=await db.prepare('SELECT verdict_json,created_at FROM jpti_strategy_validation_runs WHERE strategy_id=? ORDER BY created_at DESC LIMIT 1').bind(strategyId).first();if(!row)return{allowed:false,reason:'No server-computed strategy validation evidence.'};const age=(now-Date.parse(row.created_at))/3600000,verdict=JSON.parse(row.verdict_json||'{}');return{allowed:verdict.status==='LIVE_READY'&&verdict.passed===true&&verdict.liveExecutionAuthorized===false&&age>=0&&age<=STRATEGY_VALIDATION_POLICY.freshnessHours,reason:age>STRATEGY_VALIDATION_POLICY.freshnessHours?'Validation evidence is stale.':'Latest validation did not pass.',verdict,ageHours:age};}catch(error){return{allowed:false,reason:'Strategy validation storage unavailable; promotion blocked.',error:String(error?.message||error).slice(0,160)};}}
