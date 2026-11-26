export const MICROSTRUCTURE_EXCHANGES = Object.freeze(['binance','bybit','okx','bitget']);
export const MICROSTRUCTURE_KINDS = Object.freeze(['orderbook','trade','funding','open_interest','liquidation']);
const SYMBOL_RE=/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}(?::[A-Z0-9._-]{2,20})?$/;
const n=v=>v===null||v===undefined||v===''?null:Number.isFinite(Number(v))?Number(v):null;
const iso=v=>{const x=n(v);if(!(x>0))return null;const d=new Date(x<1e12?x*1000:x);return Number.isNaN(d.getTime())?null:d.toISOString();};
export function normalizeMicrostructurePlan(input={}){
 const exchanges=[...new Set((Array.isArray(input.exchanges)?input.exchanges:MICROSTRUCTURE_EXCHANGES).map(x=>String(x).toLowerCase()).filter(x=>MICROSTRUCTURE_EXCHANGES.includes(x)))].slice(0,4);
 const symbols=[...new Set((Array.isArray(input.symbols)?input.symbols:['BTC/USDT','ETH/USDT']).map(x=>String(x).trim().toUpperCase()).filter(x=>SYMBOL_RE.test(x)))].slice(0,8);
 const kinds=[...new Set((Array.isArray(input.kinds)?input.kinds:MICROSTRUCTURE_KINDS).map(x=>String(x).toLowerCase()).filter(x=>MICROSTRUCTURE_KINDS.includes(x)))].slice(0,5);
 const marketType=String(input.marketType||'spot').toLowerCase();
 if(!exchanges.length||!symbols.length||!kinds.length)throw Object.assign(new Error('Select at least one supported exchange, symbol and observation kind.'),{status:400});
 if(!['spot','margin','usdt-m','coin-m','usdc-m'].includes(marketType))throw Object.assign(new Error('marketType must be spot, usdt-m, coin-m or usdc-m.'),{status:400});
 return {exchanges,symbols,kinds,marketType,depthLimit:Math.max(5,Math.min(100,Number(input.depthLimit)||20)),tradeLimit:Math.max(10,Math.min(100,Number(input.tradeLimit)||50)),maxRequests:Math.max(1,Math.min(24,Number(input.maxRequests)||24))};
}
export function buildMicrostructureUrl(exchange,symbol,kind,marketType='spot',limit=50){
 const [pair]=symbol.split(':');const [base,quote]=pair.split('/');
 const bitgetSymbol=base+quote, okxSpot=base+'-'+quote, okxSwap=base+'-'+quote+'-SWAP';
 const derivative=['usdt-m','coin-m','usdc-m'].includes(marketType);
 if(exchange==='binance'){
  const sym=base+quote,host=marketType==='coin-m'?'dapi.binance.com':derivative?'fapi.binance.com':'api.binance.com',prefix=marketType==='coin-m'?'/dapi/v1/':derivative?'/fapi/v1/':'/api/v3/';
  if(kind==='orderbook')return 'https://'+host+prefix+'depth'+'?symbol='+sym+'&limit='+limit;
  if(kind==='trade')return 'https://'+host+prefix+'aggTrades'+'?symbol='+sym+'&limit='+limit;
  if(kind==='funding')return 'https://'+host+prefix+'fundingRate?symbol='+sym+'&limit=20';
  if(kind==='open_interest')return 'https://'+host+prefix+'openInterest?symbol='+sym;
  if(kind==='liquidation')return null;
 }
 if(exchange==='bybit'){
  const category=derivative?(marketType==='coin-m'?'inverse':'linear'):'spot',sym=base+quote;
  if(kind==='orderbook')return 'https://api.bybit.com/v5/market/orderbook?category='+category+'&symbol='+sym+'&limit=50';
  if(kind==='trade')return 'https://api.bybit.com/v5/market/recent-trade?category='+category+'&symbol='+sym+'&limit='+Math.min(100,limit);
  if(kind==='funding')return 'https://api.bybit.com/v5/market/funding/history?category='+category+'&symbol='+sym+'&limit=20';
  if(kind==='open_interest')return 'https://api.bybit.com/v5/market/open-interest?category='+category+'&symbol='+sym+'&intervalTime=5min&limit=20';
 }
 if(exchange==='okx'){
  const inst=derivative?okxSwap:okxSpot;
  if(kind==='orderbook')return 'https://www.okx.com/api/v5/market/books?instId='+inst+'&sz='+Math.min(400,limit);
  if(kind==='trade')return 'https://www.okx.com/api/v5/market/trades?instId='+inst+'&limit='+Math.min(500,limit);
  if(kind==='funding')return 'https://www.okx.com/api/v5/public/funding-rate-history?instId='+inst+'&limit=20';
  if(kind==='open_interest')return 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId='+inst;
  if(kind==='liquidation')return 'https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&uly='+base+'-'+quote+'&state=filled&limit=20';
 }
 if(exchange==='bitget'){
  const product=marketType==='coin-m'?'COIN-FUTURES':marketType==='usdc-m'?'USDC-FUTURES':'USDT-FUTURES';
  if(kind==='orderbook')return derivative?'https://api.bitget.com/api/v2/mix/market/merge-depth?productType='+product+'&symbol='+bitgetSymbol+'&limit='+Math.min(100,limit):'https://api.bitget.com/api/v2/spot/market/orderbook?symbol='+bitgetSymbol+'&limit='+Math.min(150,limit);
  if(kind==='trade')return derivative?'https://api.bitget.com/api/v2/mix/market/fills?productType='+product+'&symbol='+bitgetSymbol+'&limit='+Math.min(100,limit):'https://api.bitget.com/api/v2/spot/market/fills?symbol='+bitgetSymbol+'&limit='+Math.min(100,limit);
  if(kind==='funding')return 'https://api.bitget.com/api/v2/mix/market/history-fund-rate?productType='+product+'&symbol='+bitgetSymbol+'&pageSize=20';
  if(kind==='open_interest')return 'https://api.bitget.com/api/v2/mix/market/open-interest?productType='+product+'&symbol='+bitgetSymbol;
 }
 return null;
}
function rowsOf(payload){if(Array.isArray(payload))return payload;if(Array.isArray(payload?.data)){if(payload.data[0]?.details&&Array.isArray(payload.data[0].details))return payload.data.flatMap(x=>x.details);return payload.data;}if(Array.isArray(payload?.result?.list))return payload.result.list;if(Array.isArray(payload?.result))return payload.result;if(payload?.data&&typeof payload.data==='object')return [payload.data];if(payload?.result&&typeof payload.result==='object')return [payload.result];return [payload];}
export function normalizeMicrostructurePayload({exchange,symbol,marketType,kind,payload,receivedAt=Date.now()}){
 if(!payload||typeof payload!=='object')return [];
 const stamp=iso(receivedAt),out=[];
 const push=(id,observedAt,data,quality={})=>{const sourceTime=iso(observedAt),at=sourceTime||stamp;out.push({exchange,symbol,marketType,kind,eventId:String(id??at),observedAt:at,receivedAt:stamp,payload:data,quality:{...quality,sourceTimestampPresent:!!sourceTime}});};
 if(kind==='orderbook'){
  const raw=payload.result||payload.data||payload;const data=Array.isArray(raw)?raw[0]||{}:raw;
  const bids=data.b||data.bids||data.asks&&data.bids||[],asks=data.a||data.asks||[];
  const clean=levels=>(Array.isArray(levels)?levels:[]).slice(0,100).map(x=>[n(x[0]??x.price),n(x[1]??x.size??x.qty)]).filter(x=>x[0]>0&&x[1]>=0);
  const bid=clean(bids),ask=clean(asks),bestBid=bid.length?Math.max(...bid.map(x=>x[0])):null,bestAsk=ask.length?Math.min(...ask.map(x=>x[0])):null;
  if(bid.length||ask.length){const bidQty=bid.reduce((s,x)=>s+x[1],0),askQty=ask.reduce((s,x)=>s+x[1],0),bidNotional=bid.reduce((s,x)=>s+x[0]*x[1],0),askNotional=ask.reduce((s,x)=>s+x[0]*x[1],0),spread=bestBid&&bestAsk?bestAsk-bestBid:null,midPrice=bestBid&&bestAsk?(bestBid+bestAsk)/2:null;push(data.ts||data.timestamp||payload.ts||receivedAt,data.ts||data.timestamp||payload.ts||null,{bids:bid,asks:ask,bestBid,bestAsk,spread,midPrice,spreadBps:spread!==null&&midPrice>0?spread/midPrice*10000:null,bidQty,askQty,bidNotional,askNotional,depth:bid.length+ask.length,depthImbalance:bidQty+askQty?(bidQty-askQty)/(bidQty+askQty):null,notionalImbalance:bidNotional+askNotional?(bidNotional-askNotional)/(bidNotional+askNotional):null},{validLevels:true,crossed:!!(bestBid&&bestAsk&&bestBid>=bestAsk)});}
 }else{
  for(const row of rowsOf(payload)){
   let id,time,data;
   if(kind==='trade'){
    id=row.execId||row.tradeId||row.id||row.a||row.ts+'-'+row.price+'-'+row.size;time=row.time||row.ts||row.T||row.timestamp;
    data={price:n(row.price||row.p),quantity:n(row.size||row.qty||row.q||row.sz),side:String(row.side||(row.m===true?'sell':row.m===false?'buy':'unknown')).toLowerCase(),tradeId:String(id),quoteQuantity:n(row.price||row.p)*n(row.size||row.qty||row.q||row.sz)};
    if(!(data.price>0&&data.quantity>0))continue;
   }else if(kind==='funding'){
    id=row.fundingRateTimestamp||row.fundingTime||row.fundingRateTime||row.ts||row.id;time=id;
    data={rate:n(row.fundingRate??row.fundingRateValue??row.fundingRate),fundingTime:iso(time),symbol:row.symbol||symbol};
    if(data.rate===null)continue;
   }else if(kind==='open_interest'){
    id=row.timestamp||row.ts||row.time||row.symbol||receivedAt;time=row.timestamp||row.ts||row.time;
    data={openInterest:n(row.openInterest??row.openInterestValue??row.oi??row.openInterestList?.[0]?.openInterest??row.openInterestList?.[0]?.size??row.openInterestList?.[0]?.amount),openInterestValue:n(row.openInterestValue),unit:row.unit||null,symbol:row.symbol||symbol};
    if(data.openInterest===null)continue;
   }else if(kind==='liquidation'){
    id=row.orderId||row.ts+'-'+row.price+'-'+row.size;time=row.updatedTime||row.ts||row.time;
    data={side:String(row.side||row.S||'unknown').toLowerCase(),price:n(row.price||row.p||row.bkPx),quantity:n(row.qty||row.size||row.sz),notional:n(row.price||row.p||row.bkPx)*n(row.qty||row.size||row.sz),orderId:String(id)};
    if(!(data.price>0&&data.quantity>0))continue;
   }
   push(id,time,data,{validated:true});
  }
 }
 return out;
}
export function microstructureObservationKey(row){return [row.exchange,row.marketType,row.symbol,row.kind,row.eventId].map(x=>encodeURIComponent(String(x??''))).join('|');}

export function summarizeMicrostructureObservations(observations=[]){
 const books=new Map(),trades=new Map(),funding=new Map(),interest=new Map(),liquidations=new Map();
 const key=row=>row.exchange+'|'+row.marketType+'|'+row.symbol;
 for(const row of observations){
  const k=key(row),p=row.payload||{};
  if(row.kind==='orderbook')books.set(k,{exchange:row.exchange,marketType:row.marketType,symbol:row.symbol,observedAt:row.observedAt,bestBid:p.bestBid,bestAsk:p.bestAsk,spreadBps:p.spreadBps,depthImbalance:p.depthImbalance,notionalImbalance:p.notionalImbalance,crossed:!!row.quality?.crossed});
  if(row.kind==='trade'){const x=trades.get(k)||{exchange:row.exchange,marketType:row.marketType,symbol:row.symbol,trades:0,buyVolume:0,sellVolume:0,buyNotional:0,sellNotional:0};const qty=Number(p.quantity)||0,notional=Number(p.quoteQuantity)||Number(p.price)*qty;x.trades++;if(p.side==='buy'){x.buyVolume+=qty;x.buyNotional+=notional;}else if(p.side==='sell'){x.sellVolume+=qty;x.sellNotional+=notional;}trades.set(k,x);}
  if(row.kind==='funding'){const x=funding.get(k)||{exchange:row.exchange,marketType:row.marketType,symbol:row.symbol,rates:[]};if(Number.isFinite(Number(p.rate)))x.rates.push(Number(p.rate));funding.set(k,x);}
  if(row.kind==='open_interest'){const current=interest.get(k);if(!current||Date.parse(row.observedAt)>=Date.parse(current.observedAt))interest.set(k,{exchange:row.exchange,marketType:row.marketType,symbol:row.symbol,openInterest:p.openInterest,observedAt:row.observedAt});}
  if(row.kind==='liquidation'){const x=liquidations.get(k)||{exchange:row.exchange,marketType:row.marketType,symbol:row.symbol,events:0,sellSideNotional:0,buySideNotional:0};x.events++;if(p.side==='sell')x.sellSideNotional+=Number(p.notional)||0;else if(p.side==='buy')x.buySideNotional+=Number(p.notional)||0;liquidations.set(k,x);}
 }
 return {orderBooks:[...books.values()],tradeFlow:[...trades.values()].map(x=>({...x,netAggressorNotional:x.buyNotional-x.sellNotional,imbalance:x.buyNotional+x.sellNotional?(x.buyNotional-x.sellNotional)/(x.buyNotional+x.sellNotional):null})),funding:[...funding.values()].map(x=>({...x,meanRate:x.rates.length?x.rates.reduce((a,b)=>a+b,0)/x.rates.length:null,samples:x.rates.length})),openInterest:[...interest.values()],liquidations:[...liquidations.values()]};
}

export function summarizeMicrostructureCoverage(results=[]){
 const supported=results.filter(x=>x.status==='stored'||x.status==='empty').length;
 return {requested:results.length,supported,unsupported:results.filter(x=>x.status==='unsupported').length,failed:results.filter(x=>x.status==='failed').length,observations:results.reduce((n,x)=>n+(x.count||0),0),results};
}
