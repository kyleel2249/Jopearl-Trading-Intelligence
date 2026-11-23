import express from 'express';
import { withExchange } from './exchanges.js';
import { appendStoredEvent, readStoredEvents } from './storage.js';

export const institutionalRouter = express.Router();
const CACHE = new Map();
const CACHE_MS = 45000;
let calendarCache = null;
const now = () => new Date().toISOString();
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const median = values => {
  const sorted = values.filter(finite).map(Number).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle]) / 2;
};
const source = (name,status,details={}) => ({name,status,fetchedAt:now(),...details});
function safePair(value) {
  const pair=String(value||'').toUpperCase().replace('-', '/');
  if(!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}(?::[A-Z0-9._-]{2,20})?$/.test(pair)) throw Object.assign(new Error('Use a normalized BASE/QUOTE symbol.'),{status:400});
  return pair;
}
function safeExchange(value) {
  const id=String(value||'').toLowerCase();
  if(!/^[a-z0-9_-]{2,30}$/.test(id)) throw Object.assign(new Error('Invalid exchange identifier.'),{status:400});
  return id;
}
async function fetchJson(url,timeoutMs=10000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{signal:controller.signal,headers:{accept:'application/json'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    return await response.json();
  } finally {clearTimeout(timer);}
}
async function fetchText(url,timeoutMs=10000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    const response=await fetch(url,{signal:controller.signal,headers:{accept:'application/rss+xml, application/xml, text/xml'}});
    if(!response.ok) throw new Error('HTTP '+response.status);
    return await response.text();
  } finally {clearTimeout(timer);}
}
function xmlItems(xml,provider) {
  return [...String(xml||'').matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(match=>{
    const field=name=>{
      const raw=match[1].match(new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'>','i'))?.[1]||'';
      return raw.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    };
    return {id:field('guid')||field('link'),title:field('title'),url:field('link'),publishedAt:field('pubDate'),summary:field('description'),provider};
  }).filter(item=>item.title);
}
function numeric(value) {
  if(value==null||value==='') return null;
  const cleaned=String(value).replace(/,/g,'').replace(/%/g,'').replace(/[^\d.+-]/g,'');
  if(!/\d/.test(cleaned))return null;
  const parsed=Number(cleaned);
  return Number.isFinite(parsed)?parsed:null;
}
export function normalizeCalendarEvent(raw={},provider='unknown') {
  const title=String(raw.title||raw.event||raw.name||'').trim();
  const rawDate=raw.date||raw.datetime||raw.timestamp||raw.scheduled_at||raw.time;
  const date=rawDate?new Date(rawDate):null;
  if(!title||!date||!Number.isFinite(date.getTime())) return null;
  const currency=String(raw.currency||raw.country||raw.country_code||'').toUpperCase();
  const impactText=String(raw.impact||raw.impact_name||'').toLowerCase();
  const impact=/high|red|3/.test(impactText)?'high':/medium|orange|2/.test(impactText)?'medium':/low|yellow|1/.test(impactText)?'low':'unspecified';
  const actual=raw.actual??null,forecast=raw.forecast??raw.consensus??null,actualNumber=numeric(actual),forecastNumber=numeric(forecast);
  return {
    id:String(raw.id||raw.url||[provider,title,date.toISOString(),currency].join('|')),
    title,category:/earning|eps|revenue|guidance/i.test(title)?'earnings':/speech|testif|remarks|interview/i.test(title)?'central-bank-speaker':'economic',
    currency:currency||'GLOBAL',impact,scheduledAt:date.toISOString(),actual,forecast,previous:raw.previous??null,
    revisedPrevious:raw.revised??raw.revised_previous??null,
    surprise:actualNumber!==null&&forecastNumber!==null?{absolute:Number((actualNumber-forecastNumber).toFixed(4)),direction:actualNumber>forecastNumber?'above':actualNumber<forecastNumber?'below':'inline'}:null,
    earningsMetrics:/earning|eps|revenue|guidance/i.test(title)?{epsActual:raw.epsActual??actual,epsEstimate:raw.epsEstimate??forecast,revenueActual:raw.revenueActual??null,revenueEstimate:raw.revenueEstimate??null,quarter:raw.quarter??null,year:raw.year??null,releaseTiming:raw.hour??null}:null,
    provider,url:raw.url||null,status:actual!=null&&actual!==''?'released':'scheduled',
    verified:provider.startsWith('official:')||provider==='forex-factory-feed',
    confidence:provider.startsWith('official:')?'high':provider==='forex-factory-feed'?'medium':'low'
  };
}
export function buildLiquidityMap(candles=[],orderBook=null,options={}) {
  const rows=candles.filter(row=>Array.isArray(row)&&row.length>=6&&row.slice(1,6).every(finite)).slice(0,-1);
  const price=rows.length?Number(rows.at(-1)[4]):null,recent=rows.slice(-Math.min(80,rows.length)),highs=[],lows=[],span=3;
  for(let i=span;i<recent.length-span;i++){
    const row=recent[i],left=recent.slice(i-span,i),right=recent.slice(i+1,i+span+1);
    if(left.every(x=>row[2]>=x[2])&&right.every(x=>row[2]>=x[2]))highs.push({price:Number(row[2]),at:new Date(row[0]).toISOString(),type:'swing-high'});
    if(left.every(x=>row[3]<=x[3])&&right.every(x=>row[3]<=x[3]))lows.push({price:Number(row[3]),at:new Date(row[0]).toISOString(),type:'swing-low'});
  }
  const tolerance=Math.max(Math.abs(price||1)*0.0005,Number(options.tickSize)||0);
  const cluster=(items,side)=>{
    const buckets=[];
    for(const item of items){const found=buckets.find(x=>Math.abs(x.level-item.price)<=tolerance);if(found){found.count++;found.level=(found.level*(found.count-1)+item.price)/found.count;}else buckets.push({level:item.price,count:1});}
    return buckets.filter(x=>x.count>=2).map(x=>({side,level:Number(x.level.toPrecision(12)),touches:x.count,kind:'equal-level-cluster'}));
  };
  const pools=[...cluster(highs,'buy-side'),...cluster(lows,'sell-side'),...highs.slice(-8).map(x=>({side:'buy-side',level:x.price,touches:1,kind:'confirmed-swing-high',at:x.at})),...lows.slice(-8).map(x=>({side:'sell-side',level:x.price,touches:1,kind:'confirmed-swing-low',at:x.at}))];
  const bids=(orderBook?.bids||[]).slice(0,50).filter(x=>finite(x[0])&&finite(x[1])).map(([p,q])=>({price:Number(p),notional:Number(p)*Number(q),side:'bid'}));
  const asks=(orderBook?.asks||[]).slice(0,50).filter(x=>finite(x[0])&&finite(x[1])).map(([p,q])=>({price:Number(p),notional:Number(p)*Number(q),side:'ask'}));
  const typical=median([...bids,...asks].map(x=>x.notional))||0;
  const walls=[...bids,...asks].filter(x=>typical>0&&x.notional>=typical*4).sort((a,b)=>b.notional-a.notional).slice(0,12).map(x=>({...x,kind:'large-visible-depth',multipleOfMedian:Number((x.notional/typical).toFixed(2))}));
  const nearest=side=>pools.filter(x=>x.side===side&&price!==null&&(side==='buy-side'?x.level>price:x.level<price)).sort((a,b)=>Math.abs(a.level-price)-Math.abs(b.level-price))[0]||null;
  const bidTotal=bids.reduce((sum,x)=>sum+x.notional,0),askTotal=asks.reduce((sum,x)=>sum+x.notional,0);
  return {
    referencePrice:price,pools:pools.sort((a,b)=>Math.abs(a.level-(price||a.level))-Math.abs(b.level-(price||b.level))).slice(0,24),
    nearestBuySide:nearest('buy-side'),nearestSellSide:nearest('sell-side'),
    visibleDepth:{bidNotional:bidTotal,askNotional:askTotal,imbalancePct:bidTotal+askTotal?Number(((bidTotal-askTotal)/(bidTotal+askTotal)*100).toFixed(2)):null,walls},
    sweeps:{recentHighSweep:recent.some((c,i)=>i>0&&c[2]>Math.max(...recent.slice(Math.max(0,i-5),i).map(x=>x[2]))&&c[4]<c[2]),recentLowSweep:recent.some((c,i)=>i>0&&c[3]<Math.min(...recent.slice(Math.max(0,i-5),i).map(x=>x[3]))&&c[4]>c[3])},
    methodology:'Swing/equal-level pools use confirmed closed OHLCV candles. Visible walls are snapshots from this exchange order book only; they can be cancelled, spoofed or replenished and do not identify the owner as an institution.',
    limitations:['Crypto order books are venue-specific. FX spot has no single consolidated order book.','Displayed depth is not proof of institutional intent or executable liquidity.']
  };
}
export function analyzeEventReactions(candles=[],events=[]) {
  const rows=(candles||[]).filter(row=>Array.isArray(row)&&row.length>=6&&row.slice(1,6).every(finite)).slice(0,-1);
  if(rows.length<20)return {status:'insufficient-history',observations:[],note:'At least 20 valid candles are required for event-reaction analysis.'};
  const horizons=[1,3,6,12],observations=[];
  for(const event of events){
    const eventTime=Date.parse(event.scheduledAt);
    if(!Number.isFinite(eventTime)||eventTime<rows[0][0]||eventTime>rows.at(-1)[0])continue;
    let index=0;for(let i=1;i<rows.length;i++){if(Math.abs(rows[i][0]-eventTime)<Math.abs(rows[index][0]-eventTime))index=i;}
    const anchor=rows[index],returns={};
    for(const horizon of horizons){const future=rows[index+horizon];returns[horizon+'bars']=future&&anchor[4]>0?Number(((future[4]-anchor[4])/anchor[4]*100).toFixed(4)):null;}
    const pre=rows.slice(Math.max(0,index-14),index).map(row=>row[2]-row[3]);
    const post=rows.slice(index+1,index+15).map(row=>row[2]-row[3]);
    const preRange=median(pre),postRange=median(post);
    observations.push({eventId:event.id,title:event.title,currency:event.currency,impact:event.impact,scheduledAt:event.scheduledAt,provider:event.provider,surprise:event.surprise,anchorPrice:anchor[4],matchedCandleAt:new Date(anchor[0]).toISOString(),matchOffsetMs:anchor[0]-eventTime,returns,rangeExpansionRatio:preRange>0&&postRange!=null?Number((postRange/preRange).toFixed(2)):null});
  }
  return {status:'ready',observations:observations.slice(-100),methodology:'Descriptive event study using nearest exchange candle and forward close-to-close returns. It is not a causal estimate; event timestamps, revisions, simultaneous releases, spreads, fees and selection effects can materially change outcomes.',note:'Only events inside the loaded candle window are included.'};
}
export function assessEventRisk(events=[],instrument='',at=Date.now(),metrics={}) {
  const relevant=events.filter(event=>{
    const ms=Date.parse(event.scheduledAt);if(!Number.isFinite(ms))return false;
    const currency=String(event.currency||'GLOBAL').toUpperCase(),pair=String(instrument).toUpperCase().replace('/','');
    const matches=currency==='GLOBAL'||pair.includes(currency)||(/BTC|ETH|SOL|CRYPTO/.test(pair)&&['USD','US','GLOBAL'].includes(currency));
    const minutes=(ms-at)/60000;
    return matches&&minutes>=-60&&minutes<=120&&['high','medium'].includes(event.impact);
  }).map(event=>({...event,minutesFromNow:Math.round((Date.parse(event.scheduledAt)-at)/60000)})).sort((a,b)=>a.minutesFromNow-b.minutesFromNow);
  const next=relevant.find(x=>x.minutesFromNow>=0),active=relevant.find(x=>x.minutesFromNow<0&&x.minutesFromNow>=-60);
  const activeHigh=relevant.find(x=>x.impact==='high'&&x.minutesFromNow<0&&x.minutesFromNow>=-30);
  const severe=metrics.atrExpansionRatio>=3||metrics.spreadPercent>=0.5;
  const elevated=metrics.atrExpansionRatio>=1.8||metrics.relativeVolume>=3||metrics.spreadPercent>=0.2;
  const state=activeHigh?'HALT_NEW_ENTRIES':next?.impact==='high'&&next.minutesFromNow<=30?'RESTRICTED':next?.impact==='high'&&next.minutesFromNow<=60?'CAUTION':severe?'RESTRICTED':elevated?'CAUTION':active?'RECOVERY':next?'CAUTION':'NORMAL';
  return {state,affectedEvents:relevant.slice(0,12),nextEvent:next||null,activeEvent:active||null,dynamicVolatility:{...metrics,severe,elevated},
    policy:{blockNewEntries:state==='HALT_NEW_ENTRIES'||state==='RESTRICTED',reduceNewRisk:state==='CAUTION'||state==='RECOVERY',closeExistingPositions:false},
    note:'The JPTI live spot-order endpoint enforces new-entry blocks. Existing positions are not automatically closed; paper strategies must consume this policy through their own preflight.'};
}
async function settled(name,task) {
  try{return {data:await task(),source:source(name,'live')};}
  catch(error){return {data:null,source:source(name,'unavailable',{error:error.name==='AbortError'?'Timed out':error.message})};}
}
async function getCalendar() {
  if(calendarCache&&Date.now()-calendarCache.at<60000)return calendarCache.data;
  const ffUrl=process.env.JPTI_FOREX_FACTORY_CALENDAR_URL||'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  const tasks=[
    settled('Forex Factory public calendar feed',async()=>(await fetchJson(ffUrl)).map(row=>normalizeCalendarEvent(row,'forex-factory-feed')).filter(Boolean)),
    settled('Federal Reserve speeches RSS',async()=>{const xml=await fetchText('https://www.federalreserve.gov/feeds/speeches.xml');return xmlItems(xml).map(item=>normalizeCalendarEvent({title:item.title,date:item.publishedAt,url:item.url},'official:Federal Reserve speeches')).filter(Boolean);}),
    settled('Federal Reserve press releases RSS',async()=>{const xml=await fetchText('https://www.federalreserve.gov/feeds/press_all.xml');return xmlItems(xml).map(item=>normalizeCalendarEvent({title:item.title,date:item.publishedAt,url:item.url},'official:Federal Reserve press releases')).filter(Boolean);})
  ];
  const results=await Promise.all(tasks),events=results.flatMap(x=>x.data||[]),unique=new Map(events.map(e=>[e.id,e]));
  const cutoff=Date.now()-7*86400000,horizon=Date.now()+90*86400000;
  const visible=[...unique.values()].filter(event=>Date.parse(event.scheduledAt)>=cutoff&&Date.parse(event.scheduledAt)<=horizon);
  const payload={events:visible.sort((a,b)=>Date.parse(a.scheduledAt)-Date.parse(b.scheduledAt)),sources:results.map(x=>x.source)};
  calendarCache={at:Date.now(),data:payload};
  return payload;
}
export async function assessExchangeEventRisk(client,symbol,timeframe='5m') {
  const [candles,ticker,calendar]=await Promise.all([
    client.has?.fetchOHLCV?client.fetchOHLCV(symbol,timeframe,undefined,60).catch(()=>[]):Promise.resolve([]),
    client.has?.fetchTicker?client.fetchTicker(symbol).catch(()=>null):Promise.resolve(null),
    getCalendar()
  ]);
  const rows=(candles||[]).filter(x=>Array.isArray(x)&&x.length>=6&&x.slice(1,6).every(finite)).slice(0,-1);
  const ranges=rows.slice(1).map((row,i)=>Math.max(row[2]-row[3],Math.abs(row[2]-rows[i][4]),Math.abs(row[3]-rows[i][4])));
  const recent=median(ranges.slice(-14)),prior=median(ranges.slice(-28,-14)),baseVolume=median(rows.slice(-21,-1).map(x=>x[5]));
  const mid=ticker?.bid!=null&&ticker?.ask!=null?(ticker.bid+ticker.ask)/2:null;
  const metrics={atrExpansionRatio:recent!=null&&prior>0?Number((recent/prior).toFixed(2)):null,relativeVolume:baseVolume>0&&rows.length?Number((rows.at(-1)[5]/baseVolume).toFixed(2)):null,spreadPercent:mid>0?Number(((ticker.ask-ticker.bid)/mid*100).toFixed(4)):null};
  const risk=assessEventRisk(calendar.events,symbol,Date.now(),metrics);
  const calendarFeed=calendar.sources.find(item=>item.name.includes('Forex Factory'));
  return {...risk,calendarAvailable:calendarFeed?.status==='live',calendarSource:calendarFeed||null,marketTimestamp:ticker?.timestamp?new Date(ticker.timestamp).toISOString():null};
}
async function getMacroSnapshot() {
  const key=process.env.JPTI_FRED_API_KEY;
  if(!key)return {indicators:[],sources:[source('FRED macro observations','not-configured',{requiredEnv:'JPTI_FRED_API_KEY'})]};
  const series=[['FEDFUNDS','Effective federal funds rate'],['CPIAUCSL','CPI index'],['CPILFESL','Core CPI index'],['PCEPI','PCE price index'],['UNRATE','Unemployment rate'],['PAYEMS','Nonfarm payrolls'],['DGS10','10-year Treasury yield'],['DTWEXBGS','Broad trade-weighted US dollar index']];
  const results=await Promise.all(series.map(([id,label])=>settled('FRED '+id,async()=>{
    const url=new URL('https://api.stlouisfed.org/fred/series/observations');
    const limit=['CPIAUCSL','CPILFESL','PCEPI'].includes(id)?'13':'2';
    url.search=new URLSearchParams({series_id:id,api_key:key,file_type:'json',sort_order:'desc',limit}).toString();
    const data=await fetchJson(url.toString()),rows=(data.observations||[]).filter(x=>x.value!=='.');
    const latest=numeric(rows[0]?.value),yearAgo=numeric(rows[12]?.value);
    return {id,label,latest:rows[0]?.value??null,latestDate:rows[0]?.date??null,previous:rows[1]?.value??null,previousDate:rows[1]?.date??null,
      yearOverYearPercent:latest!==null&&yearAgo>0?Number(((latest/yearAgo-1)*100).toFixed(2)):null};
  })));
  return {indicators:results.map(x=>x.data).filter(Boolean),sources:results.map(x=>x.source)};
}
async function getNews(instrument) {
  const pair=String(instrument||'').replace('/',' ');
  const query=encodeURIComponent('("'+pair+'" OR central bank OR Federal Reserve OR inflation OR interest rate OR FOMC)');
  return settled('GDELT global news',async()=>{
    const data=await fetchJson('https://api.gdeltproject.org/api/v2/doc/doc?query='+query+'&mode=ArtList&format=json&sort=DateDesc&maxrecords=30');
    return (data.articles||[]).map(article=>({id:article.url,title:article.title,url:article.url,domain:article.domain,publishedAt:article.seendate,sourceCountry:article.sourcecountry,language:article.language,provider:'GDELT',instrument,verified:false,confidence:'low'}));
  });
}
async function getEarnings(symbol) {
  const base=String(symbol||'').split('/')[0].toUpperCase();
  if(/^(BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|LINK|DOT|TRX|LTC|BCH|USDT|USDC|USD|EUR|GBP|JPY|CHF|CAD|AUD|NZD|XAU|XAG)$/.test(base))
    return {data:[],source:source('Finnhub earnings calendar','not-applicable',{note:'The selected instrument is not a mapped listed-company equity.'})};
  if(!process.env.JPTI_FINNHUB_API_KEY)return {data:[],source:source('Finnhub earnings calendar','not-configured',{requiredEnv:'JPTI_FINNHUB_API_KEY'})};
  if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(base))return {data:[],source:source('Finnhub earnings calendar','not-applicable')};
  return settled('Finnhub earnings calendar',async()=>{
    const from=new Date().toISOString().slice(0,10),to=new Date(Date.now()+14*86400000).toISOString().slice(0,10);
    const data=await fetchJson('https://finnhub.io/api/v1/calendar/earnings?from='+from+'&to='+to+'&symbol='+encodeURIComponent(base)+'&token='+encodeURIComponent(process.env.JPTI_FINNHUB_API_KEY));
    return (data.earningsCalendar||[]).map(row=>normalizeCalendarEvent({...row,title:(row.symbol||base)+' earnings '+(row.hour||'release'),date:row.date,currency:'USD',actual:row.epsActual??null,forecast:row.epsEstimate??null},'Finnhub')).filter(Boolean);
  });
}
institutionalRouter.get('/calendar',async(req,res)=>{
  const result=await getCalendar(),instrument=String(req.query.symbol||'');
  const events=result.events.filter(e=>!instrument||e.currency==='GLOBAL'||instrument.toUpperCase().includes(e.currency));
  res.set('Cache-Control','public, max-age=60');
  res.json({generatedAt:now(),events:events.slice(0,160),sources:result.sources,disclaimer:'Forex Factory is a third-party calendar feed. Verify high-impact releases against the issuing central bank or statistical agency.'});
});
institutionalRouter.get('/news',async(req,res)=>{
  const symbol=String(req.query.symbol||'BTC/USDT').slice(0,40),key='news:'+symbol.toUpperCase(),cached=CACHE.get(key);
  if(cached&&Date.now()-cached.at<CACHE_MS)return res.json(cached.data);
  const result=await getNews(symbol),payload={generatedAt:now(),instrument:symbol,articles:result.data||[],sources:[result.source]};
  CACHE.set(key,{at:Date.now(),data:payload});res.json(payload);
});
institutionalRouter.get('/earnings',async(req,res)=>{
  const symbol=String(req.query.symbol||'').slice(0,40),result=await getEarnings(symbol);
  res.json({generatedAt:now(),instrument:symbol,events:result.data||[],sources:[result.source],note:'Earnings data is only mapped for listed-company equities. Crypto tokens are not assigned company earnings releases.'});
});
institutionalRouter.get('/context/:exchange/:symbol',async(req,res)=>{
  let exchange,symbol;
  try{exchange=safeExchange(req.params.exchange);symbol=safePair(req.params.symbol);}
  catch(error){return res.status(error.status||400).json({error:error.message});}
  const timeframe=String(req.query.timeframe||'1h');
  if(!/^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/.test(timeframe))return res.status(400).json({error:'Unsupported timeframe.'});
  const key=['context',exchange,symbol,timeframe].join(':'),cached=CACHE.get(key);
  if(cached&&Date.now()-cached.at<CACHE_MS)return res.json({...cached.data,cache:'hit'});
  try{
    const market=await withExchange(exchange,{privateAccess:false},async client=>{
      if(!client.markets[symbol])throw Object.assign(new Error('Market is not listed on selected exchange.'),{status:404});
      if(!client.has?.fetchOHLCV)throw Object.assign(new Error('OHLCV is unavailable.'),{status:501});
      const [candles,orderBook,funding,openInterest,ticker]=await Promise.all([
        client.fetchOHLCV(symbol,timeframe,undefined,180),
        client.has?.fetchOrderBook?client.fetchOrderBook(symbol,50).catch(()=>null):Promise.resolve(null),
        client.has?.fetchFundingRate&&client.market(symbol).contract?client.fetchFundingRate(symbol).catch(()=>null):Promise.resolve(null),
        client.has?.fetchOpenInterest&&client.market(symbol).contract?client.fetchOpenInterest(symbol).catch(()=>null):Promise.resolve(null),
        client.has?.fetchTicker?client.fetchTicker(symbol).catch(()=>null):Promise.resolve(null)
      ]);
      return {candles,orderBook,funding,openInterest,ticker};
    });
    const liquidity=buildLiquidityMap(market.candles,market.orderBook);
    const [calendar,news,earnings,macro]=await Promise.all([getCalendar(),getNews(symbol),getEarnings(symbol),getMacroSnapshot()]);
    const rows=(market.candles||[]).filter(x=>Array.isArray(x)&&x.length>=6&&x.slice(1,6).every(finite)).slice(0,-1);
    const ranges=rows.slice(1).map((row,i)=>Math.max(row[2]-row[3],Math.abs(row[2]-rows[i][4]),Math.abs(row[3]-rows[i][4])));
    const currentAtr=median(ranges.slice(-14)),priorAtr=median(ranges.slice(-28,-14)),averageVolume=median(rows.slice(-21,-1).map(x=>x[5]));
    const relativeVolume=averageVolume>0?Number((rows.at(-1)[5]/averageVolume).toFixed(2)):null;
    const midpoint=market.ticker?.bid!=null&&market.ticker?.ask!=null?(market.ticker.bid+market.ticker.ask)/2:null;
    const spreadPercent=midpoint>0?Number(((market.ticker.ask-market.ticker.bid)/midpoint*100).toFixed(4)):null;
    const volatility={atrExpansionRatio:currentAtr!=null&&priorAtr>0?Number((currentAtr/priorAtr).toFixed(2)):null,relativeVolume,spreadPercent,latestAtr:currentAtr};
    const eventRisk=assessEventRisk(calendar.events,symbol,Date.now(),volatility);
    const payload={
      generatedAt:now(),exchange,symbol,timeframe,
      market:{last:market.ticker?.last??liquidity.referencePrice,observedAt:market.ticker?.timestamp?new Date(market.ticker.timestamp).toISOString():null,fundingRate:market.funding?.fundingRate??null,openInterest:market.openInterest?.openInterestAmount??market.openInterest?.openInterestValue??null,bid:market.ticker?.bid??null,ask:market.ticker?.ask??null},
      liquidity,eventRisk,macro,eventStudy:analyzeEventReactions(market.candles,calendar.events),calendar:calendar.events.slice(0,100),news:news.data||[],earnings:earnings.data||[],
      sources:[source('Selected CCXT OHLCV/order book','live',{exchange,symbol,timeframe,candles:market.candles.length}),...calendar.sources,news.source,earnings.source,...macro.sources]
    };
    CACHE.set(key,{at:Date.now(),data:payload});if(CACHE.size>160)CACHE.delete(CACHE.keys().next().value);
    try{
      const stored=await readStoredEvents(500,'institutional-intelligence-snapshot');
      if(!stored.some(item=>item.fingerprint===key+'|'+payload.generatedAt.slice(0,15)))
        await appendStoredEvent({kind:'institutional-intelligence-snapshot',source:'jpti-institutional-engine',symbol,occurredAt:payload.generatedAt,fingerprint:key+'|'+payload.generatedAt.slice(0,15),payload:{exchange,symbol,timeframe,market:payload.market,liquidity,eventRisk,macro,calendar:calendar.events.slice(0,50),news:(news.data||[]).slice(0,10),earnings:earnings.data||[],eventStudy:payload.eventStudy,sources:payload.sources}});
    }catch{}
    res.set('Cache-Control','no-store');res.json(payload);
  }catch(error){res.status(error.status||502).json({error:error.message||'Institutional context unavailable'});}
});
institutionalRouter.get('/history',async(_req,res)=>{
  try{const rows=await readStoredEvents(300,'institutional-intelligence-snapshot');res.json({generatedAt:now(),snapshots:rows.slice().reverse()});}
  catch(error){res.status(503).json({error:'Institutional history storage unavailable: '+error.message});}
});
institutionalRouter.get('/sources',(_req,res)=>res.json({sources:[
  {name:'Selected CCXT OHLCV and order book',status:'on-demand',coverage:'Venue-specific candle and order-book snapshots'},
  {name:'Forex Factory calendar feed',status:'feed-dependent',url:'https://www.forexfactory.com/calendar',note:'Third-party feed mirror; confirm high-impact releases with official agencies.'},
  {name:'Federal Reserve speeches RSS',status:'official-feed',url:'https://www.federalreserve.gov/feeds/speeches.xml'},
  {name:'Federal Reserve press RSS',status:'official-feed',url:'https://www.federalreserve.gov/feeds/press_all.xml'},
  {name:'FRED macro observations',status:process.env.JPTI_FRED_API_KEY?'credential-configured':'not-configured',requiredEnv:'JPTI_FRED_API_KEY'},
  {name:'GDELT news index',status:'public-news-index',url:'https://www.gdeltproject.org/'},
  {name:'Finnhub earnings calendar',status:process.env.JPTI_FINNHUB_API_KEY?'credential-configured':'not-configured',requiredEnv:'JPTI_FINNHUB_API_KEY'},
  {name:'Federal Reserve FOMC calendar',status:'official-reference',url:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},
  {name:'US Bureau of Labor Statistics release schedule',status:'official-reference',url:'https://www.bls.gov/schedule/'},
  {name:'US Bureau of Economic Analysis release schedule',status:'official-reference',url:'https://www.bea.gov/news/schedule/'},
  {name:'CFTC Commitments of Traders',status:'weekly-delayed-reference',url:'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',note:'Weekly positioning report; not a live positioning feed.'},
  {name:'European Central Bank policy and press releases',status:'official-reference',url:'https://www.ecb.europa.eu/press/html/index.en.html'},
  {name:'Bank of England policy and news',status:'official-reference',url:'https://www.bankofengland.co.uk/news'},
  {name:'Bank of Japan announcements',status:'official-reference',url:'https://www.boj.or.jp/en/announcements/'},
  {name:'Swiss National Bank monetary policy',status:'official-reference',url:'https://www.snb.ch/en/the-snb/mandates-goals/monetary-policy/monetary-policy-decisions'},
  {name:'Bank of Canada policy rate',status:'official-reference',url:'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/'},
  {name:'Reserve Bank of Australia monetary policy',status:'official-reference',url:'https://www.rba.gov.au/monetary-policy/'},
  {name:'Reserve Bank of New Zealand monetary policy',status:'official-reference',url:'https://www.rbnz.govt.nz/monetary-policy'}
],limitations:['Forex spot liquidity is fragmented; there is no consolidated public order book.','Public order-book depth is not proof of institutional ownership or intent.','Earnings estimates require a mapped listed equity and provider entitlement.','Official Fed RSS is a published-communications feed, not a complete forward calendar.','Data may be delayed, revised, incomplete or unavailable.']}));
