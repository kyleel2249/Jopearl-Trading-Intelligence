import { runCycle, dailyReview, ensureAgents } from '../functions/api/paper/[[path]].js';
import { normalizeStreamRequest } from '../src/sequence-aware-stream-engine.js';

const WATCHLIST = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','SOPHUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','LINKUSDT','SUIUSDT'];
const DAILY_REVIEW_CRON = '5 0 * * *';
export function isDailyReviewDue(event = {}) {
  if (event.cron === DAILY_REVIEW_CRON) return true;
  const scheduledAt = Number(event.scheduledTime);
  if (!Number.isFinite(scheduledAt) || scheduledAt <= 0) return false;
  const date = new Date(scheduledAt);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 5;
}
const shortError = (error) => String(error?.message || error).slice(0, 180);
const STREAM_FALLBACK = [
  ...['binance','bybit','okx','bitget'].flatMap(exchange => [
    { exchange, marketType: 'spot', symbol: 'BTC/USDT' },
    { exchange, marketType: 'usdt-m', symbol: 'BTC/USDT' }
  ])
];
export function normalizeBitgetPerpetualUniverse(contracts=[],tickers=[]) {
  const tickerMap=new Map((Array.isArray(tickers)?tickers:[]).map(x=>[String(x.symbol||'').toUpperCase(),x]));
  return (Array.isArray(contracts)?contracts:[])
    .filter(x=>String(x.symbolStatus||x.status||'normal').toLowerCase()==='normal'&&String(x.quoteCoin||'USDT').toUpperCase()==='USDT'&&/^[A-Z0-9]{3,20}USDT$/.test(String(x.symbol||'').toUpperCase()))
    .map(x=>{const symbol=String(x.symbol).toUpperCase(),t=tickerMap.get(symbol)||{},last=Number(t.lastPr||t.lastPrice||t.last||0);
      const volume=Number(t.usdtVolume||t.quoteVolume||t.quoteVol||t.quoteVolume24h||0)||Number(t.baseVolume||t.baseVol||0)*last;
      return {symbol,baseCoin:String(x.baseCoin||symbol.slice(0,-4)).toUpperCase(),quoteCoin:'USDT',volume24hUsd:Number.isFinite(volume)?volume:0,contract:x};
    }).sort((a,b)=>b.volume24hUsd-a.volume24hUsd||a.symbol.localeCompare(b.symbol));
}
export function selectRoundRobinBatch(symbols=[],offset=0,batchSize=10) {
  const rows=[...new Set((Array.isArray(symbols)?symbols:[]).map(x=>String(x).toUpperCase()).filter(x=>/^[A-Z0-9]{3,20}USDT$/.test(x)))];
  if(!rows.length)return {symbols:[],nextOffset:0,offset:0};
  const start=((Math.floor(Number(offset)||0)%rows.length)+rows.length)%rows.length,count=Math.min(rows.length,Math.max(1,Math.floor(Number(batchSize)||10)));
  return {symbols:Array.from({length:count},(_,i)=>rows[(start+i)%rows.length]),offset:start,nextOffset:(start+count)%rows.length};
}
const UNIVERSE_CURSOR_ID='scheduler:bitget:usdt-m:universe';
const UNIVERSE_ROTATION_MS=5*60*1000;
export async function loadBitgetPerpetualWatchlist(db,fetchImpl=fetch,now=Date.now(),batchSize=10) {
  const base='https://api.bitget.com/api/v2/mix/market/';
  const [contractsResponse,tickersResponse]=await Promise.all([
    fetchImpl(base+'contracts?productType=USDT-FUTURES',{headers:{accept:'application/json'},cf:{cacheTtl:60}}),
    fetchImpl(base+'tickers?productType=USDT-FUTURES',{headers:{accept:'application/json'},cf:{cacheTtl:30}})
  ]);
  if(!contractsResponse.ok||!tickersResponse.ok)throw new Error('Bitget perpetual instrument catalog returned an unsuccessful HTTP response.');
  const [contractsPayload,tickersPayload]=await Promise.all([contractsResponse.json(),tickersResponse.json()]);
  if(contractsPayload.code&&contractsPayload.code!=='00000')throw new Error('Bitget contract catalog: '+String(contractsPayload.msg||contractsPayload.code));
  if(tickersPayload.code&&tickersPayload.code!=='00000')throw new Error('Bitget ticker catalog: '+String(tickersPayload.msg||tickersPayload.code));
  const universe=normalizeBitgetPerpetualUniverse(contractsPayload.data,tickersPayload.data);
  if(!universe.length)throw new Error('Bitget returned no active USDT perpetual contracts.');
  let prior={offset:0,activeSymbols:[],lastRotatedAt:null};
  try{const row=await db.prepare('SELECT cursor_value FROM jpti_multi_asset_backfill_cursors WHERE cursor_id=?').bind(UNIVERSE_CURSOR_ID).first();if(row?.cursor_value)prior={...prior,...JSON.parse(row.cursor_value)};}catch{}
  const elapsed=prior.lastRotatedAt?now-Date.parse(prior.lastRotatedAt):Infinity;
  if(Array.isArray(prior.activeSymbols)&&prior.activeSymbols.length&&elapsed<UNIVERSE_ROTATION_MS)
    return {symbols:prior.activeSymbols,previousSymbols:[],universeSize:universe.length,nextOffset:Number(prior.offset)||0,rotated:false};
  const selected=selectRoundRobinBatch(universe.map(x=>x.symbol),prior.offset,batchSize),at=new Date(now).toISOString();
  const next={offset:selected.nextOffset,activeSymbols:selected.symbols,lastRotatedAt:at};
  await db.prepare('INSERT INTO jpti_multi_asset_backfill_cursors(cursor_id,provider,asset_class,symbol,market_type,stream_kind,cursor_value,status,records_ingested,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cursor_id) DO UPDATE SET cursor_value=excluded.cursor_value,status=excluded.status,last_error=NULL,updated_at=excluded.updated_at')
    .bind(UNIVERSE_CURSOR_ID,'bitget','crypto','*','usdt-m','scheduler-universe',JSON.stringify(next),'ready',0,null,at).run();
  try{const statements=universe.map(x=>db.prepare('INSERT INTO jpti_multi_asset_instruments(instrument_id,asset_class,symbol,market_type,venue,enabled,provider_status,metadata_json,updated_at) VALUES(?,?,?,?,?,1,?,?,?) ON CONFLICT(asset_class,symbol,market_type,venue) DO UPDATE SET enabled=1,provider_status=excluded.provider_status,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at')
    .bind('bitget-usdt-m-'+x.symbol,'crypto',x.symbol,'usdt-m','bitget','catalogued',JSON.stringify({baseCoin:x.baseCoin,quoteCoin:x.quoteCoin,volume24hUsd:x.volume24hUsd}),at));
   for(let i=0;i<statements.length;i+=100)await db.batch(statements.slice(i,i+100));
  }catch(error){console.warn('[JPTI paper scheduler] instrument catalog persistence unavailable:',shortError(error));}
  return {symbols:selected.symbols,previousSymbols:Array.isArray(prior.activeSymbols)?prior.activeSymbols:[],universeSize:universe.length,nextOffset:selected.nextOffset,rotated:true};
}
export function buildStreamStartPayload(rows = [],prioritySymbols=[]) {
  const streams = (Array.isArray(rows) ? rows : []).map(row => ({
    exchange: String(row.exchange || '').toLowerCase(),
    marketType: String(row.market_type || row.marketType || '').toLowerCase(),
    symbol: String(row.symbol || '').toUpperCase().replace(/USDT$/, '/USDT').replace('//', '/')
  })).filter(x => ['binance','bybit','okx','bitget'].includes(x.exchange)
    && ['spot','margin','usdt-m','coin-m','usdc-m'].includes(x.marketType) && /^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(x.symbol));
  const prioritized=(Array.isArray(prioritySymbols)?prioritySymbols:[]).flatMap(symbol=>['binance','bybit','okx','bitget'].map(exchange=>({exchange,marketType:'usdt-m',symbol:String(symbol).toUpperCase().replace(/USDT$/,'/USDT').replace('//','/')})));
  const unique=new Map([...prioritized,...(streams.length?streams:STREAM_FALLBACK)].map(x=>[x.exchange+':'+x.marketType+':'+x.symbol,x]));
  return { streams: [...unique.values()].slice(0, 40) };
}
export async function startMarketStreamCollector(env,prioritySymbols=[],previousSymbols=[]) {
  if (!env.MARKET_STREAMS) throw new Error('MARKET_STREAMS Durable Object binding is not configured.');
  const rows = await env.JPTI_DB.prepare("SELECT exchange,market_type,symbol,MAX(observed_at) AS last_seen FROM jpti_market_observations WHERE market_type IN ('spot','margin','usdt-m','coin-m','usdc-m') GROUP BY exchange,market_type,symbol ORDER BY last_seen DESC LIMIT 40").all();
  const payload = buildStreamStartPayload(rows.results || [],prioritySymbols);
  const stopped=[];
  const active=new Set((Array.isArray(prioritySymbols)?prioritySymbols:[]).map(x=>String(x).toUpperCase()));
  const results = [];
  for (let i = 0; i < payload.streams.length; i += 6) {
    const batch = await Promise.all(payload.streams.slice(i, i + 6).map(async item => {
      const config = normalizeStreamRequest(item);
      const id = env.MARKET_STREAMS.idFromName(config.streamId);
      const stub = env.MARKET_STREAMS.get(id);
      const response = await stub.fetch('https://stream-hub/start', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config)
      });
      if (!response.ok) throw new Error('Stream ' + config.streamId + ' returned HTTP ' + response.status + '.');
      return { streamId: config.streamId, ...(await response.json()) };
    }));
    results.push(...batch);
  }
  const started = results.filter(x => x.status === 'connected' || x.status === 'connecting').length;
  if (started < 1) throw new Error('No market streams were started.');
  for(const symbol of (Array.isArray(previousSymbols)?previousSymbols:[]).filter(x=>!active.has(String(x).toUpperCase()))){
    for(const exchange of ['binance','bybit','okx','bitget'])try{const config=normalizeStreamRequest({exchange,marketType:'usdt-m',symbol:String(symbol).replace(/USDT$/,'/USDT')});const stub=env.MARKET_STREAMS.get(env.MARKET_STREAMS.idFromName(config.streamId));await stub.fetch('https://stream-hub/stop',{method:'POST'});stopped.push(config.streamId);}catch{}
  }
  return { requested: results.length, started, stopped:stopped.length, results };
}

export default {
  async scheduled(event, env, ctx) {
    if (!env.JPTI_DB) throw new Error('JPTI_DB D1 binding is required.');
    const task = (async () => {
      const failures = [], streamFailures = [];
      let watchlist=[...WATCHLIST],previousSymbols=[],universeSize=WATCHLIST.length;
      try{const selected=await loadBitgetPerpetualWatchlist(env.JPTI_DB);if(selected.symbols.length){watchlist=selected.symbols;previousSymbols=selected.previousSymbols;universeSize=selected.universeSize;}}
      catch(error){streamFailures.push({stage:'perpetual-universe',error:shortError(error),fallback:'static-watchlist'});}
      try { await startMarketStreamCollector(env,watchlist,previousSymbols); }
      catch (error) { streamFailures.push({ stage: 'market-stream-collector', error: shortError(error) }); }
      // Symbols run sequentially on purpose: each cycle reads fleet exposure from D1 before opening
      // a position, so parallel cycles could both pass the same concentration gate.
      try { await ensureAgents(env.JPTI_DB); }
      catch (error) { failures.push({ stage: 'ensure-agents', error: shortError(error) }); }
      if (!failures.length) {
        for (const symbol of watchlist) {
          try { await runCycle(env.JPTI_DB, symbol, { agentsEnsured: true }, env); }
          catch (error) { failures.push({ stage: 'cycle', symbol, error: shortError(error) }); }
        }
      }
      // The daily review must not be skipped, nor lose its own failure, because a market cycle failed.
      if (isDailyReviewDue(event)) {
        try { await dailyReview(env.JPTI_DB); }
        catch (error) { failures.push({ stage: 'daily-review', error: shortError(error) }); }
      }
      if (failures.length || streamFailures.length) {
        // Each invocation receives a unique health-event ID so overlapping retries cannot overwrite diagnostics.
        const at = new Date().toISOString();
        const id = 'paper-scheduler:' + at + ':' + crypto.randomUUID().slice(0, 8);
        try {
          await env.JPTI_DB.prepare("INSERT OR IGNORE INTO jpti_events(id,kind,source,external_id,occurred_at,payload) VALUES(?, 'paper-scheduler-health','jpti-paper-scheduler',?,?,?)")
            .bind(id, String(event.cron || 'manual'), at, JSON.stringify({ failures, streamFailures, watchlist, universeSize, cron: event.cron || null, mode: 'PAPER_ONLY' })).run();
        } catch (error) {
          console.error('[JPTI paper scheduler] could not record health event:', shortError(error), JSON.stringify(failures));
        }
      }
    })();
    ctx.waitUntil(task);
  }
};
