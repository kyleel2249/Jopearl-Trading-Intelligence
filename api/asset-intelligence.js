import express from 'express';
import { withExchange, listExchangeCatalog, classifyMarket } from './exchanges.js';

export const assetIntelligenceRouter = express.Router();
const DEFAULT_VENUES = ['binance','bybit','okx','bitget'];
const VALID_CLASSES = new Set(['all','crypto_spot','crypto_perpetual','crypto_future','crypto_option','margin']);
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => { const n=finite(value); return n !== null && n > 0 ? n : null; };
const timestampMs = value => { const numeric=finite(value); if(numeric!==null)return numeric; const parsed=Date.parse(String(value||'')); return Number.isFinite(parsed)?parsed:null; };
const safeExpiry = value => { if(value===null||value===undefined||value==='')return null; const date=new Date(value); return Number.isFinite(date.getTime())?date.toISOString():null; };

export function normalizeAssetMarket(exchangeId, market) {
  const classification = classifyMarket(market);
  const assetClass = market.option ? 'crypto_option' : market.swap ? 'crypto_perpetual' : market.future ? 'crypto_future' : market.spot ? 'crypto_spot' : classification.categories.includes('margin') ? 'margin' : 'unknown';
  return {
    id: [exchangeId,market.id || market.symbol].join(':'),
    exchange: exchangeId, symbol: market.symbol, marketId: market.id || null,
    base: market.base || null, quote: market.quote || null, settle: market.settle || null,
    assetClass, marginEnabled:classification.categories.includes('margin'), instrumentType: market.option ? 'option' : market.swap ? 'perpetual_swap' : market.future ? 'dated_future' : market.spot ? 'spot' : classification.type,
    active: market.active !== false, contract: market.contract === true,
    linear: market.linear === true, inverse: market.inverse === true,
    contractSize: positive(market.contractSize), expiry: safeExpiry(market.expiry),
    precision: market.precision || null, limits: market.limits || null,
    maker: market.maker ?? null, taker: market.taker ?? null,
    source: 'CCXT exchange market metadata', observedAt: new Date().toISOString()
  };
}

export function assessQuoteQuality(observation, now=Date.now(), maxAgeMs=30000) {
  const price=positive(observation?.price), timestamp=timestampMs(observation?.timestamp);
  const ageMs=timestamp===null?null:now-timestamp;
  const reasons=[];
  if(!price) reasons.push('invalid_or_missing_price');
  if(timestamp===null) reasons.push('missing_timestamp');
  else if(ageMs < -5000) reasons.push('future_timestamp');
  else if(ageMs > maxAgeMs) reasons.push('stale_observation');
  if(!observation?.currency) reasons.push('missing_currency');
  return {provider:String(observation?.provider||'unknown'),price,currency:observation?.currency?String(observation.currency).toUpperCase():null,
    timestamp:timestamp===null?null:new Date(timestamp).toISOString(),ageMs,valid:reasons.length===0,reasons};
}

export function buildAssetQuoteConsensus(observations=[],options={}) {
  const now=Number.isFinite(Number(options.now))?Number(options.now):Date.now();
  const maxAgeMs=Number.isFinite(Number(options.maxAgeMs))?Math.max(1000,Math.min(300000,Number(options.maxAgeMs))):30000;
  const maxDeviationPct=Number.isFinite(Number(options.maxDeviationPct))?Math.max(.05,Math.min(10,Number(options.maxDeviationPct))):1.5;
  const assessed=(Array.isArray(observations)?observations:[]).slice(0,30).map(o=>assessQuoteQuality(o,now,maxAgeMs));
  const valid=assessed.filter(o=>o.valid);
  const currencies=[...new Set(valid.map(o=>o.currency))];
  if(currencies.length>1) return {generatedAt:new Date(now).toISOString(),status:'currency_conflict',consensusPrice:null,sourceCount:0,sources:assessed,currencyConflict:true,confidence:'unavailable',note:'Provider currencies differ. No FX conversion or combined consensus is assumed.'};
  if(!valid.length) return {generatedAt:new Date(now).toISOString(),status:'insufficient_data',consensusPrice:null,sourceCount:0,sources:assessed,currencyConflict:false,confidence:'unavailable',note:'No fresh, timestamped, positive-price observations with a common currency.'};
  const sorted=valid.map(o=>o.price).sort((a,b)=>a-b),mid=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
  const sources=assessed.map(o=>({...o,outlier:o.valid&&Math.abs(o.price-mid)/mid*100>maxDeviationPct,stale:o.reasons.includes('stale_observation')}));
  const accepted=sources.filter(o=>o.valid&&!o.outlier);
  const acceptedPrices=accepted.map(o=>o.price).sort((a,b)=>a-b);
  const consensus=acceptedPrices.length?(acceptedPrices.length%2?acceptedPrices[(acceptedPrices.length-1)/2]:(acceptedPrices[acceptedPrices.length/2-1]+acceptedPrices[acceptedPrices.length/2])/2):null;
  const spread=acceptedPrices.length?(acceptedPrices.at(-1)-acceptedPrices[0])/consensus*100:null;
  return {generatedAt:new Date(now).toISOString(),status:accepted.length>=2?'consensus_available':'single_source_only',consensusPrice:consensus,currency:currencies[0],sourceCount:accepted.length,rawValidSourceCount:valid.length,spreadPercent:spread,sources,currencyConflict:false,
    confidence:accepted.length>=3&&spread<=.25?'high':accepted.length>=2&&spread<=1?'moderate':'low',
    policy:{maxAgeMs,maxDeviationPct,method:'median anchor with explicit outlier exclusion'},
    note:'Consensus is a research reference only, not a consolidated executable quote. Provider entitlements, timestamps and currency mappings remain source-specific.'};
}

async function mapLimit(items,limit,worker){
 const output=new Array(items.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=cursor++;if(i>=items.length)return;try{output[i]=await worker(items[i]);}catch(error){output[i]={exchange:items[i],status:'error',error:error.message};}}}));
 return output;
}

assetIntelligenceRouter.get('/universe',async(req,res)=>{
 const catalog=listExchangeCatalog(),available=new Set(catalog.map(x=>x.id));
 const raw=String(req.query.exchanges||DEFAULT_VENUES.join(',')).trim().toLowerCase();
 const requested=raw==='all'?catalog.filter(x=>x.capabilities.fetchMarkets).map(x=>x.id):raw.split(',').map(x=>x.trim()).filter(Boolean);
 const exchanges=[...new Set(requested)].filter(id=>available.has(id)).slice(0,8);
 if(!exchanges.length)return res.status(400).json({error:'Select at least one supported CCXT exchange.'});
 const assetClass=String(req.query.assetClass||'all').toLowerCase();
 if(!VALID_CLASSES.has(assetClass))return res.status(400).json({error:'Unsupported assetClass filter.'});
 const search=String(req.query.search||'').trim().toUpperCase().slice(0,40);
 const limit=Math.max(1,Math.min(500,Number.parseInt(req.query.limit||'200',10)||200));
 const results=await mapLimit(exchanges,4,id=>withExchange(id,{privateAccess:false},async exchange=>{
  const rows=Object.values(exchange.markets||{}).filter(m=>m.active!==false).map(m=>normalizeAssetMarket(id,m))
   .filter(m=>(assetClass==='all'||m.assetClass===assetClass||(assetClass==='margin'&&m.marginEnabled))&&(!search||[m.symbol,m.base,m.quote,m.settle].some(v=>String(v||'').toUpperCase().includes(search))));
  return {exchange:id,status:'ok',marketCount:rows.length,markets:rows};
 }));
 const markets=results.flatMap(r=>r.markets||[]).sort((a,b)=>a.exchange.localeCompare(b.exchange)||a.symbol.localeCompare(b.symbol));
 res.json({generatedAt:new Date().toISOString(),assetClass,search:search||null,requestedExchanges:exchanges.length,respondingExchanges:results.filter(r=>r.status==='ok').length,
  failedExchanges:results.filter(r=>r.status==='error'),totalMarkets:markets.length,returnedMarkets:markets.slice(0,limit),truncated:markets.length>limit||requested.length>exchanges.length,
  catalog:{supportedExchangeCount:catalog.length,queriedExchangeIds:exchanges},sourcePolicy:'Exchange-native CCXT metadata only. Provider catalog presence is not proof of symbol entitlement, liquidity or tradability.'});
});

assetIntelligenceRouter.post('/quote-consensus', (req,res)=>{
 const observations=Array.isArray(req.body?.observations)?req.body.observations:[];
 if(observations.length>30)return res.status(400).json({error:'At most 30 provider observations may be assessed.'});
 const result=buildAssetQuoteConsensus(observations,{maxAgeMs:req.body?.maxAgeMs,maxDeviationPct:req.body?.maxDeviationPct});
 res.json(result);
});
