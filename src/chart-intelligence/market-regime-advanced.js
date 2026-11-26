// MR-3.0 regime dynamics: transition forecasting and statistical change/volatility diagnostics.
// All calculations use supplied closed candles only; outputs are diagnostics, not trade signals.
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const finite=x=>Number.isFinite(x);
const round=x=>finite(x)?Number(x.toFixed(4)):null;
const STATES=['trending-up','trending-down','ranging','volatile','compressed','transitional'];

function transitionForecast(history,currentState){
  const counts=Object.fromEntries(STATES.map(s=>[s,Object.fromEntries(STATES.map(t=>[t,1]))]));
  for(let i=1;i<history.length;i++){
    const from=history[i-1],to=history[i];
    if(counts[from]&&counts[from][to]!=null)counts[from][to]++;
  }
  const row=counts[currentState]||Object.fromEntries(STATES.map(s=>[s,1]));
  const total=Object.values(row).reduce((a,b)=>a+b,0);
  const probabilities=Object.fromEntries(STATES.map(s=>[s,round(row[s]/total)]));
  const ranked=Object.entries(probabilities).sort((a,b)=>b[1]-a[1]);
  const observed=history.slice(1).filter((s,i)=>history[i]===currentState).length;
  return {status:history.length>=12?'ready':'warming-up',horizon:'next classified observation',probabilities,mostLikelyNext:ranked[0][0],mostLikelyProbability:ranked[0][1],observations:Math.max(0,history.length-1),currentStateTransitions:observed,method:'Laplace-smoothed empirical Markov transition counts',warning:'Exploratory state-transition frequencies; not calibrated forecasts.'};
}

function detectChangePoint(returns){
  if(returns.length<30)return{status:'insufficient',detected:false,score:0,baselineSamples:0,recentSamples:0};
  const base=returns.slice(-50,-10),recent=returns.slice(-10),mu=mean(base),sd=Math.sqrt(mean(base.map(x=>(x-mu)**2)))||1e-12;
  const meanShift=Math.abs(mean(recent)-mu)/sd;
  const varianceBase=mean(base.map(x=>(x-mu)**2)),varianceRecent=mean(recent.map(x=>(x-mean(recent))**2));
  const varianceShift=Math.abs(Math.log((varianceRecent+1e-16)/(varianceBase+1e-16)));
  // Two-sided Page-style cumulative deviation, bounded to avoid explosive values.
  let up=0,down=0,cusum=0;
  for(const x of recent){const z=(x-mu)/sd;up=Math.max(0,up+z-.5);down=Math.max(0,down-z-.5);cusum=Math.max(cusum,up,down);}
  const score=clamp((meanShift/4)*.35+(varianceShift/3)*.3+(cusum/8)*.35,0,1);
  return{status:'ready',detected:score>=.62,score:round(score),meanShiftSigma:round(meanShift),varianceShift:round(varianceShift),cusum:round(cusum),baselineSamples:base.length,recentSamples:recent.length,method:'rolling standardised two-sided CUSUM plus mean/variance shift'};
}

function hurstEstimate(returns){
  if(returns.length<40)return{status:'insufficient',exponent:null,interpretation:'insufficient history'};
  const lags=[2,4,8,16].filter(l=>l<returns.length/2),xs=[],ys=[];
  for(const lag of lags){const blocks=[];for(let i=0;i+lag<=returns.length;i+=lag)blocks.push(returns.slice(i,i+lag).reduce((a,b)=>a+b,0));const m=mean(blocks),v=Math.sqrt(mean(blocks.map(x=>(x-m)**2)));if(v>0){xs.push(Math.log(lag));ys.push(Math.log(v));}}
  if(xs.length<3)return{status:'insufficient',exponent:null,interpretation:'insufficient scale coverage'};
  const mx=mean(xs),my=mean(ys);let num=0,den=0;for(let i=0;i<xs.length;i++){num+=(xs[i]-mx)*(ys[i]-my);den+=(xs[i]-mx)**2;}
  const h=clamp(den?num/den:.5,.05,.95);
  return{status:'estimated',exponent:round(h),interpretation:h>.58?'persistent / trend-prone':h<.42?'anti-persistent / mean-reverting':'near-random / mixed',scales:lags,method:'variance-time scaling approximation',warning:'A short-window Hurst estimate is noisy and must not be treated as a standalone strategy trigger.'};
}

function volatilityClustering(returns){
  if(returns.length<25)return{status:'insufficient',lag1SquaredReturnCorrelation:null,ewmaVolatility:null,clustered:false};
  const sq=returns.map(x=>x*x),a=sq.slice(0,-1),b=sq.slice(1),ma=mean(a),mb=mean(b);
  let cov=0,va=0,vb=0;for(let i=0;i<a.length;i++){cov+=(a[i]-ma)*(b[i]-mb);va+=(a[i]-ma)**2;vb+=(b[i]-mb)**2;}
  const corr=va&&vb?cov/Math.sqrt(va*vb):0;
  let variance=sq[0];for(let i=1;i<sq.length;i++)variance=.94*variance+.06*sq[i];
  const recent=mean(sq.slice(-10)),long=mean(sq.slice(-50));
  return{status:'ready',lag1SquaredReturnCorrelation:round(clamp(corr,-1,1)),ewmaVolatility:round(Math.sqrt(Math.max(0,variance))),recentToBaselineVariance:round(recent/(long||1e-16)),clustered:corr>.2||recent>(long||0)*1.8,method:'EWMA lambda 0.94 and lag-1 squared-return autocorrelation'};
}

export function analyzeRegimeDynamics({closes=[],regimeHistory=[],currentState='transitional'}={}){
  const safe=(Array.isArray(closes)?closes:[]).filter(x=>finite(x)&&x>0);
  const returns=safe.slice(1).map((x,i)=>Math.log(x/safe[i])).filter(finite);
  const changePoint=detectChangePoint(returns),hurst=hurstEstimate(returns),volatility=volatilityClustering(returns);
  const transition=transitionForecast(Array.isArray(regimeHistory)?regimeHistory:[],currentState);
  const stableRun=(()=>{let n=0;for(let i=regimeHistory.length-1;i>=0&&regimeHistory[i]===currentState;i--)n++;return n;})();
  const warnings=[];
  if(changePoint.detected)warnings.push('Statistical change-point candidate: recent return distribution differs from its baseline.');
  if(volatility.clustered)warnings.push('Volatility clustering detected: recent shocks may be followed by elevated volatility.');
  if(hurst.status==='estimated'&&hurst.exponent>.65)warnings.push('Persistent return structure estimate; trend continuation risk is elevated.');
  if(hurst.status==='estimated'&&hurst.exponent<.35)warnings.push('Anti-persistent return structure estimate; reversal/mean-reversion risk is elevated.');
  return{model:'JPTI-MR-3.0-DYNAMICS',transitionForecast:transition,changePoint,hurst,volatilityClustering:volatility,stability:{currentRunObservations:stableRun,historyObservations:regimeHistory.length,stable:stableRun>=4&&!changePoint.detected,score:round(clamp(stableRun/8,0,1)*(1-changePoint.score*.5))},warnings,guardrails:{usesClosedCandles:true,lookAhead:false,probabilitiesCalibrated:false,tradeSignalAuthority:'GainzAlpha'}};
}
