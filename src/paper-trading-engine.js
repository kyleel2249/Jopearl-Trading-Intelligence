// Deterministic, fee-aware paper-trading and KPI promotion engine. No exchange order API exists here.
export const PAPER_POLICY = Object.freeze({
  mode: 'PAPER_ONLY', initialEquityUsd: 10000, riskPerTradePct: 0.25, maxDailyLossPct: 2,
  maxDrawdownPct: 5, maxOpenPositions: 3, maxConcurrentPerAgent: 1, maxLeverage: 1,
  feeRate: 0.0006, slippageBps: 5, spreadBps: 3, targetWinRatePct: 98,
  minimumClosedTrades: 200, minimumObservationDays: 90, minimumProfitFactor: 1.5,
  minimumExpectancyR: 0.15, minimumSharpe: 0.8, minimumRegimeTrades: 30,
  minimumOutOfSampleTrades: 50
});
export const PAPER_AGENTS = Object.freeze([
  ['trend','Trend Structure','EMA alignment and directional persistence'],
  ['momentum','Momentum Pulse','Rate-of-change and acceleration'],
  ['mean-reversion','Mean Reversion','Range extension and reversion confirmation'],
  ['breakout','Volatility Breakout','Closed-candle range expansion'],
  ['volume','Volume Participation','Relative volume confirmation'],
  ['session','Session Specialist','Session-aware volatility and liquidity'],
  ['risk','Capital Guardian','Drawdown, exposure and volatility veto'],
  ['microstructure','Microstructure','Spread and executable liquidity filter'],
  ['regime','Regime Adaptive','Trend/range/volatility classification'],
  ['ensemble','Council Ensemble','Agreement across specialist signals']
].map(([id,name,edge])=>({id,name,edge,resources:['Live Bitget public market data','Closed-candle history','Fee and slippage simulator','Strategy research library','Risk and capital survival engine','Trade forensics and daily reviews']})));
const n=(v)=>Number.isFinite(Number(v))?Number(v):0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export function derivePaperSignal(candles, ticker={}, agentId='ensemble') {
  const rows=(Array.isArray(candles)?candles:[]).filter(r=>Array.isArray(r)&&r.length>=6&&r.slice(0,6).every(v=>Number.isFinite(Number(v)))).map(r=>r.map(Number)).sort((a,b)=>a[0]-b[0]);
  if(rows.length<35) return {action:'WAIT',reason:'At least 35 valid candles are required.',features:null};
  // Exclude the currently forming candle. Signal uses closed bars only.
  const closed=rows.slice(0,-1), closes=closed.map(r=>r[4]), volumes=closed.map(r=>r[5]);
  const last=closed.at(-1), prev=closed.at(-2), mean=(arr)=>arr.reduce((s,v)=>s+v,0)/arr.length;
  const ema=(arr,period)=>{const k=2/(period+1);return arr.slice(1).reduce((v,p)=>p+k*(v-p),arr[0]);};
  const ema9=ema(closes.slice(-40),9),ema21=ema(closes.slice(-60),21);
  const momentum=(last[4]/closes.at(-13)-1)*100;
  const avgVol=mean(volumes.slice(-21,-1)),rvol=avgVol?last[5]/avgVol:0;
  const range=mean(closed.slice(-14).map(r=>r[2]-r[3]));
  const atrPct=last[4]?range/last[4]*100:0;
  const trend=ema9>ema21?1:ema9<ema21?-1:0;
  const breakout=last[4]>Math.max(...closed.slice(-21,-1).map(r=>r[2]))?1:last[4]<Math.min(...closed.slice(-21,-1).map(r=>r[3]))?-1:0;
  const spreadPct=n(ticker.bid)>0&&n(ticker.ask)>n(ticker.bid)?(n(ticker.ask)-n(ticker.bid))/((n(ticker.ask)+n(ticker.bid))/2)*100:null;
  const hour=new Date(last[0]).getUTCHours(),session=hour>=13&&hour<16?'London-New York overlap':hour>=7&&hour<16?'London':hour>=13&&hour<22?'New York':'Asia-Pacific';
  const sessionWeight=session==='London-New York overlap'?1:session==='London'||session==='New York'?.75:.4;
  const score=agentId==='mean-reversion'?-Math.sign(momentum)*Math.min(1,Math.abs(momentum)/1.5):agentId==='breakout'?breakout:agentId==='volume'?Math.sign(momentum)*(rvol>=1.25?1:0):agentId==='trend'?trend:agentId==='risk'?0:agentId==='microstructure'?(spreadPct!==null&&spreadPct<=0.12?Math.sign(momentum):0):agentId==='session'?trend*Math.sign(momentum)*sessionWeight:agentId==='regime'?(atrPct>2.5?0:regime==='range'?-Math.sign(momentum)*Math.min(1,Math.abs(momentum)):trend):agentId==='momentum'?Math.sign(momentum)*Math.min(1,Math.abs(momentum)/1.2):clamp(trend*.35+Math.sign(momentum)*.35+breakout*.2+(rvol>=1.2?Math.sign(momentum)*.1:0),-1,1);
  const direction=score>.25?'LONG':score<-.25?'SHORT':'FLAT';
  const regime=atrPct>2.5?'high-volatility':Math.abs(momentum)<.25?'range':'trend';
  const reason=direction==='FLAT'?'No sufficiently strong closed-candle edge.':`Closed-bar score ${score.toFixed(2)}, momentum ${momentum.toFixed(3)}%, relative volume ${rvol.toFixed(2)}x.`;
  return {action:direction==='FLAT'?'WAIT':'SIGNAL',direction,score,reason,features:{closedCandleAt:new Date(last[0]).toISOString(),close:last[4],ema9,ema21,momentumPct:momentum,relativeVolume:rvol,atrPct,spreadPct,regime,session,closedBars:closed.length}};
}
export function calculatePaperMetrics(trades=[], startingEquity=PAPER_POLICY.initialEquityUsd, now=Date.now()) {
  const closed=trades.filter(t=>t.status==='closed'), wins=closed.filter(t=>n(t.netPnlUsd)>0), losses=closed.filter(t=>n(t.netPnlUsd)<0);
  const grossWin=wins.reduce((s,t)=>s+n(t.netPnlUsd),0),grossLoss=Math.abs(losses.reduce((s,t)=>s+n(t.netPnlUsd),0));
  const rs=closed.map(t=>n(t.rMultiple)), expectancy=rs.length?rs.reduce((s,v)=>s+v,0)/rs.length:0;
  let streak=0,maxStreak=0;for(const t of [...closed].sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt))){streak=n(t.netPnlUsd)<0?streak+1:0;maxStreak=Math.max(maxStreak,streak);}
  let equity=startingEquity,peak=startingEquity,maxDd=0;const dailyPnl=new Map();
  for(const t of [...closed].sort((a,b)=>Date.parse(a.closedAt)-Date.parse(b.closedAt))){equity+=n(t.netPnlUsd);peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak?((peak-equity)/peak)*100:0);const day=String(t.closedAt||'').slice(0,10);dailyPnl.set(day,(dailyPnl.get(day)||0)+n(t.netPnlUsd));}
  let dailyEquity=startingEquity;const returns=[];for(const [,pnl] of [...dailyPnl].sort((a,b)=>a[0].localeCompare(b[0]))){if(dailyEquity>0)returns.push(pnl/dailyEquity);dailyEquity+=pnl;}
  const avg=returns.length?mean(returns):0,variance=returns.length?mean(returns.map(v=>(v-avg)**2)):0,sharpe=variance?avg/Math.sqrt(variance)*Math.sqrt(365):0;
  const first=closed.length?Math.min(...closed.map(t=>Date.parse(t.openedAt)||now)):now;
  const days=Math.max(0,(now-first)/86400000);
  const regimes=['trend','range','high-volatility'].map(regime=>({regime,trades:closed.filter(t=>t.regime===regime).length}));
  return {closedTrades:closed.length,wins:wins.length,losses:losses.length,winRatePct:closed.length?wins.length/closed.length*100:0,profitFactor:grossLoss?grossWin/grossLoss:grossWin>0?999:0,netPnlUsd:closed.reduce((s,t)=>s+n(t.netPnlUsd),0),equityUsd:startingEquity+closed.reduce((s,t)=>s+n(t.netPnlUsd),0),maxDrawdownPct:maxDd,expectancyR:expectancy,sharpe,maxConsecutiveLosses:maxStreak,observationDays:days,regimes};
}
const mean=(a)=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
export function assessAgentKpis(metrics={}, policy=PAPER_POLICY, outOfSampleTrades=0) {
  const checks=[
    ['winRate',n(metrics.winRatePct)>=policy.targetWinRatePct,metrics.winRatePct,policy.targetWinRatePct,'win rate %'],
    ['sample',n(metrics.closedTrades)>=policy.minimumClosedTrades,metrics.closedTrades,policy.minimumClosedTrades,'closed trades'],
    ['observation',n(metrics.observationDays)>=policy.minimumObservationDays,metrics.observationDays,policy.minimumObservationDays,'days'],
    ['profitFactor',n(metrics.profitFactor)>=policy.minimumProfitFactor,metrics.profitFactor,policy.minimumProfitFactor,'profit factor'],
    ['expectancy',n(metrics.expectancyR)>=policy.minimumExpectancyR,metrics.expectancyR,policy.minimumExpectancyR,'expectancy R'],
    ['drawdown',n(metrics.maxDrawdownPct)<=policy.maxDrawdownPct,metrics.maxDrawdownPct,policy.maxDrawdownPct,'max drawdown %'],
    ['sharpe',n(metrics.sharpe)>=policy.minimumSharpe,metrics.sharpe,policy.minimumSharpe,'Sharpe'],\n    ['lossStreak',n(metrics.maxConsecutiveLosses)<=5,metrics.maxConsecutiveLosses,5,'max consecutive losses'],
    ['outOfSample',outOfSampleTrades>=policy.minimumOutOfSampleTrades,outOfSampleTrades,policy.minimumOutOfSampleTrades,'out-of-sample trades'],
    ['regimes',(metrics.regimes||[]).every(r=>r.trades>=policy.minimumRegimeTrades),metrics.regimes||[],policy.minimumRegimeTrades,'trades per regime']
  ];
  const passed=checks.every(c=>c[1]);
  return {eligibleForPromotion:passed,checks:checks.map(([id,pass,actual,target,unit])=>({id,pass,actual,target,unit})),status:passed?'PROMOTION_ELIGIBLE':'RESEARCH_TIER',promotion:passed?'AUTOMATIC_PAPER_TIER_UPGRADE':'NO_UPGRADE'};
}
export function simulatePaperFill({direction,price,quantity,feeRate=PAPER_POLICY.feeRate,slippageBps=PAPER_POLICY.slippageBps,spreadBps=PAPER_POLICY.spreadBps}) {
  const adverse=(slippageBps+spreadBps/2)/10000;
  const entry=price*(direction==='LONG'?1+adverse:1-adverse);
  const fee=entry*quantity*feeRate;
  return {entryPrice:entry,entryFeeUsd:fee,quantity,slippageBps,spreadBps,feeRate};
}
export function settlePaperTrade(trade,exitPrice,feeRate=PAPER_POLICY.feeRate,slippageBps=PAPER_POLICY.slippageBps) {
  const adverse=slippageBps/10000,exit=exitPrice*(trade.direction==='LONG'?1-adverse:1+adverse);
  const gross=(exit-trade.entryPrice)*trade.quantity*(trade.direction==='LONG'?1:-1);
  const exitFee=exit*trade.quantity*feeRate,net=gross-n(exitFee)-n(trade.entryFeeUsd);
  const risk=Math.max(0.00000001,n(trade.riskUsd));
  return {exitPrice:exit,exitFeeUsd:exitFee,grossPnlUsd:gross,netPnlUsd:net,rMultiple:net/risk};
}
