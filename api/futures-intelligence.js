import express from 'express';
import { withExchange, listExchangeCatalog } from './exchanges.js';

export const futuresRouter = express.Router();
const cache = new Map();
const universeCache = new Map();
async function mapLimit(items, limit, worker) {
 const output = new Array(items.length); let cursor = 0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const index=cursor++;if(index>=items.length)return;try{output[index]=await worker(items[index]);}catch(error){output[index]={status:'error',reason:error.message};}}}));
 return output;
}
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
const cleanSymbol = value => String(value || '').trim().toUpperCase();
const splitSymbol = value => {
  const [pair, settleHint] = cleanSymbol(value).split(':');
  const [base, quote] = (pair || '').split('/');
  if (!base || !quote || !/^[A-Z0-9._-]{1,20}$/.test(base) || !/^[A-Z0-9._-]{1,20}$/.test(quote)) {
    throw Object.assign(new Error('Use BASE/QUOTE or BASE/QUOTE:SETTLE, e.g. BTC/USDT:USDT.'), { status: 400 });
  }
  return { base, quote, settleHint: settleHint || null };
};
const marketMatches = (market, parsed, kind) => market.active !== false &&
  market.base === parsed.base && market.quote === parsed.quote &&
  (kind === 'perpetual' ? market.swap === true : kind === 'dated' ? market.future === true : (market.swap === true || market.future === true)) &&
  (!parsed.settleHint || market.settle === parsed.settleHint) &&
  market.contract === true;

function selectMarket(exchange, parsed, kind) {
  const matches = Object.values(exchange.markets).filter(m => marketMatches(m, parsed, kind));
  matches.sort((a,b) => Number(b.swap === true) - Number(a.swap === true) || Number(b.linear === true) - Number(a.linear === true));
  return matches[0] || null;
}
function topDepth(levels = [], requested) {
  let remaining = requested, notional = 0, filled = 0;
  for (const level of levels) {
    const price = positive(level?.[0]), amount = positive(level?.[1]);
    if (!price || !amount || remaining <= 0) continue;
    const take = Math.min(remaining, amount);
    filled += take; notional += take * price; remaining -= take;
  }
  return { filledBase: filled, remainingBase: Math.max(0, remaining), averagePrice: filled ? notional / filled : null, quoteNotional: notional };
}
function summarizeBook(book, requestedBase) {
  const bid = book.bids?.[0]?.[0] ?? null, ask = book.asks?.[0]?.[0] ?? null;
  const buy = requestedBase ? topDepth(book.asks, requestedBase) : null;
  const sell = requestedBase ? topDepth(book.bids, requestedBase) : null;
  return { bestBid: positive(bid), bestAsk: positive(ask),
    spreadBps: positive(bid) && positive(ask) ? ((ask-bid)/((ask+bid)/2))*10000 : null,
    requestedAmount: requestedBase || null, buyDepth: buy, sellDepth: sell,
    timestamp: book.timestamp ? new Date(book.timestamp).toISOString() : null };
}
async function fetchVenue(id, parsed, kind, depth, requestedBase) {
  try {
    return await withExchange(id, { privateAccess: false }, async exchange => {
      const market = selectMarket(exchange, parsed, kind);
      if (!market) return { exchange:id, status:'unavailable', reason:'No matching active derivative contract with the requested base, quote, settlement and type.' };
      const tasks = [];
      tasks.push(exchange.fetchTicker(market.symbol).then(ticker => ({ ticker })).catch(error => ({ tickerError:error.message })));
      if (exchange.has?.fetchOrderBook) tasks.push(exchange.fetchOrderBook(market.symbol, depth).then(book => ({ book })).catch(error => ({ bookError:error.message })));
      else tasks.push(Promise.resolve({ bookError:'Order-book capability unavailable.' }));
      if (exchange.has?.fetchFundingRate && market.swap) tasks.push(exchange.fetchFundingRate(market.symbol).then(funding => ({ funding })).catch(error => ({ fundingError:error.message })));
      else tasks.push(Promise.resolve({ fundingError:'Funding-rate capability unavailable for this contract.' }));
      const parts = await Promise.all(tasks);
      const data = Object.assign({}, ...parts), ticker = data.ticker || {};
      const requestedBookAmount = requestedBase && market.linear === true && positive(market.contractSize)
        ? requestedBase / Number(market.contractSize) : null;
      const book = data.book ? summarizeBook(data.book, requestedBookAmount) : null;
      const info = ticker.info || {};
      const mark = positive(ticker.mark) || positive(ticker.markPrice) || positive(info.markPrice) || null;
      const index = positive(ticker.index) || positive(ticker.indexPrice) || positive(info.indexPrice) || null;
      const last = positive(ticker.last), bid = positive(ticker.bid) || book?.bestBid || null, ask = positive(ticker.ask) || book?.bestAsk || null;
      const funding = data.funding || {};
      const fundingRate = Number.isFinite(Number(funding.fundingRate)) ? Number(funding.fundingRate) : null;
      const fundingTimestamp = funding.fundingTimestamp || funding.nextFundingTimestamp || null;
      return { exchange:id, status:last || bid || ask ? 'ok':'partial', symbol:market.symbol,
        contract:{ id:market.id, base:market.base, quote:market.quote, settle:market.settle || null,
          swap:market.swap === true, future:market.future === true, linear:market.linear === true,
          inverse:market.inverse === true, contractSize:market.contractSize || null, expiry:market.expiry ? new Date(market.expiry).toISOString() : null,
          precision:market.precision || null, limits:market.limits || null },
        prices:{ last, mark, index, bid, ask, tickerTimestamp:ticker.timestamp ? new Date(ticker.timestamp).toISOString():null },
        book, funding:{ rate:fundingRate, intervalHours:positive(funding.interval) ? Number(funding.interval) : (typeof funding.interval === 'string' && /^\\d+(?:\\.\\d+)?h$/i.test(funding.interval) ? Number.parseFloat(funding.interval) : null),
          nextFundingAt:fundingTimestamp ? new Date(fundingTimestamp).toISOString():null, timestamp:funding.timestamp ? new Date(funding.timestamp).toISOString():null },
        errors:{ ticker:data.tickerError || null, orderBook:data.bookError || null, funding:data.fundingError || null } };
    });
  } catch (error) { return { exchange:id, status:'error', reason:error.message }; }
}
export function calculateCrossVenueEdges(venues, options = {}) {
  const feeBps = Number.isFinite(Number(options.takerFeeBps)) ? Math.max(0, Math.min(100, Number(options.takerFeeBps))) : 6;
  const valid = venues.filter(v => v.status === 'ok' && positive(v.prices?.bid) && positive(v.prices?.ask));
  const edges = [];
  for (const buy of valid) for (const sell of valid) {
    if (buy.exchange === sell.exchange) continue;
    const buyPrice = buy.book?.buyDepth?.averagePrice || buy.prices.ask;
    const sellPrice = sell.book?.sellDepth?.averagePrice || sell.prices.bid;
    const grossBps = (sellPrice / buyPrice - 1) * 10000;
    const estimatedFeesBps = feeBps * 2;
    edges.push({ buyExchange:buy.exchange, sellExchange:sell.exchange, buyPrice, sellPrice,
      grossEdgeBps:grossBps, estimatedFeesBps, netEdgeBps:grossBps-estimatedFeesBps,
      netEdgePercent:(grossBps-estimatedFeesBps)/100,
      buyDepthComplete:!buy.book?.buyDepth || buy.book.buyDepth.remainingBase === 0,
      sellDepthComplete:!sell.book?.sellDepth || sell.book.sellDepth.remainingBase === 0,
      executableAssessment:buy.book?.buyDepth && sell.book?.sellDepth
        ? (buy.book.buyDepth.remainingBase === 0 && sell.book.sellDepth.remainingBase === 0 ? 'depth_checked_estimate':'insufficient_top_depth')
        : 'top_of_book_only' });
  }
  return edges.sort((a,b)=>b.netEdgeBps-a.netEdgeBps);
}
export function buildFuturesComparison(symbol, venues, options = {}) {
  const prices = venues.filter(v=>v.status==='ok').map(v=>v.prices.last).filter(positive).sort((a,b)=>a-b);
  const median = prices.length ? (prices.length%2 ? prices[(prices.length-1)/2] : (prices[prices.length/2-1]+prices[prices.length/2])/2):null;
  const marks = venues.filter(v=>v.status==='ok').map(v=>v.prices.mark).filter(positive).sort((a,b)=>a-b);
  const indexes = venues.filter(v=>v.status==='ok').map(v=>v.prices.index).filter(positive).sort((a,b)=>a-b);
  const edges = calculateCrossVenueEdges(venues,options);
  return { symbol, generatedAt:new Date().toISOString(), venueCount:venues.filter(v=>v.status==='ok').length,
    priceConsensus:{ medianLast:median, medianMark:marks.length ? marks[Math.floor(marks.length/2)]:null,
      medianIndex:indexes.length ? indexes[Math.floor(indexes.length/2)]:null,
      lastSpreadBps:prices.length>1&&median ? (prices.at(-1)/prices[0]-1)*10000:null },
    bestNetEdge:edges[0] || null, opportunities:edges.slice(0,20), venues,
    methodology:{ estimatedTakerFeeBpsPerSide:options.takerFeeBps ?? 6, depthAware:venues.some(v=>v.book?.buyDepth),
      feeSource:'Configurable conservative estimate; replace with authenticated account/market fee tier before live use.',
      fundingNotIncludedInNetEdge:true },
    safety:{ paperTradingSupported:true, liveExecutionEnabled:false, automaticExecutionEnabled:false,
      warnings:['Different contracts may not be economically equivalent even when base and quote match; inspect settlement, linear/inverse type, contract size and expiry.',
        'Mark and index prices are exchange-defined and may use different constituents and formulas.',
        'A positive estimated edge is not a guaranteed arbitrage. Fees, funding, latency, market impact, partial fills, margin, borrow and transfer constraints can erase it.',
        'Funding is reported separately and is not included in net edge because holding horizon and payment eligibility vary.'] } };
}

futuresRouter.get('/catalog', (req,res) => {
  const exchanges = listExchangeCatalog();
  const derivative = exchanges.filter(x=>x.capabilities?.fetchTicker || x.capabilities?.fetchOrderBook);
  res.json({ generatedAt:new Date().toISOString(), adapter:'CCXT', supportedExchangeCount:exchanges.length,
    derivativeDataCapableCount:derivative.length, exchanges:derivative.map(x=>({id:x.id,name:x.name,configured:x.configured,capabilities:x.capabilities})),
    coverageNote:'Catalog capability does not guarantee a particular derivatives market is listed, accessible or liquid.' });
});

futuresRouter.get('/universe', async (req,res) => {
 const kind=String(req.query.kind||'perpetual').toLowerCase();
 if(!['perpetual','dated','any'].includes(kind))return res.status(400).json({error:'kind must be perpetual, dated or any.'});
 const search=cleanSymbol(req.query.search||'').slice(0,24);
 const limit=Math.min(2000,Math.max(20,Number.parseInt(req.query.limit||'500',10)||500));
 const cacheKey=kind+'|'+search+'|'+limit,hit=universeCache.get(cacheKey);
 if(hit&&Date.now()-hit.at<Number(process.env.JPTI_FUTURES_UNIVERSE_CACHE_MS||900000))return res.json({...hit.payload,cache:'hit'});
 const ids=listExchangeCatalog().map(x=>x.id);
 const results=await mapLimit(ids,8,async id=>withExchange(id,{privateAccess:false},async exchange=>{
  const markets=Object.values(exchange.markets).filter(m=>m.active!==false&&m.contract===true&&
   (kind==='perpetual'?m.swap===true:kind==='dated'?m.future===true:(m.swap===true||m.future===true))&&
   (!search||[m.base,m.quote,m.settle,m.symbol].some(v=>String(v||'').toUpperCase().includes(search))))
   .map(m=>({exchange:id,symbol:m.symbol,id:m.id,base:m.base,quote:m.quote,settle:m.settle||null,
    kind:m.swap?'perpetual':'dated',linear:m.linear===true,inverse:m.inverse===true,
    contractSize:m.contractSize||null,expiry:m.expiry?new Date(m.expiry).toISOString():null,
    precision:m.precision||null,limits:m.limits||null}));
  return {exchange:id,markets};
 }));
 const rows=results.flatMap(r=>r?.markets||[]).sort((a,b)=>a.base.localeCompare(b.base)||a.exchange.localeCompare(b.exchange));
 const payload={generatedAt:new Date().toISOString(),kind,search:search||null,exchangeCount:ids.length,
  respondingExchanges:results.filter(r=>r?.markets).length,totalContracts:rows.length,
  markets:rows.slice(0,limit),truncated:rows.length>limit,
  failures:results.filter(r=>!r?.markets).map(r=>({reason:r?.reason||'Exchange market catalog unavailable.'})),
  note:'Market metadata discovery only. A listed contract may be inaccessible, inactive at the exchange API, restricted by geography/account or illiquid.'};
 universeCache.set(cacheKey,{at:Date.now(),payload});if(universeCache.size>50)universeCache.delete(universeCache.keys().next().value);
 res.set('Cache-Control','no-store');res.json({...payload,cache:'miss'});
});

futuresRouter.get('/compare', async (req,res) => {
  let parsed;
  try { parsed=splitSymbol(req.query.symbol || 'BTC/USDT:USDT'); }
  catch(error) { return res.status(error.status||400).json({error:error.message}); }
  const kind = String(req.query.kind || 'perpetual').toLowerCase();
  if (!['perpetual','dated','any'].includes(kind)) return res.status(400).json({error:'kind must be perpetual, dated or any.'});
  const depth = Math.min(100,Math.max(5,Number.parseInt(req.query.depth||'20',10)||20));
  const requestedBase = positive(req.query.amount);
  if (req.query.amount !== undefined && requestedBase === null) return res.status(400).json({error:'amount must be a positive base-asset quantity.'});
  const requestedFee = req.query.takerFeeBps === undefined ? Number(process.env.JPTI_FUTURES_ESTIMATED_TAKER_FEE_BPS || 6) : Number(req.query.takerFeeBps);
  if (!Number.isFinite(requestedFee) || requestedFee < 0 || requestedFee > 100) return res.status(400).json({error:'takerFeeBps must be between 0 and 100.'});
  const rawExchanges=String(req.query.exchanges || 'binance,bybit,okx,bitget,gateio,mexc,kucoin').trim().toLowerCase();
  const knownIds=listExchangeCatalog().map(x=>x.id);
  const requested=rawExchanges==='all'?knownIds:rawExchanges.split(',').map(x=>x.trim()).filter(Boolean);
  const exchangeIds=[...new Set(requested)].slice(0,knownIds.length);
  const known=new Set(knownIds);
  const unsupported=exchangeIds.filter(id=>!known.has(id));
  if (!exchangeIds.length) return res.status(400).json({error:'Select at least one exchange.'});
  if (unsupported.length) return res.status(400).json({error:'Unsupported exchange IDs.',unsupported});
  const key=[parsed.base,parsed.quote,parsed.settleHint,kind,depth,requestedBase,requestedFee,exchangeIds.join(',')].join('|');
  const hit=cache.get(key);
  if(hit&&Date.now()-hit.at<Number(process.env.JPTI_FUTURES_CACHE_MS||2000)) return res.json({...hit.payload,cache:'hit'});
  const venues=await mapLimit(exchangeIds,8,id=>fetchVenue(id,parsed,kind,depth,requestedBase));
  const payload=buildFuturesComparison(req.query.symbol||'BTC/USDT:USDT',venues,{takerFeeBps:requestedFee});
  payload.results=venues.map(v=>({exchange:v.exchange,status:v.status,reason:v.reason||null}));
  payload.cache='miss'; payload.cacheTtlMs=Number(process.env.JPTI_FUTURES_CACHE_MS||2000);
  cache.set(key,{at:Date.now(),payload}); if(cache.size>100)cache.delete(cache.keys().next().value);
  res.set('Cache-Control','no-store'); res.json(payload);
});
futuresRouter.get('/funding', async (req,res) => {
  let parsed;
  try { parsed=splitSymbol(req.query.symbol || 'BTC/USDT:USDT'); }
  catch(error) { return res.status(error.status||400).json({error:error.message}); }
  const raw=String(req.query.exchanges||'binance,bybit,okx,bitget,gateio,mexc,kucoin').trim().toLowerCase();
  const ids=raw==='all'?listExchangeCatalog().map(x=>x.id):[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))];
  const venues=await mapLimit(ids,8,id=>fetchVenue(id,parsed,'perpetual',5,null));
  const rows=venues.filter(v=>v.status==='ok').map(v=>({exchange:v.exchange,symbol:v.symbol,rate:v.funding.rate,intervalHours:v.funding.intervalHours,nextFundingAt:v.funding.nextFundingAt,markPrice:v.prices.mark,indexPrice:v.prices.index}));
  res.json({symbol:req.query.symbol||'BTC/USDT:USDT',generatedAt:new Date().toISOString(),funding:rows.sort((a,b)=>(a.rate??Infinity)-(b.rate??Infinity)),note:'Funding values are exchange-reported. Compare payment intervals and timestamps before constructing a hedge.'});
});
