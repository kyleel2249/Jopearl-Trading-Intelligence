import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
export const marketReplayRouter=express.Router();
const num=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
function ema(values,period){const alpha=2/(period+1),out=Array(values.length).fill(null);let value=values[0];for(let i=0;i<values.length;i++){value=i===0?values[i]:values[i]*alpha+value*(1-alpha);out[i]=i>=period-1?value:null;}return out;}
export function runDeterministicReplay(input={}){
 const candles=Array.isArray(input.candles)?input.candles:[];
 if(candles.length<60||candles.length>20000)throw new Error('Replay requires 60–20,000 OHLCV candles.');
 const rows=candles.map(c=>({timestamp:num(c.timestamp),open:num(c.open),high:num(c.high),low:num(c.low),close:num(c.close),volume:num(c.volume)}));
 for(let i=0;i<rows.length;i++){const c=rows[i];if(!Number.isFinite(c.timestamp)||![c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite)||Math.min(c.open,c.high,c.low,c.close)<=0||c.volume<0||c.high<Math.max(c.open,c.close,c.low)||c.low>Math.min(c.open,c.close,c.high)||(i&&c.timestamp<=rows[i-1].timestamp))throw new Error('Candles must be valid, positive and strictly chronological OHLCV records.');}
 const strategy=String(input.strategy||'ema_cross');if(!['ema_cross','breakout'].includes(strategy))throw new Error('Supported replay strategies are ema_cross and breakout.');
 const fast=Math.max(2,Math.min(100,Math.floor(num(input.fastPeriod)||12))),slow=Math.max(fast+1,Math.min(300,Math.floor(num(input.slowPeriod)||26))),lookback=Math.max(5,Math.min(100,Math.floor(num(input.lookback)||20)));
 const initial= num(input.initialCapital)??10000,feeBps=num(input.feeBps)??10,slippageBps=num(input.slippageBps)??5,allocationPct=num(input.allocationPct)??95;
 if(initial<=0||feeBps<0||feeBps>1000||slippageBps<0||slippageBps>1000||allocationPct<=0||allocationPct>100)throw new Error('Capital, fees, slippage or allocation parameters are outside valid bounds.');
 const closes=rows.map(c=>c.close),fastEma=ema(closes,fast),slowEma=ema(closes,slow);
 let cash=initial,quantity=0,entryCost=0,entryAt=null,peak=initial,maxDrawdown=0;
 const trades=[],equityCurve=[],signals=[];
 const execute=(side,rawPrice,at,reason)=>{
  const price=rawPrice*(side==='buy'?1+slippageBps/10000:1-slippageBps/10000),feeRate=feeBps/10000;
  if(side==='buy'){const budget=cash*allocationPct/100,qty=budget/(price*(1+feeRate));const cost=qty*price,fee=cost*feeRate;cash-=cost+fee;quantity=qty;entryCost=cost+fee;entryAt=at;signals.push({side,at,price,reason});}
  else if(quantity>0){const proceeds=quantity*price,fee=proceeds*feeRate,pnl=proceeds-fee-entryCost;cash+=proceeds-fee;trades.push({entryAt,exitAt:at,entryCost,exitProceeds:proceeds-fee,pnl,returnPercent:pnl/entryCost*100,reason});quantity=0;entryCost=0;entryAt=null;signals.push({side,at,price,reason});}
 };
 for(let i=1;i<rows.length-1;i++){
  let signal=0,reason='';
  if(strategy==='ema_cross'&&fastEma[i-1]!==null&&slowEma[i-1]!==null&&fastEma[i]!==null&&slowEma[i]!==null){
   if(fastEma[i-1]<=slowEma[i-1]&&fastEma[i]>slowEma[i]){signal=1;reason='ema_bullish_cross';}
   else if(fastEma[i-1]>=slowEma[i-1]&&fastEma[i]<slowEma[i]){signal=-1;reason='ema_bearish_cross';}
  }
  if(strategy==='breakout'&&i>=lookback){const prior=rows.slice(i-lookback,i),high=Math.max(...prior.map(c=>c.high)),low=Math.min(...prior.map(c=>c.low));if(rows[i].close>high){signal=1;reason='prior_range_breakout';}else if(rows[i].close<low){signal=-1;reason='prior_range_breakdown';}}
  if(signal===1&&quantity===0)execute('buy',rows[i+1].open,rows[i+1].timestamp,reason);
  else if(signal===-1&&quantity>0)execute('sell',rows[i+1].open,rows[i+1].timestamp,reason);
  const equity=cash+quantity*rows[i].close;peak=Math.max(peak,equity);maxDrawdown=Math.max(maxDrawdown,(peak-equity)/peak);equityCurve.push({timestamp:rows[i].timestamp,equity});
 }
 if(quantity>0)execute('sell',rows.at(-1).close,rows.at(-1).timestamp,'end_of_dataset_liquidation');
 const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<0),grossProfit=wins.reduce((s,t)=>s+t.pnl,0),grossLoss=Math.abs(losses.reduce((s,t)=>s+t.pnl,0)),net=trades.reduce((s,t)=>s+t.pnl,0);
 const split=Math.floor(rows.length*.7),trainTrades=trades.filter(t=>t.exitAt<=rows[split-1].timestamp),testTrades=trades.filter(t=>t.entryAt>=rows[split].timestamp);
 return {generatedAt:new Date().toISOString(),strategy,parameters:{fastPeriod:fast,slowPeriod:slow,lookback,initialCapital:initial,feeBps,slippageBps,allocationPct},data:{candleCount:rows.length,firstTimestamp:new Date(rows[0].timestamp).toISOString(),lastTimestamp:new Date(rows.at(-1).timestamp).toISOString(),chronological:true},
  performance:{finalEquity:cash,netPnl:net,returnPercent:net/initial*100,closedTrades:trades.length,wins:wins.length,losses:losses.length,winRatePercent:trades.length?wins.length/trades.length*100:null,profitFactor:grossLoss?grossProfit/grossLoss:grossProfit?null:0,expectancyPerTrade:trades.length?net/trades.length:null,maxDrawdownPercent:maxDrawdown*100},
  validation:{trainTrades:trainTrades.length,testTrades:testTrades.length,trainPnl:trainTrades.reduce((s,t)=>s+t.pnl,0),testPnl:testTrades.reduce((s,t)=>s+t.pnl,0),splitIndex:split,splitPolicy:'chronological 70/30 reporting split; parameters are not optimized on the test segment'},
  trades:trades.slice(-500),signals:signals.slice(-500),equityCurve:equityCurve.filter((_,i)=>i%Math.max(1,Math.floor(equityCurve.length/500))===0).slice(-500),
  limitations:['Long-only, single-instrument simulation; no leverage, funding, margin or liquidation.','Signals are computed from completed candle closes and filled at the next candle open; final open positions are liquidated at the last close.','Fee and slippage are fixed assumptions, not venue-specific execution models.','The 70/30 split is descriptive; this engine does not automatically optimize parameters or certify a strategy.','No intrabar order sequencing, queue position, partial fills or market impact is modeled.']};
}
marketReplayRouter.post('/replay',async(req,res)=>{
 try{requirePrivateApiAuth(req);const result=runDeterministicReplay(req.body||{});const id=randomUUID();await appendStoredEvent({kind:'market-replay-run',source:'jpti-market-replay',eventType:'replay_completed',externalId:id,occurredAt:result.generatedAt,payload:{id,...result}});res.json({id,...result,persisted:true,liveExecutionAuthorized:false});}
 catch(error){res.status(error.status||400).json({error:error.message||'Market replay failed.'});}
});
