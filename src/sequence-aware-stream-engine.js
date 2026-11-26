export const STREAM_EXCHANGES = Object.freeze(['binance','bybit','okx','bitget']);
const TYPES = Object.freeze(['spot','margin','usdt-m','coin-m','usdc-m']);
const n = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const iso = v => { const x=n(v); if(x===null)return null; const d=new Date(x<1e12?x*1000:x); return Number.isNaN(d.getTime())?null:d.toISOString(); };
export function normalizeStreamRequest(input={}) {
 const exchange=String(input.exchange||'').toLowerCase(), marketType=String(input.marketType||'spot').toLowerCase();
 const symbol=String(input.symbol||'BTC/USDT').toUpperCase().trim();
 if(!STREAM_EXCHANGES.includes(exchange)) throw new Error('Unsupported exchange.');
 if(!TYPES.includes(marketType)) throw new Error('Unsupported market type.');
 if(!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(symbol)) throw new Error('Use BASE/QUOTE symbol notation.');
 return {exchange,marketType,symbol,streamId:[exchange,marketType,symbol].join(':')};
}
export function exchangeStreamConfig(config) {
 const {exchange,marketType,symbol}=config, [base,quote]=symbol.split('/'), spot=['spot','margin'].includes(marketType);
 if(exchange==='binance') {
  const coin=marketType==='coin-m', host=spot?'stream.binance.com:9443':coin?'dstream.binance.com':'fstream.binance.com';
  const prefix='/stream?';
  const s=base.toLowerCase()+quote.toLowerCase();
  const streams=spot?[s+'@depth@100ms',s+'@trade',s+'@ticker']:[s+'@depth@100ms',s+'@aggTrade',s+'@ticker',s+'@markPrice@1s',s+'@forceOrder'];
  return {url:'wss://'+host+prefix+'streams='+streams.join('/'),snapshotUrl:spot?'https://api.binance.com/api/v3/depth?symbol='+base+quote+'&limit=1000':(coin?'https://dapi.binance.com/dapi/v1/depth':'https://fapi.binance.com/fapi/v1/depth')+'?symbol='+base+quote+'&limit=1000',protocol:'binance',streams};
 }
 if(exchange==='bybit') {
  const category=spot?'spot':marketType==='coin-m'?'inverse':'linear',s=base+quote;
  return {url:'wss://stream.bybit.com/v5/public/'+category,subscribe:{op:'subscribe',args:['orderbook.50.'+s,'publicTrade.'+s,'tickers.'+s,...(!spot?['allLiquidation.'+s]:[])]},heartbeat:{op:'ping'},protocol:'bybit'};
 }
 if(exchange==='okx') {
  const inst=spot?base+'-'+quote:base+'-'+quote+'-SWAP';
  return {url:'wss://ws.okx.com:8443/ws/v5/public',subscribe:{op:'subscribe',args:[{channel:'books',instId:inst},{channel:'trades',instId:inst},{channel:'tickers',instId:inst},...(!spot?[{channel:'funding-rate',instId:inst},{channel:'open-interest',instType:'SWAP',instId:inst},{channel:'liquidation-orders',instType:'SWAP',instFamily:base+'-'+quote}]:[])]},heartbeat:'ping',protocol:'okx'};
 }
 const product=marketType==='coin-m'?'COIN-FUTURES':marketType==='usdc-m'?'USDC-FUTURES':'USDT-FUTURES',inst=base+quote;
 return {url:'wss://ws.bitget.com/v2/ws/public',subscribe:{op:'subscribe',args:[{instType:spot?'SPOT':product,channel:'books',instId:inst},{instType:spot?'SPOT':product,channel:'trade',instId:inst},{instType:spot?'SPOT':product,channel:'ticker',instId:inst},...(!spot?[{instType:product,channel:'liquidation',instId:'default'}]:[])]},heartbeat:'ping',protocol:'bitget'};
}
export function parseStreamMessage(config,raw,receivedAt=Date.now()) {
 let m; try { m=typeof raw==='string'?JSON.parse(raw):raw; } catch { return []; }
 if(!m||typeof m!=='object'||m.event==='subscribe'||m.op==='pong'||m.event==='pong'||m.event==='ping'||m.op==='ping')return [];
 const out=[], ex=config.exchange, symbol=config.symbol, ts=iso(m.ts||m.T||m.E||m.data?.[0]?.ts||m.data?.[0]?.T)||new Date(receivedAt).toISOString();
 const emit=(kind,eventId,payload,sequence={},quality={})=>out.push({exchange:ex,marketType:config.marketType,symbol,kind,eventId:String(eventId??ts),observedAt:ts,receivedAt:new Date(receivedAt).toISOString(),payload,sequence,quality});
 if(ex==='binance') {
  const d=m.data||m, event=d.e;
  if(event==='depthUpdate') emit('orderbook',d.u,{type:'delta',bids:d.b||[],asks:d.a||[],firstUpdateId:n(d.U),finalUpdateId:n(d.u),previousUpdateId:n(d.pu),eventTime:n(d.E)},{first:n(d.U),last:n(d.u),previous:n(d.pu)});
  else if(event==='trade'||event==='aggTrade') emit('trade',d.t??d.a,{price:n(d.p),quantity:n(d.q),side:d.m?'sell':'buy',tradeId:String(d.t??d.a),quoteNotional:n(d.p)*n(d.q),maker:d.m===true});
  else if(event==='24hrTicker') emit('ticker',d.E,{last:n(d.c),bid:n(d.b),ask:n(d.a),baseVolume:n(d.v),quoteVolume:n(d.q),changePct:n(d.P)});\n  else if(event==='markPriceUpdate') emit('funding',d.E,{rate:n(d.r),markPrice:n(d.p),indexPrice:n(d.i),fundingTime:iso(d.T)});
  else if(event==='forceOrder') { const o=d.o||{}; emit('liquidation',o.i+'-'+o.T,{side:String(o.S||'').toLowerCase(),price:n(o.ap||o.p),quantity:n(o.z||o.q),notional:n(o.ap||o.p)*n(o.z||o.q),orderId:String(o.i||'')}); }
  return out;
 }
 if(ex==='bybit') {
  const topic=String(m.topic||''), rows=Array.isArray(m.data)?m.data:[m.data||{}];
  if(topic.startsWith('orderbook.')) for(const d of rows) emit('orderbook',(d.u||m.ts)+'-'+(d.seq||''),{type:m.type==='snapshot'?'snapshot':'delta',bids:d.b||[],asks:d.a||[],updateId:n(d.u),sequence:n(d.seq),crossSequence:n(d.seq)},{last:n(d.u),sequence:n(d.seq)},{snapshot:m.type==='snapshot'});
  else if(topic.startsWith('publicTrade.')) for(const d of rows) emit('trade',d.execId,{price:n(d.p),quantity:n(d.v),side:String(d.S||'').toLowerCase(),tradeId:String(d.i||d.execId||''),quoteNotional:n(d.p)*n(d.v)});\n  else if(topic.startsWith('tickers.')) for(const d of rows){emit('ticker',m.ts,{last:n(d.lastPrice),bid:n(d.bid1Price),ask:n(d.ask1Price),fundingRate:n(d.fundingRate),openInterest:n(d.openInterest),markPrice:n(d.markPrice)});if(n(d.fundingRate)!==null)emit('funding',m.ts,{rate:n(d.fundingRate)});if(n(d.openInterest)!==null)emit('open_interest',m.ts,{openInterest:n(d.openInterest)});}
  else if(topic.startsWith('allLiquidation.')) for(const d of rows) emit('liquidation',d.updatedTime+'-'+d.updatedTime+'-'+d.price,{side:String(d.side||'').toLowerCase(),price:n(d.price),quantity:n(d.qty),notional:n(d.price)*n(d.qty),orderId:String(d.updatedTime||'')});
  return out;
 }
 if(ex==='okx') {
  const channel=m.arg?.channel, rows=Array.isArray(m.data)?m.data:[];
  if(channel==='books') for(const d of rows) emit('orderbook',d.seqId,{type:d.prevSeqId===-1?'snapshot':'delta',bids:d.bids||[],asks:d.asks||[],sequence:n(d.seqId),previousSequence:n(d.prevSeqId)},{last:n(d.seqId),previous:n(d.prevSeqId)},{snapshot:d.prevSeqId===-1});
  else if(channel==='trades') for(const d of rows) emit('trade',d.tradeId,{price:n(d.px),quantity:n(d.sz),side:String(d.side||'').toLowerCase(),tradeId:String(d.tradeId),quoteNotional:n(d.px)*n(d.sz)});\n  else if(channel==='tickers') for(const d of rows) emit('ticker',d.ts,{last:n(d.last),bid:n(d.bidPx),ask:n(d.askPx),baseVolume:n(d.vol24h),quoteVolume:n(d.volCcy24h)});\n  else if(channel==='funding-rate') for(const d of rows) emit('funding',d.fundingTime,{rate:n(d.fundingRate),fundingTime:iso(d.fundingTime)});\n  else if(channel==='open-interest') for(const d of rows) emit('open_interest',d.ts,{openInterest:n(d.oi),unit:d.unit||null});
  else if(channel==='liquidation-orders') for(const d of rows.flatMap(x=>x.details||[])) emit('liquidation',d.uTime+'-'+d.bkPx+'-'+d.sz,{side:String(d.side||'').toLowerCase(),price:n(d.bkPx),quantity:n(d.sz),notional:n(d.bkPx)*n(d.sz),orderId:String(d.ordId||'')});
  return out;
 }
 const channel=m.arg?.channel, rows=Array.isArray(m.data)?m.data:[];
 if(channel==='books') for(const d of rows) emit('orderbook',d.seq,{type:d.pseq===0?'snapshot':'delta',bids:d.bids||[],asks:d.asks||[],sequence:n(d.seq),previousSequence:n(d.pseq)},{last:n(d.seq),previous:n(d.pseq)},{snapshot:d.pseq===0});
 else if(channel==='trade') for(const d of rows) emit('trade',d.tradeId||d.ts+'-'+d.price,{price:n(d.price),quantity:n(d.size),side:String(d.side||'').toLowerCase(),tradeId:String(d.tradeId||''),quoteNotional:n(d.price)*n(d.size)});\n else if(channel==='ticker') for(const d of rows){emit('ticker',d.ts,{last:n(d.lastPr),bid:n(d.bidPr),ask:n(d.askPr),fundingRate:n(d.fundingRate),openInterest:n(d.openInterest),baseVolume:n(d.baseVolume),quoteVolume:n(d.quoteVolume)});if(n(d.fundingRate)!==null)emit('funding',d.ts,{rate:n(d.fundingRate)});if(n(d.openInterest)!==null)emit('open_interest',d.ts,{openInterest:n(d.openInterest)});}
 else if(channel==='liquidation') for(const d of rows) emit('liquidation',d.ts+'-'+d.price+'-'+d.size,{side:String(d.side||'').toLowerCase(),price:n(d.price),quantity:n(d.size),notional:n(d.price)*n(d.size)});
 return out;
}
export function advanceBookSequence(state={},update={}) {
 const next={...state,valid:state.valid!==false};
 if(update.quality?.snapshot||update.payload?.type==='snapshot') return {state:{...next,lastSequence:update.sequence?.last??update.sequence?.sequence??null,valid:true,snapshotAt:update.receivedAt},action:'snapshot'};
 const first=n(update.sequence?.first),last=n(update.sequence?.last),previous=n(update.sequence?.previous);
 const current=n(state.lastSequence);
 if(current===null||!state.valid) return {state:{...next,valid:false,gapReason:'delta_without_snapshot'},action:'gap'};
 if(previous!==null&&previous!==current) return {state:{...next,valid:false,gapReason:'previous_sequence_mismatch',expectedPrevious:current,receivedPrevious:previous},action:'gap'};
 if(first!==null&&last!==null) {
  if(last<=current)return {state:next,action:'duplicate'};
  if(first>current+1)return {state:{...next,valid:false,gapReason:'sequence_gap',expected:first,current},action:'gap'};
  return {state:{...next,lastSequence:last,valid:true},action:'applied'};
 }
 if(last!==null) {
  if(last<=current)return {state:next,action:'duplicate'};
  return {state:{...next,lastSequence:last,valid:true},action:'applied',continuity:'monotonic'};
 }
 return {state:next,action:'applied',continuity:'unsequenced'};
}

export function applyOrderBookUpdate(book={},event={}) {
 const snapshot=event.quality?.snapshot||event.payload?.type==='snapshot';
 const bids=snapshot?new Map():new Map(book.bids||[]),asks=snapshot?new Map():new Map(book.asks||[]);
 const apply=(map,levels)=>{for(const level of Array.isArray(levels)?levels:[]){const price=n(level[0]),size=n(level[1]);if(!(price>0)||size===null)continue;if(size===0)map.delete(price);else map.set(price,size);}};
 apply(bids,event.payload?.bids);apply(asks,event.payload?.asks);
 return{bids:[...bids.entries()].sort((a,b)=>b[0]-a[0]).slice(0,100),asks:[...asks.entries()].sort((a,b)=>a[0]-b[0]).slice(0,100),lastSequence:event.sequence?.last??event.sequence?.sequence??book.lastSequence??null,valid:event.quality?.bookValid!==false};
}
export function summarizeOrderBook(book={}) {
 const bids=book.bids||[],asks=book.asks||[],bestBid=bids[0]?.[0]??null,bestAsk=asks[0]?.[0]??null,mid=bestBid&&bestAsk?(bestBid+bestAsk)/2:null;
 const bidQty=bids.reduce((s,x)=>s+x[1],0),askQty=asks.reduce((s,x)=>s+x[1],0),bidNotional=bids.reduce((s,x)=>s+x[0]*x[1],0),askNotional=asks.reduce((s,x)=>s+x[0]*x[1],0);
 return{bestBid,bestAsk,midPrice:mid,spread:bestBid&&bestAsk?bestAsk-bestBid:null,spreadBps:mid?(bestAsk-bestBid)/mid*10000:null,bidQty,askQty,bidNotional,askNotional,depthImbalance:bidQty+askQty?(bidQty-askQty)/(bidQty+askQty):null,notionalImbalance:bidNotional+askNotional?(bidNotional-askNotional)/(bidNotional+askNotional):null,valid:book.valid===true,lastSequence:book.lastSequence||null};
}
