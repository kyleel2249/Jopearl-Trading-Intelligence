// Normalise DEX pool and confirmed swap evidence before it reaches chart confluence.
// A symbol match is not proof of token identity; the upstream pool is retained with chain and contract provenance.
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const num=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const round=(v,n=4)=>Number.isFinite(v)?Number(v.toFixed(n)):null;
const parseTime=v=>{const n=num(v);if(n!==null)return n>1e12?n:n*1000;const p=Date.parse(v||'');return Number.isFinite(p)?p:null;};

export function scoreChainDexContext(context,{now=Date.now(),maxAgeMs=180000}={}){
 if(!context||typeof context!=='object')return{status:'unavailable',score:0,confidence:0,evidence:[],reason:'No DEX context supplied',sources:[]};
 const generatedAt=parseTime(context.generatedAt),ageMs=generatedAt===null?null:Math.max(0,now-generatedAt);
 const sources=Array.isArray(context.sources)?context.sources:[];
 const live=sources.filter(s=>s&&s.status==='live').length;
 const named=sources.filter(s=>s&&s.name).length;
 if(ageMs===null||ageMs>maxAgeMs||generatedAt>now+60000)return{status:'stale',score:0,confidence:0,ageMs,evidence:[],sources,reason:ageMs===null?'DEX timestamp missing':'DEX evidence is stale or timestamp is in the future'};
 const flow=context.flow||{},buy=num(flow.buyUsd),sell=num(flow.sellUsd),buyCount=num(flow.buys),sellCount=num(flow.sells);
 const evidence=[];
 const add=(factor,value,weight,basis)=>{if(!Number.isFinite(value))return;evidence.push({factor,value:round(clamp(value,-1,1)),weight,contribution:round(clamp(value,-1,1)*weight),basis});};
 const usdTotal=(buy||0)+(sell||0);
 if(usdTotal>0)add('measured-or-estimated-dex-buy-sell-flow',(buy-sell)/usdTotal,0.55,flow.basis||'unknown');
 else if(buyCount!==null&&sellCount!==null&&buyCount+sellCount>0)add('dex-buy-sell-transaction-count',(buyCount-sellCount)/(buyCount+sellCount),0.25,'dexscreener-transaction-counts');
 const pools=Array.isArray(context.pools)?context.pools:[];
 const liq=pools.map(p=>num(p.liquidityUsd)).filter(v=>v!==null&&v>0);
 const vol=pools.map(p=>num(p.volume24hUsd)).filter(v=>v!==null&&v>=0);
 if(liq.length&&vol.length){const ratio=vol.reduce((a,b)=>a+b,0)/Math.max(1,liq.reduce((a,b)=>a+b,0));add('dex-turnover-to-liquidity',clamp((ratio-0.5)/2,-1,1),0.15,'dexscreener-pool-volume-and-liquidity');}
 const priceChanges=pools.map(p=>num(p.priceChange24hPct)).filter(v=>v!==null);
 if(priceChanges.length)add('dex-pool-24h-price-change',clamp(priceChanges.reduce((a,b)=>a+b,0)/priceChanges.length/8,-1,1),0.2,'dexscreener-pool-price-change');
 const used=evidence.reduce((s,x)=>s+x.weight,0);
 const score=used?evidence.reduce((s,x)=>s+x.contribution,0)/used:0;
 const trades=Array.isArray(context.trades)?context.trades:[];
 const measured=trades.filter(t=>t&&t.basis==='geckoterminal-confirmed-swap').length;
 const poolCoverage=pools.length?Math.min(1,pools.filter(p=>num(p.liquidityUsd)>0).length/3):0;
 const sourceCoverage=named?live/named:(pools.length?0.5:0);
 const freshness=clamp(1-ageMs/maxAgeMs,0,1);
 const tradeQuality=measured?clamp(measured/20,0.25,1):0.25;
 const confidence=round(clamp(sourceCoverage*0.35+freshness*0.2+poolCoverage*0.2+tradeQuality*0.25,0,1));
 const available=evidence.length>0&&(!named||live>0);
 return{status:available?'ready':'unavailable',score:available?round(score):0,confidence:available?confidence:0,ageMs,sourceCoverage:round(sourceCoverage),poolCoverage:round(poolCoverage),measuredTrades:measured,evidence:available?evidence:[],sources,poolCount:pools.length,tradeCount:trades.length,flow:{buyUsd:round(buy||0,2),sellUsd:round(sell||0,2),netUsd:round((buy||0)-(sell||0),2),imbalancePct:usdTotal?round((buy-sell)/usdTotal*100,2):buyCount+sellCount>0?round((buyCount-sellCount)/(buyCount+sellCount)*100,2):null,basis:flow.basis||'unavailable'},reason:available?null:'No live DEX evidence source is available',method:'DEX pool and swap evidence is source-attributed, timestamp-gated and excluded when stale; confidence reflects source coverage, pool coverage and actual swap sample size'};
}

export function normaliseDexTrade(raw,{baseIsTarget=true,chainId='',poolAddress='',dexId=''}={}){
 const a=raw?.attributes||raw||{},timestamp=parseTime(a.block_timestamp||a.timestamp||a.created_at);
 const kind=String(a.kind||a.side||'').toLowerCase();
 if(timestamp===null||!['buy','sell'].includes(kind))return null;
 const side=baseIsTarget?kind:(kind==='buy'?'sell':'buy');
 const txHash=String(a.tx_hash||a.transaction_hash||a.hash||'').trim();
 const amountUsd=num(a.volume_in_usd??a.amount_usd??a.volumeUsd);
 if(!txHash||amountUsd===null||amountUsd<0)return null;
 return{id:[chainId,poolAddress,txHash].join(':'),txHash,chainId,poolAddress,dexId,side,amountUsd:round(amountUsd,2),tokenAmount:num(a.from_token_amount??a.token_amount),priceUsd:num(a.price_from_in_usd??a.price_to_in_usd??a.price_usd),trader:String(a.tx_from_address||a.from_address||'').slice(0,120)||null,timestamp,occurredAt:new Date(timestamp).toISOString(),basis:'geckoterminal-confirmed-swap',source:'GeckoTerminal'};
}
