// JPTI Multi-Asset Intelligence 3.0 — shared research, portfolio and paper-decision layer.
// This module never submits exchange orders. Missing/stale evidence always produces abstention.
import {runAgentFleet} from './agent-fleet-engine.js';
import {analyzeSMC} from './smc-intelligence.js';
import {classifyMarketRegime,evaluateRiskGate} from './intelligence-foundation-engine.js';
import {runAgentDebate} from './multi-agent-debate-engine.js';
export const MULTI_ASSET_MODULES = Object.freeze([
  {id:'crypto-futures',name:'Crypto & Perpetual Futures',assetClass:'crypto',instruments:['BTC/USDT','ETH/USDT','SOL/USDT'],sessions:['24x5'],providerStatus:'connected',capabilities:['spot','perpetual','delivery','funding','open-interest','liquidations','order-book','trades']},
  {id:'stocks',name:'Stocks & Equities',assetClass:'equity',instruments:[],sessions:['exchange-local'],providerStatus:'provider-required',capabilities:['ohlcv','quotes','corporate-actions','fundamentals','earnings','halts']},
  {id:'commodities',name:'Commodities',assetClass:'commodity',instruments:['GC','SI','CL','NG','HG','ZC','ZW'],sessions:['exchange-local'],providerStatus:'provider-required',capabilities:['ohlcv','futures-curve','inventory','seasonality','weather','supply-demand']},
  {id:'indices',name:'Global Indices',assetClass:'index',instruments:['ES','NQ','YM','RTY','FDAX','NKD'],sessions:['exchange-local'],providerStatus:'provider-required',capabilities:['ohlcv','breadth','constituents','sector-rotation','volatility']},
  {id:'forex',name:'Foreign Exchange',assetClass:'fx',instruments:['EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CHF'],sessions:['sydney','tokyo','london','new-york'],providerStatus:'provider-required',capabilities:['ohlcv','bid-ask','currency-strength','rates','economic-calendar','rollover']},
  {id:'onchain',name:'On-chain & DeFi',assetClass:'onchain',instruments:['BTC','ETH','SOL'],sessions:['24x5'],providerStatus:'provider-required',capabilities:['wallet-flows','exchange-flows','whale-alerts','dex-liquidity','tvl','smart-contract-risk','gas','token-transfers']}
]);
export const AGENT_SQUADS = Object.freeze([
 {id:'scalping',name:'SCALP STRIKE DIVISION',style:'Scalping',agents:[
  ['Nyx','Microstructure & tape-reading sniper','orderflow','1m-5m'],
  ['Vega','Liquidity sweep and stop-run analyst','liquidity','1m-5m'],
  ['Cipher','FVG, displacement and mitigation specialist','smc','1m-5m'],
  ['Razor','Spread, slippage and execution-quality analyst','execution','1m-5m']
 ]},
 {id:'day-trading',name:'INTRADAY TACTICAL DIVISION',style:'Day trading',agents:[
  ['Atlas','Multi-timeframe market-structure commander','structure','5m-1h'],
  ['Lyra','Session, opening-range and volatility specialist','session','5m-1h'],
  ['Kestrel','Momentum, VWAP and trend-continuation analyst','momentum','5m-1h'],
  ['Morpheus','Reversal, exhaustion and failed-breakout analyst','reversal','5m-1h']
 ]},
 {id:'cross-market',name:'CROSS-MARKET INTELLIGENCE DIVISION',style:'Multi-asset research',agents:[
  ['Echo','Cross-exchange price discovery and arbitrage analyst','arbitrage','tick-1h'],
  ['Orion','Macro, rates and intermarket correlation analyst','macro','15m-1d'],
  ['Satoshi','On-chain flows, wallets and DeFi liquidity analyst','onchain','block-1d'],
  ['Meridian','Equities, indices and commodity fundamentals analyst','fundamental','5m-1d']
 ]},
 {id:'capital-guard',name:'CAPITAL PRESERVATION COMMAND',style:'Independent risk oversight',agents:[
  ['Aegis','Portfolio risk, exposure and drawdown supervisor','risk','portfolio'],
  ['Sentinel','Data quality, event risk and anomaly monitor','safety','tick-1d'],
  ['Quanta','Strategy validation, decay and retirement auditor','validation','strategy']
 ]}
]);
export const JPTI_STRATEGY_LIBRARY = Object.freeze([
 {id:'smc-market-structure',name:'SMC market structure',families:['BOS','CHOCH','swing structure','dealing range','premium-discount'],requires:['timestamp','price','marketStructure']},
 {id:'liquidity-sweep-fvg',name:'Liquidity sweep + FVG',families:['equal highs/lows','buy-side/sell-side liquidity','sweep','displacement','fair value gap','mitigation'],requires:['timestamp','price','liquiditySweep','fvg']},
 {id:'orderflow-imbalance',name:'Order-flow and liquidity imbalance',families:['bid/ask delta','depth imbalance','aggressive flow','absorption'],requires:['timestamp','price','orderBookImbalance','tradeFlowImbalance']},
 {id:'session-opening-range',name:'Session and opening-range',families:['Asia range','London open','New York open','opening range breakout'],requires:['timestamp','price','session','sessionOpen']},
 {id:'trend-momentum',name:'Trend and momentum',families:['EMA alignment','VWAP','RSI','ATR','relative volume'],requires:['timestamp','price','momentumPct','timeframeAlignment','relativeVolume']},
 {id:'cross-market-relative-value',name:'Cross-market relative value',families:['basis','spread convergence','correlation divergence','liquidity migration'],requires:['timestamp','price','crossVenuePrices','estimatedCosts']},
 {id:'onchain-flow',name:'On-chain flow intelligence',families:['exchange netflows','whale accumulation','stablecoin flows','DEX liquidity'],requires:['timestamp','price','exchangeNetflow','walletFlowQuality']}
]);
const finite=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v));
const clamp=(v,min,max)=>Math.max(min,Math.min(max,Number(v)||0));
const isoNow=()=>new Date().toISOString();
export function normalizeAssetInstrument(input={}) {
 const assetClass=String(input.assetClass||'crypto').toLowerCase();
 const symbol=String(input.symbol||'').trim().toUpperCase();
 const module=MULTI_ASSET_MODULES.find(x=>x.assetClass===assetClass);
 if(!module)throw new Error('Unsupported JPTI asset class.');
 if(!symbol||symbol.length>40||/[<>\s]/.test(symbol))throw new Error('A valid canonical instrument symbol is required.');
 const marketType=String(input.marketType||({crypto:'usdt-m',onchain:'spot',fx:'spot',commodity:'future',index:'future',equity:'cash'}[assetClass]||'cash')).toLowerCase();
 const allowed={crypto:['spot','margin','usdt-m','coin-m','usdc-m'],equity:['cash','shares','options'],commodity:['spot','future','etf'],index:['cash','future','etf','cfd'],fx:['spot','forward','future'],onchain:['spot','perpetual','defi']};
 if(!allowed[assetClass].includes(marketType))throw new Error('Market type is not supported for '+assetClass+'.');
 return {assetClass,moduleId:module.id,symbol,marketType,venue:String(input.venue||'unconfigured').toLowerCase()};
}
export function isWeekdaySession(timestamp=Date.now(),assetClass='crypto',sessionOpen=true) {
 const d=new Date(timestamp),day=d.getUTCDay();
 if(day===0||day===6)return {open:false,reason:'Weekend trading is disabled by the JPTI weekday policy.'};
 if(sessionOpen===false)return {open:false,reason:'The instrument venue session is closed.'};
 if(['equity','commodity','index'].includes(assetClass)&&sessionOpen!==true)return {open:false,reason:'Exchange-local session confirmation is required.'};
 return {open:true,reason:'Weekday session policy passed; venue-specific calendar confirmation is still required for exchange-listed instruments.'};
}
export function evaluateSMCSetup(e={}) {
 const checks=[
  ['marketStructure',e.marketStructure==='bullish'||e.marketStructure==='bearish'],
  ['liquiditySweep',e.liquiditySweep===true],
  ['fvg',e.fvg===true],
  ['displacement',finite(e.displacementPct)&&Number(e.displacementPct)>0],
  ['premiumDiscount',e.premiumDiscount==='discount'||e.premiumDiscount==='premium'],
  ['multiTimeframeAlignment',finite(e.timeframeAlignment)&&Math.abs(Number(e.timeframeAlignment))>=.5]
 ];
 const passed=checks.filter(x=>x[1]).map(x=>x[0]),missing=checks.filter(x=>!x[1]).map(x=>x[0]);
 const direction=e.marketStructure==='bullish'?'long':e.marketStructure==='bearish'?'short':'flat';
 const zoneAligned=(direction==='long'&&e.premiumDiscount==='discount')||(direction==='short'&&e.premiumDiscount==='premium');
 const score=clamp((passed.length/6)*.7+(zoneAligned ? 0.3 : 0),0,1);
 return {direction,score,passed,missing,qualified:passed.length>=5&&zoneAligned};
}
export function evaluateSpecialistSquads(e={}) {
 const specs={
  orderflow:{required:['orderBookImbalance','tradeFlowImbalance'],score:()=>clamp((Number(e.orderBookImbalance)+Number(e.tradeFlowImbalance))/2),rationale:'Visible depth and executed-flow imbalance.'},
  liquidity:{required:['liquiditySweep','fvg'],score:()=>e.liquiditySweep&&e.fvg?1:0,rationale:'Sweep and fair-value-gap confluence.'},
  smc:{required:['marketStructure','liquiditySweep','fvg','displacementPct'],score:()=>e.marketStructure==='bullish'?1:e.marketStructure==='bearish'?-1:0,rationale:'Structure, sweep, displacement and FVG.'},
  execution:{required:['spreadBps','liquidityUsd'],score:()=>clamp(1-Number(e.spreadBps)/30,0,1),rationale:'Spread and visible liquidity quality.'},
  structure:{required:['marketStructure','timeframeAlignment'],score:()=>e.marketStructure==='bullish'?Math.abs(Number(e.timeframeAlignment)):e.marketStructure==='bearish'?-Math.abs(Number(e.timeframeAlignment)):0,rationale:'Multi-timeframe market structure.'},
  session:{required:['session','sessionOpen'],score:()=>e.sessionOpen===true?1:0,rationale:'Session and venue-calendar confirmation.'},
  momentum:{required:['momentumPct','relativeVolume'],score:()=>clamp(Number(e.momentumPct)/3,-1,1)*clamp(Number(e.relativeVolume)/2,0,1),rationale:'Momentum confirmed by relative volume.'},
  reversal:{required:['momentumPct','volatilityPct'],score:()=>clamp(-Number(e.momentumPct)/3,-1,1),rationale:'Counter-momentum exhaustion watch; requires separate reversal confirmation.'},
  arbitrage:{required:['crossVenuePrices','estimatedCosts'],score:()=>Array.isArray(e.crossVenuePrices)&&e.crossVenuePrices.length>=2?1:0,rationale:'Cross-venue quotes compared against all-in costs.'},
  macro:{required:['macroBias','highImpactEvent'],score:()=>e.macroBias==='risk-on'?1:e.macroBias==='risk-off'?-1:0,rationale:'Supplied macro regime and event-risk context.'},
  onchain:{required:['exchangeNetflow','walletFlowQuality'],score:()=>clamp(-Number(e.exchangeNetflow),-1,1),rationale:'Verified exchange netflows and wallet attribution.'},
  fundamental:{required:['fundamentalsScore','earningsSurprise'],score:()=>clamp(Number(e.fundamentalsScore)/100,-1,1),rationale:'Fundamental quality and earnings surprise context.'},
  risk:{required:['drawdownPct','riskUsd','riskBudgetUsd'],score:()=>Number(e.drawdownPct)>5||Number(e.riskUsd)>Number(e.riskBudgetUsd)?-1:0,rationale:'Portfolio drawdown and allocated risk-budget supervision.'},
  safety:{required:['dataQuality','eventTimeReliable'],score:()=>e.dataQuality==='verified'&&e.eventTimeReliable===true?1:-1,rationale:'Feed integrity, freshness and event-time ordering.'},
  validation:{required:['closedTrades','expectancyR','profitFactor'],score:()=>Number(e.expectancyR)>0&&Number(e.profitFactor)>1?1:-1,rationale:'Forward sample, expectancy and profit-factor gate.'}
 };
 return AGENT_SQUADS.flatMap(squad=>squad.agents.map(([name,role,specialty,timeframe])=>{
  const spec=specs[specialty],missing=spec.required.filter(k=>e[k]===undefined||e[k]===null||e[k]==='');
  const evaluated=missing.length===0,score=evaluated?Number(clamp(spec.score()).toFixed(4)):null;
  return {id:name.toLowerCase(),name,role,squadId:squad.id,style:squad.style,specialty,timeframe,status:evaluated?'evaluated':'abstain-missing-evidence',score,confidence:evaluated?Math.min(1,Math.abs(score)*.8+.2):0,missingEvidence:missing,rationale:evaluated?spec.rationale:'Specialist abstains; required evidence is unavailable.',executionPermission:'none'};
 }));
}
export function evaluateMultiAssetOpportunity(input={},policy={}) {
 const instrument=normalizeAssetInstrument(input),e=input.evidence||{};
 const now=Number(policy.now)||Date.now(),timestamp=Date.parse(e.timestamp||'');
 const maxAgeMs=clamp(policy.maxAgeMs||60000,5000,86400000);
 const ageMs=Number.isFinite(timestamp)?now-timestamp:null;
 const missing=['price','spreadBps','volatilityPct','liquidityUsd'].filter(k=>!finite(e[k]));
 const stale=ageMs===null||ageMs< -5000||ageMs>maxAgeMs;
 const session=isWeekdaySession(now,instrument.assetClass,e.sessionOpen);
 const allCandles=Array.isArray(input.candles)?input.candles:null;
 const smcCandles=allCandles?allCandles.slice(0,-1):null;
 const smcEngine=smcCandles?analyzeSMC(smcCandles):null;
 const smc=evaluateSMCSetup({...e,
  marketStructure:e.marketStructure||(smcEngine?.bias==='bullish'?'bullish':smcEngine?.bias==='bearish'?'bearish':undefined),
  liquiditySweep:e.liquiditySweep??!!smcEngine?.events?.some(x=>x.type==='LIQUIDITY_SWEEP'),
  fvg:e.fvg??!!smcEngine?.zones?.some(x=>x.type==='FVG'&&x.status==='active'),
  premiumDiscount:e.premiumDiscount||(smcEngine?.range?.discount?'discount':smcEngine?.range?.premium?'premium':undefined)
 });
 const agentFleet=runAgentFleet({symbol:instrument.symbol,evidence:e},now);
 const specialistEvidence={...e,marketStructure:e.marketStructure||(smcEngine?.bias==='bullish'?'bullish':smcEngine?.bias==='bearish'?'bearish':undefined),liquiditySweep:e.liquiditySweep??!!smcEngine?.events?.some(x=>x.type==='LIQUIDITY_SWEEP'),fvg:e.fvg??!!smcEngine?.zones?.some(x=>x.type==='FVG'&&x.status==='active'),premiumDiscount:e.premiumDiscount||(smcEngine?.range?.discount?'discount':smcEngine?.range?.premium?'premium':undefined)};
 const specialists=evaluateSpecialistSquads(specialistEvidence);
 const regime=allCandles?classifyMarketRegime(allCandles):null;
 const debateSnapshot={status:'ready',domains:{structure:{bias:smcEngine?.bias||e.marketStructure||'neutral'},regime:{label:regime?.regime||'unclassified'},liquidity:{sweepLow:smcEngine?.events?.some(x=>x.type==='LIQUIDITY_SWEEP'&&x.direction==='bullish'),sweepHigh:smcEngine?.events?.some(x=>x.type==='LIQUIDITY_SWEEP'&&x.direction==='bearish')},flow:{relativeVolume:e.relativeVolume}},scores:{directionalBias:smcEngine?.bias||e.marketStructure||'neutral'},evidence:[
  ...(finite(e.momentumPct)?[{domain:'Momentum',score:clamp(50+Number(e.momentumPct)*10,0,100)}]:[]),
  ...(finite(e.relativeVolume)?[{domain:'Flow proxy',score:clamp(50+(Number(e.relativeVolume)-1)*20,0,100)}]:[])
 ],conflicts:[]};
 const debate=runAgentDebate(debateSnapshot,{dataQuality:{stale},orderBookAnalysis:{imbalancePct:finite(e.orderBookImbalance)?Number(e.orderBookImbalance)*100:null}});
 const directional=[
  finite(e.momentumPct)?clamp(Number(e.momentumPct)/2,-1,1)*.16:0,
  finite(e.timeframeAlignment)?clamp(e.timeframeAlignment,-1,1)*.18:0,
  finite(e.orderBookImbalance)?clamp(e.orderBookImbalance,-1,1)*.15:0,
  finite(e.tradeFlowImbalance)?clamp(e.tradeFlowImbalance,-1,1)*.12:0,
  finite(e.relativeVolume)?Math.sign(Number(e.momentumPct)||0)*clamp((Number(e.relativeVolume)-1)/2,-1,1)*.08:0,
  smc.direction==='long'?smc.score*.2:smc.direction==='short'?-smc.score*.2:0,
  finite(e.crossAssetBias)?clamp(e.crossAssetBias,-1,1)*.06:0,
  finite(e.onchainBias)?clamp(e.onchainBias,-1,1)*.05:0
 ];
 const score=directional.reduce((a,b)=>a+b,0),confidence=clamp(Math.abs(score)*1.5,0,1);
 const direction=score>.12?'long':score<-.12?'short':'flat';
 const riskGate=input.riskContext?evaluateRiskGate({...input.riskContext,dataFresh:!stale,dataAgeMs:ageMs,spreadPercent:finite(e.spreadBps)?Number(e.spreadBps)/100:null,confidence},input.riskPolicy||{}):null;
 const veto=[];
 if(stale)veto.push('stale-or-missing-event-time-evidence');
 if(missing.length)veto.push('missing-required-market-quality-fields:'+missing.join(','));
 if(!session.open)veto.push('session-closed');
 if(e.highImpactEvent===true)veto.push('high-impact-event-risk');
 if(finite(e.spreadBps)&&Number(e.spreadBps)>Number(policy.maxSpreadBps??20))veto.push('spread-exceeds-policy');
 if(finite(e.volatilityPct)&&Number(e.volatilityPct)>Number(policy.maxVolatilityPct??4))veto.push('volatility-exceeds-policy');
 if(finite(e.liquidityUsd)&&Number(e.liquidityUsd)<Number(policy.minLiquidityUsd??10000))veto.push('insufficient-visible-liquidity');
 if(e.dataQuality!=='verified')veto.push('market-data-provider-not-verified');
 if(e.eventTimeReliable!==true)veto.push('event-time-ordering-not-verified');
 if(direction==='flat')veto.push('no-directional-consensus');
 if(confidence<Number(policy.minConfidence??.55))veto.push('confidence-below-policy');
 if(!input.riskContext)veto.push('portfolio-risk-context-unavailable');
 if(riskGate&&!riskGate.allowed)veto.push(...riskGate.violations.map(x=>'risk-gate:'+x.code.toLowerCase()));
 if(debate.riskVetoes.length)veto.push(...debate.riskVetoes.map(x=>'agent-debate:'+x.toLowerCase()));
 if(instrument.assetClass==='onchain'&&e.chainFinalityVerified!==true)veto.push('chain-finality-unverified');
 const eligible=veto.length===0;
 return {decisionId:input.decisionId||cryptoId(),instrument,generatedAt:isoNow(),eventTimestamp:e.timestamp||null,evidenceAgeMs:ageMs,
  direction,score:Number(score.toFixed(5)),confidence:Number(confidence.toFixed(4)),smc,smcEngine,regime,agentFleet,specialists,debate,riskGate,
  strategyFamilies:[...JPTI_STRATEGY_LIBRARY.map(x=>x.id)],veto,eligible,
  action:eligible?'PAPER_CANDIDATE':'ABSTAIN',executionPermission:'none',
  rationale:eligible?'Evidence passed the configured research gates. Candidate is eligible for paper simulation only.':'At least one data, session, strategy or risk gate failed; no order intent was created.'};
}
function cryptoId(){return globalThis.crypto?.randomUUID?.()||('ma3-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9));}
export function allocateAdaptiveCapital(candidates=[],portfolio={},policy={}) {
 const equity=Math.max(0,Number(portfolio.equityUsd)||0),maxRiskPct=clamp(policy.maxRiskPct??.25,.01,1),maxPortfolioRiskPct=clamp(policy.maxPortfolioRiskPct??1,.05,3);
 const drawdown=clamp(portfolio.drawdownPct||0,0,100),lossStreak=Math.max(0,Number(portfolio.lossStreak)||0);
 const survivalFactor=drawdown>=Number(policy.haltDrawdownPct??8)?0:clamp(1-drawdown/Math.max(1,Number(policy.haltDrawdownPct??8)),0,1);
 const streakFactor=lossStreak>=Number(policy.haltLossStreak??5)?0:clamp(1-lossStreak/Math.max(1,Number(policy.haltLossStreak??5)),0,1);
 const eligible=candidates.filter(x=>x?.eligible&&x.direction!=='flat'&&finite(x.confidence));
 const weights=eligible.map(x=>Math.max(.01,Number(x.confidence))*Math.max(.01,Number(x.edgeScore??x.confidence)));
 const total=weights.reduce((a,b)=>a+b,0),budgetUsd=equity*maxPortfolioRiskPct/100*survivalFactor*streakFactor;
 return {generatedAt:isoNow(),equityUsd:equity,portfolioRiskBudgetUsd:Number(budgetUsd.toFixed(2)),survivalFactor,streakFactor,
  allocations:eligible.map((x,i)=>{const share=total?weights[i]/total:0,riskUsd=Math.min(equity*maxRiskPct/100,budgetUsd*share);return{agentId:x.agentId||'unassigned',strategyId:x.strategyId||'unassigned',symbol:x.instrument?.symbol||x.symbol||'unknown',riskUsd:Number(riskUsd.toFixed(2)),riskPctOfEquity:equity?Number((riskUsd/equity*100).toFixed(4)):0,notionalCapUsd:Number((riskUsd/Math.max(.001,Number(x.stopDistancePct||1)/100)).toFixed(2)),paperOnly:true};}),
  blocked:survivalFactor===0||streakFactor===0,liveExecutionAuthorized:false};
}
export function evaluateStrategyLifecycle(metrics={},policy={}) {
 const trades=Math.max(0,Number(metrics.closedTrades)||0),expectancy=Number(metrics.expectancyR),pf=Number(metrics.profitFactor),dd=Number(metrics.maxDrawdownPct);
 const failures=[];
 if(trades<Number(policy.minTrades??30))failures.push('insufficient-forward-sample');
 if(!finite(metrics.expectancyR)||expectancy<=0)failures.push('non-positive-expectancy');
 if(!finite(metrics.profitFactor)||pf<Number(policy.minProfitFactor??1.1))failures.push('profit-factor-below-floor');
 if(!finite(metrics.maxDrawdownPct)||dd>Number(policy.maxDrawdownPct??8))failures.push('drawdown-limit-exceeded');
 if(metrics.dataIntegrity!=='verified')failures.push('data-integrity-not-verified');
 if(metrics.decayDetected===true)failures.push('forward-performance-decay');
 if(metrics.riskBreaches>0)failures.push('risk-breaches-detected');
 const status=failures.length?'quarantine-or-continue-observation':'eligible-for-controlled-requalification';
 return {status,failures,closedTrades:trades,requiresFreshOutOfSample:true,requiresHumanReview:true,liveExecutionAuthorized:false};
}
export function replayEventsByEventTime(events=[]) {
 return (Array.isArray(events)?events:[]).map((event,index)=>{const raw=event.eventTime??event.observedAt??event.timestamp??'';const eventTime=typeof raw==='number'?(raw<1e11?raw*1000:raw):Date.parse(raw);return {...event,_stableIndex:index,eventTime};})
  .filter(x=>Number.isFinite(x.eventTime)).sort((a,b)=>{
   const timeOrder=a.eventTime-b.eventTime;if(timeOrder)return timeOrder;
   const as=Number(a.sequence),bs=Number(b.sequence);
   if(Number.isFinite(as)&&Number.isFinite(bs)&&as!==bs)return as-bs;
   return a._stableIndex-b._stableIndex;
  })
  .map(({_stableIndex,...event})=>event);
}
export function compareVenueLiquidity(quotes=[],policy={}) {
 const valid=quotes.filter(q=>finite(q.bid)&&finite(q.ask)&&Number(q.bid)>0&&Number(q.ask)>Number(q.bid)&&Number.isFinite(Date.parse(q.timestamp))&&Date.now()-Date.parse(q.timestamp)<=Number(policy.maxAgeMs||5000)&&Date.now()-Date.parse(q.timestamp)>=-5000);
 const sorted=valid.map(q=>({...q,mid:(Number(q.bid)+Number(q.ask))/2,spreadBps:(Number(q.ask)-Number(q.bid))/((Number(q.ask)+Number(q.bid))/2)*10000,allInCostBps:Number(q.feeBps||0)+Number(q.slippageBps||0)+Number(q.transferCostBps||0)})).sort((a,b)=>a.mid-b.mid);
 if(sorted.length<2)return {status:'insufficient-venues',opportunity:null,quotes:sorted};
 const buy=[...sorted].sort((a,b)=>a.ask-b.ask)[0],sell=[...sorted].sort((a,b)=>b.bid-a.bid)[0],grossBps=(sell.bid-buy.ask)/buy.ask*10000,netBps=grossBps-buy.allInCostBps-sell.allInCostBps;
 return {status:netBps>Number(policy.minNetEdgeBps??5)?'research-opportunity':'no-net-edge',opportunity:netBps>0?{buyVenue:buy.venue,sellVenue:sell.venue,grossEdgeBps:Number(grossBps.toFixed(3)),netEdgeBps:Number(netBps.toFixed(3)),transferAndSettlementRisk:'must be separately validated',paperOnly:true}:null,quotes:sorted};
}
export function reconcileExecutionLedgers(backtest=[],paper=[],actual=[]) {
 const index=rows=>new Map(rows.map(x=>[String(x.tradeId||x.executionId||x.id),x]));
 const b=index(backtest),p=index(paper),a=index(actual),ids=new Set([...b.keys(),...p.keys(),...a.keys()]);
 const discrepancies=[];
 for(const id of ids){const rows=[b.get(id),p.get(id),a.get(id)].filter(Boolean);if(rows.length!==3){discrepancies.push({id,presence:{backtest:b.has(id),paper:p.has(id),actual:a.has(id)},reason:'record-missing-from-one-or-more-ledgers'});continue;}
  const pnl=rows.map(x=>Number(x.netPnl??x.pnl));if(pnl.some(x=>!Number.isFinite(x))||Math.max(...pnl)-Math.min(...pnl)>Number(policyTolerance()))discrepancies.push({id,reason:'net-pnl-mismatch-or-missing',values:pnl});
 }
 return {generatedAt:isoNow(),matched:ids.size-discrepancies.length,discrepancyCount:discrepancies.length,discrepancies,liveExecutionAuthorized:false};
}
function policyTolerance(){return .01;}
export function buildMultiAssetOverview() {
 return {version:'3.0.0',modules:MULTI_ASSET_MODULES.map(x=>({...x,instrumentCount:x.instruments.length,executionMode:'research-backtest-paper-only'})),
  squads:AGENT_SQUADS.map(s=>({...s,agents:s.agents.map(([name,role,specialty,timeframe])=>({id:name.toLowerCase(),name,role,specialty,timeframe,executionPermission:'none'}))})),
  strategyLibrary:JPTI_STRATEGY_LIBRARY,capabilities:['asset-class-normalization','SMC-BOS-CHOCH','liquidity-sweeps','fair-value-gaps','order-flow','session-intelligence','cross-venue-arbitrage-research','event-time-replay-ordering','adaptive-capital-budgeting','forward-decay-monitoring','strategy-quarantine','execution-ledger-reconciliation'],
  liveExecutionAuthorized:false,weekendTradingEnabled:false};
}
