const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:H});
const parse=(v,f={})=>{try{return typeof v==='string'?JSON.parse(v):v??f;}catch{return f;}};
const EXCHANGES=['binance','bybit','okx','bitget'];
export async function onRequest({request,env}){
 if(request.method!=='GET')return json(405,{error:'Read-only GET endpoint.'});
 if(!env.JPTI_DB)return json(503,{error:'D1 binding unavailable.'});
 const u=new URL(request.url),symbol=String(u.searchParams.get('symbol')||'').toUpperCase();
 const exchange=String(u.searchParams.get('exchange')||'all').toLowerCase();
 const marketType=String(u.searchParams.get('marketType')||'').toLowerCase();
 const timeframe=String(u.searchParams.get('timeframe')||'1m');
 const limit=Math.max(1,Math.min(20000,Number(u.searchParams.get('limit'))||100));
 if(exchange!=='all'&&!EXCHANGES.includes(exchange))return json(400,{error:'Unsupported exchange filter.'});
 if(marketType&&!['spot','margin','usdt-m','coin-m','usdc-m'].includes(marketType))return json(400,{error:'Unsupported marketType filter.'});
 const where=[],args=[],compact=symbol.replace('/','');
 if(symbol){where.push('symbol IN (?,?)');args.push(symbol,compact);}
 if(exchange!=='all'){where.push('exchange=?');args.push(exchange);}
 if(marketType){where.push('market_type=?');args.push(marketType);}
 const w=where.length?' AND '+where.join(' AND '):'';
 const result={source:'jpti-cloudflare-d1-live-data-plane',generatedAt:new Date().toISOString(),filters:{symbol,exchange,marketType,timeframe},liveExecutionAuthorized:false,sections:{}};
 const query=async(name,sql,values)=>{try{const r=await env.JPTI_DB.prepare(sql).bind(...values).all();result.sections[name]={status:'available',count:r.results?.length||0,items:(r.results||[]).map(x=>({...x,payload:parse(x.payload),quality:parse(x.quality)}))};}catch(e){result.sections[name]={status:'migration-required-or-unavailable',count:0,items:[],error:String(e?.message||e).slice(0,120)};}};
 await Promise.all([
  query('tickerAndCandles',"SELECT exchange,market_type,symbol,observation_kind,timeframe,observed_at,received_at,payload,quality FROM jpti_market_observations WHERE 1=1"+w+" AND (observation_kind='ticker' OR (observation_kind='ohlcv' AND timeframe=?)) ORDER BY observed_at DESC LIMIT ?",[...args,timeframe,limit]),
  query('microstructure',"SELECT exchange,market_type,symbol,observation_kind,event_id,observed_at,received_at,payload,quality FROM jpti_microstructure_observations WHERE 1=1"+w+" ORDER BY observed_at DESC LIMIT ?",[...args,limit]),
  query('websocketEvents',"SELECT exchange,market_type,symbol,event_kind,event_id,sequence,observed_at,received_at,payload,quality FROM jpti_market_stream_events WHERE 1=1"+w+" ORDER BY observed_at DESC LIMIT ?",[...args,limit]),
  query('streamBooks',"SELECT stream_id,exchange,market_type,symbol,last_sequence,book_valid,best_bid,best_ask,spread_bps,depth_imbalance,notional_imbalance,book_json AS payload,updated_at FROM jpti_market_stream_books WHERE 1=1"+w+" ORDER BY updated_at DESC LIMIT ?",[...args,limit]),
  query('streamState',"SELECT stream_id,exchange,market_type,symbol,status,last_sequence,book_valid,last_event_at,state_json,updated_at FROM jpti_market_stream_state WHERE 1=1"+w+" ORDER BY updated_at DESC LIMIT ?",[...args,limit]),
  query('sequenceGaps',"SELECT stream_id,exchange,market_type,symbol,detected_at,reason,detail,recovered_at FROM jpti_market_stream_gaps WHERE 1=1"+w+" ORDER BY detected_at DESC LIMIT ?",[...args,limit])
 ]);
 const streamBase=env.JPTI_MARKET_STREAM?'https://jpti-market-stream-collector':String(env.JPTI_MARKET_STREAM_URL||'').replace(/\/$/,'');
 const streamFetch=env.JPTI_MARKET_STREAM?.fetch?env.JPTI_MARKET_STREAM.fetch.bind(env.JPTI_MARKET_STREAM):fetch;
 if(streamBase&&symbol&&marketType){
  const exchanges=exchange==='all'?EXCHANGES:[exchange],perVenueLimit=exchange==='all'?Math.max(1,Math.ceil(limit/exchanges.length)):limit;
  const histories=await Promise.all(exchanges.map(async venue=>{
   try{
    const url=new URL(streamBase+'/history');url.searchParams.set('exchange',venue);url.searchParams.set('marketType',marketType);
    url.searchParams.set('symbol',symbol);url.searchParams.set('since',u.searchParams.get('since')||new Date(Date.now()-3600000).toISOString());
    url.searchParams.set('until',u.searchParams.get('until')||new Date().toISOString());url.searchParams.set('limit',String(perVenueLimit));
    if(u.searchParams.has('kind'))url.searchParams.set('kind',u.searchParams.get('kind'));
    const response=await streamFetch(url,{headers:{accept:'application/json'}});
    if(!response.ok)return{venue,status:'unavailable',httpStatus:response.status,events:[]};
    const body=await response.json();return{venue,status:'available',events:body.events||[]};
   }catch(error){return{venue,status:'unavailable',error:String(error?.message||error).slice(0,120),events:[]};}
  }));
  const events=histories.flatMap(h=>h.events.map(event=>({...event,exchange:event.exchange||h.venue}))).sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)).slice(-limit);
  result.sections.completeWebSocketHistory={status:histories.some(h=>h.status==='available')?'available':'unavailable',storage:'durable-object-sqlite',venues:histories.map(h=>({exchange:h.venue,status:h.status,count:h.events.length,error:h.error||null})),count:events.length,items:events};
 }
 return json(200,result);
}
