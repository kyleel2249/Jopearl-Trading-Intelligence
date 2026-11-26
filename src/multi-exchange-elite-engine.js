// JPTI Multi-Exchange Elite Replication Engine. Research-only; never places orders.
const EXCHANGES=Object.freeze(['bitget','bybit','binance']);
const MARKET_TYPES=Object.freeze(['spot','usdt_perpetual','coin_perpetual','usdc_perpetual']);
const WINDOWS=Object.freeze(['7d','30d','90d','180d']);
const finite=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const round=(v,n=2)=>Number(v.toFixed(n));
const safe=(v,n=120)=>String(v??'').trim().slice(0,n);
const WEIGHTS=Object.freeze({winRateConsistency:15,riskAdjustedReturns:20,drawdownControl:20,netProfitability:15,periodConsistency:15,executionQuality:5,historyAndSample:10});
export const MULTI_EXCHANGE_POLICY=Object.freeze({version:'1.0.0',exchanges:EXCHANGES,marketTypes:MARKET_TYPES,requiredWindows:WINDOWS,minimumTrades:100,minimumHistoryDays:90,maximumDrawdownPct:25,minimumScore:80,minimumWindowCoverage:3,maximumSourceAgeMs:21600000,maximumCandidates:300,selectionsPerExchange:10,scoreWeights:WEIGHTS,executionMode:'paper-only',liveExecutionAuthorized:false});
const cross=[
 ['MX-01','Cross-Exchange Trader Hunter','discover and deduplicate trader identities'],
 ['MX-02','Exchange Performance Auditor','audit source provenance and metric integrity'],
 ['MX-03','Trader Reliability Predictor','measure rolling stability and deterioration'],
 ['MX-04','Cross-Exchange Strategy Matcher','fingerprint and match trader behaviour'],
 ['MX-05','Capital Allocation Optimizer','simulate risk-budget allocations without orders'],
 ['MX-06','Correlation & Exposure Analyst','detect duplicated and correlated exposures'],
 ['MX-07','Execution Quality Analyst','compare fill quality and slippage evidence'],
 ['MX-08','Fee & Funding Intelligence','normalize fee and funding costs'],
 ['MX-09','Strategy Transfer Learning','test strategy portability across venues'],
 ['MX-10','Exchange Arbitrage Intelligence','flag venue price and funding dispersion'],
 ['MX-11','Replica Competition Manager','track paper replica promotion and demotion'],
 ['MX-12','Global Risk Supervisor','veto candidates breaching global risk policy']
];
const venue={
 bitget:[['BG-01','Bitget Elite Hunter'],['BG-02','Bitget Futures Analyst'],['BG-03','Bitget Spot Analyst'],['BG-04','Bitget Copier Outcome Auditor']],
 bybit:[['BY-01','Bybit Lead Trader Analyst'],['BY-02','Bybit Copy Profile Auditor'],['BY-03','Bybit Derivatives Specialist'],['BY-04','Bybit Spot Strategy Analyst']],
 binance:[['BN-01','Binance Lead Trader Analyst'],['BN-02','Binance Spot Copy Auditor'],['BN-03','Binance Futures Specialist'],['BN-04','Binance Portfolio Strategy Analyst']]
};
export const MULTI_EXCHANGE_AGENTS=Object.freeze([...cross.map(([id,name,mandate])=>({id,name,mandate,scope:'cross-exchange',executionPermission:'none'})),...Object.entries(venue).flatMap(([exchange,agents])=>agents.map(([id,name])=>({id,name,exchange,scope:'venue-specialist',mandate:'venue-specific trader discovery, source and market-type analysis',executionPermission:'none'})))]);
export const EXCHANGE_SOURCE_REGISTRY=Object.freeze({
 bitget:{name:'Bitget',leaderboard:'provider export or approved feed adapter',publicTraderFeed:'not-configured',privateCopyTrading:'not-connected',markets:['spot','usdt_perpetual','coin_perpetual','usdc_perpetual'],adapterMode:'import-only'},
 bybit:{name:'Bybit',leaderboard:'official copy-trading profile export or approved feed adapter',publicTraderFeed:'not-configured',privateCopyTrading:'not-connected',markets:['spot','usdt_perpetual'],adapterMode:'import-only'},
 binance:{name:'Binance',leaderboard:'official Spot/Futures Copy Trading profile export or approved feed adapter',publicTraderFeed:'not-configured',privateCopyTrading:'not-connected',markets:['spot','usdt_perpetual','coin_perpetual'],adapterMode:'import-only'}
});
const wm=(c,w,k)=>finite(c.windows?.[w]?.[k]);
function stability(c){
 const complete=WINDOWS.filter(w=>wm(c,w,'roiPct')!==null&&wm(c,w,'winRatePct')!==null&&wm(c,w,'maxDrawdownPct')!==null);
 const values=complete.map(w=>wm(c,w,'roiPct'));
 if(values.length<2)return {score:0,coverage:values.length,completeWindows:complete,incompleteWindows:WINDOWS.filter(w=>!complete.includes(w)),positiveRatio:0,dispersion:null};
 const mean=values.reduce((a,b)=>a+b,0)/values.length,variance=values.reduce((a,b)=>a+(b-mean)**2,0)/values.length;
 const dispersion=Math.sqrt(variance)/(Math.abs(mean)+1),positiveRatio=values.filter(v=>v>0).length/values.length;
 return {score:clamp(.65*positiveRatio+.35*(1-clamp(dispersion))),coverage:values.length,completeWindows:complete,incompleteWindows:WINDOWS.filter(w=>!complete.includes(w)),positiveRatio,dispersion:round(dispersion,4)};
}
function style(hours){if(hours===null)return 'unclassified';if(hours<=1)return 'scalping';if(hours<=24)return 'day-trading';if(hours<=168)return 'swing';return 'position-trading';}
function validate(c,now){
 const errors=[],exchange=safe(c.exchange,20).toLowerCase(),marketType=safe(c.marketType||c.market_type,30).toLowerCase();
 const traderId=safe(c.traderId||c.id),source=safe(c.source),retrieved=Date.parse(c.retrievedAt||c.retrieved_at||'');
 if(!EXCHANGES.includes(exchange))errors.push('unsupported_exchange');
 if(!MARKET_TYPES.includes(marketType))errors.push('unsupported_market_type');
 if(exchange&&EXCHANGE_SOURCE_REGISTRY[exchange]&&!EXCHANGE_SOURCE_REGISTRY[exchange].markets.includes(marketType))errors.push('market_type_not_supported_by_exchange');
 if(!traderId)errors.push('missing_trader_id');if(!source)errors.push('missing_source');
 if(!Number.isFinite(retrieved)||now-retrieved>21600000||retrieved>now+60000)errors.push('stale_or_missing_source_timestamp');
 if(c.sourceUrl){try{const u=new URL(c.sourceUrl);if(!['https:','http:'].includes(u.protocol))errors.push('invalid_source_url');}catch{errors.push('invalid_source_url');}}
 const trades=finite(c.totalTrades),history=finite(c.historyDays),winRate=wm(c,'90d','winRatePct'),drawdown=wm(c,'90d','maxDrawdownPct'),roi=wm(c,'90d','roiPct'),profitFactor=wm(c,'90d','profitFactor'),sharpe=wm(c,'90d','sharpe'),sortino=wm(c,'90d','sortino'),copierPnl=wm(c,'90d','copierPnlUsd'),averageHoldingHours=finite(c.averageHoldingHours),maxLeverage=finite(c.maxLeverage);
 const invalid=[];
 if(trades!==null&&(!Number.isInteger(trades)||trades<0))invalid.push('totalTrades');
 if(history!==null&&history<0)invalid.push('historyDays');
 if(winRate!==null&&(winRate<0||winRate>100))invalid.push('winRatePct');
 if(drawdown!==null&&(drawdown<0||drawdown>100))invalid.push('maxDrawdownPct');
 if(averageHoldingHours!==null&&averageHoldingHours<0)invalid.push('averageHoldingHours');
 if(maxLeverage!==null&&(maxLeverage<0||maxLeverage>500))invalid.push('maxLeverage');
 if(profitFactor!==null&&profitFactor<0)invalid.push('profitFactor');
 if(sharpe!==null&&Math.abs(sharpe)>100)invalid.push('sharpe');
 if(sortino!==null&&Math.abs(sortino)>100)invalid.push('sortino');
 for(const w of WINDOWS)for(const k of ['roiPct','winRatePct','maxDrawdownPct','copierPnlUsd','profitFactor','sharpe','sortino']){
  const value=wm(c,w,k);if(value===null)continue;
  if(k==='winRatePct'&&(value<0||value>100))invalid.push(w+'.'+k);
  if(k==='maxDrawdownPct'&&(value<0||value>100))invalid.push(w+'.'+k);
  if(k==='profitFactor'&&value<0)invalid.push(w+'.'+k);
 }
 return {exchange,marketType,traderId,source,retrieved,trades,history,winRate,drawdown,roi,profitFactor,sharpe,sortino,copierPnl,averageHoldingHours,maxLeverage,invalid:[...new Set(invalid)],errors};
}
export function assessMultiExchangeTrader(raw={},now=Date.now()){
 const c=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{},v=validate(c,now),ws=stability(c),missing=[];
 for(const [k,value] of Object.entries({totalTrades:v.trades,historyDays:v.history,winRatePct:v.winRate,maxDrawdownPct:v.drawdown,roiPct:v.roi}))if(value===null)missing.push(k);
 const components={
  winRateConsistency:v.winRate===null?0:clamp((v.winRate-35)/35)*.6+ws.score*.4,
  riskAdjustedReturns:clamp(((v.sharpe??0)*.45+(v.sortino??0)*.35+Math.min(v.profitFactor??0,4)*.2)/4),
  drawdownControl:v.drawdown===null?0:clamp(1-v.drawdown/35),
  netProfitability:v.roi===null?0:clamp((v.roi+5)/35),
  periodConsistency:ws.score,
  executionQuality:finite(c.averageSlippageBps)===null?0:clamp(1-Math.max(0,finite(c.averageSlippageBps))/100),
  historyAndSample:v.trades===null||v.history===null?0:clamp(Math.min(v.trades/400,v.history/240))
 };
 const score=round(Object.entries(WEIGHTS).reduce((sum,[key,weight])=>sum+components[key]*weight,0),2);
 const gates=[
  [v.errors.length===0,'source_or_exchange_integrity_failed'],
  [v.trades!==null&&v.trades>=100,'insufficient_trade_sample'],
  [v.history!==null&&v.history>=90,'insufficient_history'],
  [v.drawdown!==null&&v.drawdown<=25,'drawdown_limit_exceeded'],
  [v.roi!==null&&v.roi>0,'non_positive_90d_roi'],
  [ws.coverage>=3,'insufficient_window_coverage'],
  [missing.length===0,'missing_required_metrics'],
  [v.invalid.length===0,'invalid_metric_ranges'],
  [c.sourceAttested===true,'source_not_attested_by_operator']
 ];
 const failed=gates.filter(([ok])=>!ok).map(([,reason])=>reason),eligible=failed.length===0&&score>=80;
 const positions=Array.isArray(c.positions)?c.positions.slice(0,100).map(p=>({symbol:safe(p.symbol,40).toUpperCase(),side:safe(p.side,12).toLowerCase(),notionalUsd:finite(p.notionalUsd),leverage:finite(p.leverage)})):[];
 const riskFlags=[...(v.drawdown!==null&&v.drawdown>15?['elevated_drawdown']:[]),...(v.winRate!==null&&v.winRate>90&&v.trades!==null&&v.trades<300?['win_rate_sample_warning']:[]),...(v.maxLeverage!==null&&v.maxLeverage>10?['high_leverage']:[]),...(finite(c.averageSlippageBps)!==null&&finite(c.averageSlippageBps)>30?['high_slippage']:[]),...(finite(c.fundingCostPct)!==null&&finite(c.fundingCostPct)>1?['high_funding_cost']:[]),...(c.recoveryTrading===true?['possible_recovery_trading']:[]),...(c.concentratedExposure===true?['concentrated_exposure']:[])];
 const fingerprint=[v.exchange,v.marketType,style(v.averageHoldingHours),safe(c.directionBias||'mixed',16).toLowerCase(),v.maxLeverage===null?'leverage-unknown':v.maxLeverage<=3?'low-leverage':v.maxLeverage<=10?'moderate-leverage':'high-leverage'].join('|');
 return {traderId:v.traderId||null,displayName:safe(c.displayName||c.nickname||v.traderId||'Unidentified trader'),exchange:v.exchange||null,marketType:v.marketType||null,source:v.source||null,sourceUrl:c.sourceUrl?String(c.sourceUrl).slice(0,500):null,retrievedAt:Number.isFinite(v.retrieved)?new Date(v.retrieved).toISOString():null,score,grade:score>=95?'exceptional':score>=90?'elite':score>=85?'advanced':score>=80?'qualified':'not-qualified',eligible,status:eligible?'eligible':'rejected_or_unverified',failedGates:failed,missingMetrics:missing,invalidMetrics:v.invalid,components:Object.fromEntries(Object.entries(components).map(([k,x])=>[k,round(x,4)])),metrics:{totalTrades:v.trades,historyDays:v.history,winRatePct:v.winRate,maxDrawdownPct:v.drawdown,roiPct:v.roi,profitFactor:v.profitFactor,sharpe:v.sharpe,sortino:v.sortino,copierPnlUsd:v.copierPnl,averageHoldingHours:v.averageHoldingHours,maxLeverage:v.maxLeverage,averageSlippageBps:finite(c.averageSlippageBps),fundingCostPct:finite(c.fundingCostPct)},windowCoverage:ws.coverage,windowStability:ws,style:style(v.averageHoldingHours),strategyFingerprint:fingerprint,positions,riskFlags,provenance:{verified:false,sourceAttested:c.sourceAttested===true,independentlyReconciled:false,sourceMethod:safe(c.sourceMethod||'manual-import',40),warning:'Provider statistics remain unverified until reconciled against authoritative exchange or account records.'}};
}
function collisionAnalysis(items){
 const rows=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i],b=items[j];if(a.exchange===b.exchange)continue;const left=new Map(a.positions.filter(p=>p.symbol&&p.side).map(p=>[p.symbol,p.side]));const shared=b.positions.filter(p=>p.symbol&&p.side&&left.has(p.symbol));const same=shared.filter(p=>left.get(p.symbol)===p.side).length,opposite=shared.length-same;if(shared.length)rows.push({leftTraderId:a.traderId,rightTraderId:b.traderId,leftExchange:a.exchange,rightExchange:b.exchange,sharedSymbols:shared.map(p=>p.symbol),sameDirection:same,opposingDirection:opposite,classification:opposite?'cross-venue-direction-conflict':'duplicated-cross-venue-exposure'});}
 return rows.slice(0,200);
}
export function rankMultiExchangeTraders(candidates=[],now=Date.now()){
 const bounded=Array.isArray(candidates)?candidates.slice(0,300):[],seen=new Set(),unique=[],duplicates=[];
 bounded.sort((a,b)=>Date.parse(b.retrievedAt||b.retrieved_at||'')-Date.parse(a.retrievedAt||a.retrieved_at||''));
 for(const c of bounded){const key=safe(c.exchange,20).toLowerCase()+':'+safe(c.marketType||c.market_type,30).toLowerCase()+':'+safe(c.traderId||c.id);if(seen.has(key)){duplicates.push(key);continue;}seen.add(key);unique.push(c);}
 const assessments=unique.map(c=>assessMultiExchangeTrader(c,now)),boards={};
 for(const exchange of EXCHANGES)for(const marketType of MARKET_TYPES){const group=assessments.filter(x=>x.exchange===exchange&&x.marketType===marketType).sort((a,b)=>b.score-a.score);if(group.length)boards[exchange+':'+marketType]={exchange,marketType,candidateCount:group.length,eligibleCount:group.filter(x=>x.eligible).length,selected:group.filter(x=>x.eligible).slice(0,10).map((x,i)=>({...x,rank:i+1,replicaMode:'paper',allocationPct:0}))};}
 const eligible=assessments.filter(x=>x.eligible).sort((a,b)=>b.score-a.score),selected=eligible.slice(0,30).map((x,i)=>({...x,globalResearchRank:i+1,replicaMode:'paper',allocationPct:0}));
 const collisions=collisionAnalysis(eligible),clusters={};for(const item of assessments)(clusters[item.strategyFingerprint]??=[]).push(item.traderId);
 return {id:globalThis.crypto?.randomUUID?.()||('mx-'+now+'-'+assessments.length),generatedAt:new Date(now).toISOString(),policy:MULTI_EXCHANGE_POLICY,agents:MULTI_EXCHANGE_AGENTS,candidateCount:assessments.length,eligibleCount:eligible.length,selectedCount:selected.length,exchangeSummary:Object.fromEntries(EXCHANGES.map(exchange=>[exchange,{candidateCount:assessments.filter(x=>x.exchange===exchange).length,eligibleCount:assessments.filter(x=>x.exchange===exchange&&x.eligible).length,feedStatus:'manual-import-only'}])),boards,selected,assessments:assessments.sort((a,b)=>b.score-a.score),strategyClusters:Object.entries(clusters).map(([fingerprint,traderIds])=>({fingerprint,traderIds,count:traderIds.length})),crossExchangeCollisions:collisions,intelligenceEvents:[{kind:'multi-exchange-elite-ranking',exchange:'all',candidateCount:assessments.length,eligibleCount:eligible.length},{kind:'cross-exchange-strategy-fingerprint',clusterCount:Object.keys(clusters).length},{kind:'cross-exchange-exposure-collision',collisionCount:collisions.length}],execution:{mode:'paper-only',liveExecutionAuthorized:false,ordersCreated:0,capitalAllocated:0,blockers:['No verified public trader leaderboard feed is configured for any exchange.','Private copy-trading credentials and order adapters are not connected.','Independent reconciliation and operator approval are required before live execution.']},audit:{scoreIsRankingHeuristic:true,exchangeScoresAreResearchComparisons:true,sourceMethodsMayDiffer:true,profitabilityGuaranteed:false,metricsIndependentlyVerified:false,duplicateCandidatesRemoved:duplicates.length,duplicateKeys:duplicates}};
}
export function getMultiExchangeStatus(env={}){return {system:'JPTI Multi-Exchange Elite Replication System',version:MULTI_EXCHANGE_POLICY.version,exchanges:Object.entries(EXCHANGE_SOURCE_REGISTRY).map(([id,meta])=>({...meta,feedConfigured:Boolean(env['JPTI_'+id.toUpperCase()+'_ELITE_FEED_URL']),credentialsConfigured:false,scheduledMonitoringConfigured:false,executionMode:'paper-only'})),agents:MULTI_EXCHANGE_AGENTS,policy:MULTI_EXCHANGE_POLICY,integrations:{sharedIntelligenceMemory:'ranking events are published to D1 event stream',riskCommandCentre:'risk findings are published to D1 event stream',strategyResearchLab:'strategy fingerprints included in ranking snapshots',liveTrading:'disabled'}}};}
