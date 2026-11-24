// Deterministic paper-trading research engine. No exchange order API is imported or exposed.
export const PAPER_POLICY=Object.freeze({
 mode:'PAPER_ONLY',initialEquityUsd:1,riskPerTradePct:0.25,maxDailyLossPct:2,maxDrawdownPct:5,
 maxOpenPositions:1,maxConcurrentPerAgent:1,maxFleetOpenPositions:10,maxOpenPerSymbol:2,maxSameDirectionOpenPositions:6,maxLeverage:1,feeRate:0.0006,slippageBps:5,spreadBps:3,
 targetWinRatePct:98,minimumClosedTrades:200,minimumObservationDays:90,minimumProfitFactor:1.5,
 minimumExpectancyR:0.15,minimumSharpe:0.8,minimumRegimeTrades:30,minimumOutOfSampleTrades:50,
 maximumConsecutiveLosses:5,maximumRiskBreaches:0,minimumNetProfitUsd:0.01
});
export const AGENT_RESOURCES=Object.freeze([
 'Bitget public spot and USDT-perpetual market feeds','Closed-candle history and 1m/5m/15m/1h signal context',
 'Fee, spread, slippage and latency simulator','Ten strategy archetypes with independent performance ledgers',
 'Market regime, volatility and session classifiers','Fleet exposure, direction concentration and capital-survival monitor',
 'Trade attribution, fee/slippage analysis and daily review','Walk-forward and untouched forward-validation window'
]);
const definitions=[
 ['atlas-trend','Atlas','Trend Structure Analyst','Finds multi-timeframe directional alignment; owns trend continuation and invalidation rules.','trend'],
 ['pulse-momentum','Pulse','Momentum Analyst','Measures momentum acceleration, exhaustion and reversal risk.','momentum'],
 ['revert-scout','Revert','Mean-Reversion Specialist','Finds statistically stretched range conditions and rejects runaway trends.','mean-reversion'],
 ['breakout-sentinel','Sentinel','Breakout Specialist','Detects closed-candle range breaks and confirms volume participation.','breakout'],
 ['volume-oracle','Oracle','Volume & Participation Analyst','Checks relative volume, participation quality and failed breakouts.','volume'],
 ['session-hawk','Hawk','Session & Liquidity Analyst','Ranks session windows and avoids thin or unstable liquidity periods.','session'],
 ['capital-warden','Warden','Capital Protection Officer','Vetoes entries under drawdown, spread, volatility or exposure stress.','risk'],
 ['microstructure-fox','Fox','Microstructure Analyst','Evaluates executable spread and quote quality before simulated entry.','microstructure'],
 ['regime-weaver','Weaver','Market Regime Analyst','Classifies trend, range and high-volatility conditions; adapts setup selection.','regime'],
 ['council-prime','Prime','Multi-Agent Strategy Chair','Requires agreement across independent signals and records dissent.','ensemble']
];
export const PAPER_AGENTS=Object.freeze(definitions.map(([id,name,role,responsibility,strategyId])=>({
 id,name,role,responsibility,strategyId,edge:responsibility,tier:'RESEARCH',generation:1,
 resources:[...AGENT_RESOURCES],permissions:{paper:true,live:false}
})));
const n=v=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const mean=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
export function derivePaperSignal(candles,ticker={},agentId='ensemble',context={}){
 const rows=(Array.isArray(candles)?candles:[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(v=>Number.isFinite(Number(v)))).map(r=>r.map(Number)).sort((a,b)=>a[0]-b[0]);
 if(rows.length<35)return{action:'WAIT',reason:'At least 35 valid candles are required.',features:null};
 const closed=rows.slice(0,-1),closes=closed.map(r=>r[4]),volumes=closed.map(r=>r[5]),last=closed.at(-1);
 const avg=a=>mean(a),ema=(a,p)=>{const k=2/(p+1);return a.slice(1).reduce((v,x)=>x+k*(v-x),a[0]);};
 const ema9=ema(closes.slice(-40),9),ema21=ema(closes.slice(-60),21),momentum=(last[4]/closes.at(-13)-1)*100;
 const avgVol=avg(volumes.slice(-21,-1)),rvol=avgVol?last[5]/avgVol:0;
 const range=avg(closed.slice(-14).map(r=>r[2]-r[3])),atrPct=last[4]?range/last[4]*100:0;
 const trend=ema9>ema21?1:ema9<ema21?-1:0;
 const breakout=last[4]>Math.max(...closed.slice(-21,-1).map(r=>r[2]))?1:last[4]<Math.min(...closed.slice(-21,-1).map(r=>r[3]))?-1:0;
 const spreadPct=n(ticker.bid)>0&&n(ticker.ask)>n(ticker.bid)?(n(ticker.ask)-n(ticker.bid))/((n(ticker.ask)+n(ticker.bid))/2)*100:null;
 const regime=atrPct>2.5?'high-volatility':Math.abs(momentum)<.25?'range':'trend';
 const timeframeBias={};for(const [label,series] of Object.entries(context.timeframes||{})){const bars=(Array.isArray(series)?series:[]).filter(r=>Array.isArray(r)&&r.length>=5).slice(0,-1);if(bars.length>=25){const values=bars.map(r=>Number(r[4]));const avg=(a)=>a.reduce((s,v)=>s+v,0)/a.length;const ema=(a,p)=>{const k=2/(p+1);return a.slice(1).reduce((v,x)=>x+k*(v-x),a[0]);};timeframeBias[label]=ema(values.slice(-40),9)>ema(values.slice(-60),21)?1:-1;}else timeframeBias[label]=0;}
 const timeframeAgreement=Object.values(timeframeBias).filter(v=>v!==0).length?Object.values(timeframeBias).filter(v=>v===Math.sign(momentum)).length:0;
 const hour=new Date(last[0]).getUTCHours(),session=hour>=13&&hour<16?'London-New York overlap':hour>=7&&hour<16?'London':hour>=13&&hour<22?'New York':'Asia-Pacific';
 const sessionWeight=session==='London-New York overlap'?1:session==='London'||session==='New York'?.75:.4;
 const strategy=String(agentId).replace(/^.*:/,'');
 const score=strategy==='mean-reversion'?-Math.sign(momentum)*Math.min(1,Math.abs(momentum)/1.5)
 :strategy==='breakout'?breakout
 :strategy==='volume'?Math.sign(momentum)*(rvol>=1.25?1:0)
 :strategy==='trend'?(trend*.4+Math.sign(momentum)*.2+Math.sign(momentum)*timeframeAgreement*.13)
 :strategy==='risk'?0
 :strategy==='microstructure'?(spreadPct!==null&&spreadPct<=.12?Math.sign(momentum):0)
 :strategy==='session'?(trend===Math.sign(momentum)?Math.sign(momentum)*sessionWeight:0)
 :strategy==='regime'?(atrPct>2.5?0:regime==='range'?-Math.sign(momentum)*Math.min(1,Math.abs(momentum)):trend)
 :strategy==='momentum'?Math.sign(momentum)*Math.min(1,Math.abs(momentum)/1.2)
 :clamp(trend*.25+Math.sign(momentum)*.2+breakout*.2+(rvol>=1.2?Math.sign(momentum)*.1:0)+Math.sign(momentum)*timeframeAgreement*.15,-1,1);
 const direction=score>.25?'LONG':score<-.25?'SHORT':'FLAT';
 const signalAgreement=direction==='FLAT'?0:Object.values(timeframeBias).filter(v=>v===(direction==='LONG'?1:-1)).length;
 return{action:direction==='FLAT'?'WAIT':'SIGNAL',direction,score,reason:direction==='FLAT'?'No sufficiently strong closed-candle edge.':`Closed-bar score ${score.toFixed(2)}, momentum ${momentum.toFixed(3)}%, relative volume ${rvol.toFixed(2)}x.`,features:{closedCandleAt:new Date(last[0]).toISOString(),close:last[4],ema9,ema21,momentumPct:momentum,relativeVolume:rvol,atrPct,spreadPct,regime,session,timeframeBias,timeframeAgreement:signalAgreement,closedBars:closed.length}};
}
export function calculatePaperMetrics(trades=[],startingEquity=PAPER_POLICY.initialEquityUsd,now=Date.now()){
 const closed=trades.filter(t=>t.status==='closed'),wins=closed.filter(t=>n(t.netPnlUsd)>0),losses=closed.filter(t=>n(t.netPnlUsd)<0);
 const grossWin=wins.reduce((s,t)=>s+n(t.netPnlUsd),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+n(t.netPnlUsd),0));
 const rs=closed.map(t=>n(t.rMultiple)),expectancy=mean(rs),netPnl=closed.reduce((s,t)=>s+n(t.netPnlUsd),0);
 let streak=0,maxStreak=0;for(const t of [...closed].sort((a,b)=>Date.parse(a.closedAt||a.closed_at)-Date.parse(b.closedAt||b.closed_at))){streak=n(t.netPnlUsd)<0?streak+1:0;maxStreak=Math.max(maxStreak,streak);}
 let equity=startingEquity,peak=startingEquity,maxDd=0;const daily=new Map();
 for(const t of [...closed].sort((a,b)=>Date.parse(a.closedAt||a.closed_at)-Date.parse(b.closedAt||b.closed_at))){
  equity+=n(t.netPnlUsd);peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak?((peak-equity)/peak)*100:0);
  const day=String(t.closedAt||t.closed_at||'').slice(0,10);daily.set(day,(daily.get(day)||0)+n(t.netPnlUsd));
 }
 let dailyEquity=startingEquity;const returns=[];const firstDay=daily.size?Date.parse([...daily.keys()].sort()[0]+'T00:00:00Z'):null;const lastDay=new Date(now);lastDay.setUTCHours(0,0,0,0);if(firstDay!==null){for(let day=firstDay;day<=lastDay.getTime();day+=86400000){const key=new Date(day).toISOString().slice(0,10),pnl=daily.get(key)||0;if(dailyEquity>0)returns.push(pnl/dailyEquity);dailyEquity+=pnl;}}
 const avg=mean(returns),variance=mean(returns.map(v=>(v-avg)**2)),sharpe=variance?avg/Math.sqrt(variance)*Math.sqrt(365):0;
 const times=closed.map(t=>Date.parse(t.openedAt||t.opened_at)).filter(Number.isFinite),days=times.length?Math.max(0,(now-Math.min(...times))/86400000):0;
 const regimes=['trend','range','high-volatility'].map(regime=>({regime,trades:closed.filter(t=>t.regime===regime).length}));
 const averageWinUsd=wins.length?grossWin/wins.length:0,averageLossUsd=losses.length?grossLoss/losses.length:0;
 const fees=closed.reduce((s,t)=>s+n(t.entryFeeUsd??t.entry_fee_usd)+n(t.exitFeeUsd??t.exit_fee_usd),0);
 const holdMinutes=closed.map(t=>{const a=Date.parse(t.openedAt||t.opened_at),b=Date.parse(t.closedAt||t.closed_at);return Number.isFinite(a)&&Number.isFinite(b)?Math.max(0,(b-a)/60000):null;}).filter(v=>v!==null);
 const recoveryFactor=maxDd>0?netPnl/(maxDd/100*startingEquity):netPnl>0?999:0;
 return{closedTrades:closed.length,wins:wins.length,losses:losses.length,winRatePct:closed.length?wins.length/closed.length*100:0,
 profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?999:0,netPnlUsd:netPnl,equityUsd:startingEquity+netPnl,
 maxDrawdownPct:maxDd,expectancyR:expectancy,expectancyUsd:closed.length?netPnl/closed.length:0,
 averageWinUsd,averageLossUsd,payoffRatio:averageLossUsd?averageWinUsd/averageLossUsd:averageWinUsd>0?999:0,
 totalFeesUsd:fees,bestTradeUsd:closed.length?Math.max(...closed.map(t=>n(t.netPnlUsd))):0,
 worstTradeUsd:closed.length?Math.min(...closed.map(t=>n(t.netPnlUsd))):0,
 recoveryFactor,averageHoldMinutes:mean(holdMinutes),sharpe,maxConsecutiveLosses:maxStreak,
 observationDays:days,regimes,riskBreaches:closed.filter(t=>t.riskBreach===true).length};
}
export function assessAgentKpis(metrics={},policy=PAPER_POLICY,outOfSampleTrades=0){
 const checks=[
  ['winRate',n(metrics.winRatePct)>=policy.targetWinRatePct,metrics.winRatePct,policy.targetWinRatePct,'win rate %'],
  ['sample',n(metrics.closedTrades)>=policy.minimumClosedTrades,metrics.closedTrades,policy.minimumClosedTrades,'closed trades'],
  ['observation',n(metrics.observationDays)>=policy.minimumObservationDays,metrics.observationDays,policy.minimumObservationDays,'days'],
  ['profitFactor',n(metrics.profitFactor)>=policy.minimumProfitFactor,metrics.profitFactor,policy.minimumProfitFactor,'profit factor'],
  ['expectancy',n(metrics.expectancyR)>=policy.minimumExpectancyR,metrics.expectancyR,policy.minimumExpectancyR,'expectancy R'],
  ['netProfit',n(metrics.netPnlUsd)>=policy.minimumNetProfitUsd,metrics.netPnlUsd,policy.minimumNetProfitUsd,'net profit USD'],
  ['drawdown',n(metrics.maxDrawdownPct)<policy.maxDrawdownPct,metrics.maxDrawdownPct,policy.maxDrawdownPct,'max drawdown %'],
  ['sharpe',n(metrics.sharpe)>=policy.minimumSharpe,metrics.sharpe,policy.minimumSharpe,'Sharpe'],
  ['lossStreak',n(metrics.maxConsecutiveLosses)<=policy.maximumConsecutiveLosses,metrics.maxConsecutiveLosses,policy.maximumConsecutiveLosses,'max consecutive losses'],
  ['riskBreaches',n(metrics.riskBreaches)===policy.maximumRiskBreaches,metrics.riskBreaches,policy.maximumRiskBreaches,'risk breaches'],
  ['outOfSample',outOfSampleTrades>=policy.minimumOutOfSampleTrades,outOfSampleTrades,policy.minimumOutOfSampleTrades,'forward validation trades'],
  ['regimes',(metrics.regimes||[]).every(r=>r.trades>=policy.minimumRegimeTrades),metrics.regimes||[],policy.minimumRegimeTrades,'trades per regime']
 ];
 const passed=checks.every(c=>c[1]);
 return{eligibleForPromotion:passed,checks:checks.map(([id,pass,actual,target,unit])=>({id,pass,actual,target,unit})),status:passed?'LIVE_READY_CANDIDATE':'RESEARCH_TIER',promotion:passed?'LIVE_READY_REVIEW_REQUIRED':'NO_UPGRADE',liveExecutionAuthorized:false};
}
export function simulatePaperFill({direction,price,quantity,feeRate=PAPER_POLICY.feeRate,slippageBps=PAPER_POLICY.slippageBps,spreadBps=PAPER_POLICY.spreadBps}){
 const adverse=(slippageBps+spreadBps/2)/10000,entry=price*(direction==='LONG'?1+adverse:1-adverse),fee=entry*quantity*feeRate;
 return{entryPrice:entry,entryFeeUsd:fee,quantity,slippageBps,spreadBps,feeRate};
}
// Exit execution models the adverse half-spread as well as slippage. Keeping the
// spread argument explicit prevents a runtime ReferenceError during settlement.
export function settlePaperTrade(trade,exitPrice,feeRate=PAPER_POLICY.feeRate,slippageBps=PAPER_POLICY.slippageBps,spreadBps=PAPER_POLICY.spreadBps){
 const adverse=(slippageBps+spreadBps/2)/10000,exit=exitPrice*(trade.direction==='LONG'?1-adverse:1+adverse),gross=(exit-trade.entryPrice)*trade.quantity*(trade.direction==='LONG'?1:-1);
 const exitFee=exit*trade.quantity*feeRate,net=gross-n(exitFee)-n(trade.entryFeeUsd),risk=Math.max(.00000001,n(trade.riskUsd));
 return{exitPrice:exit,exitFeeUsd:exitFee,grossPnlUsd:gross,netPnlUsd:net,rMultiple:net/risk,exitSlippageBps:slippageBps,exitSpreadBps:spreadBps};
}
