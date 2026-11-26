import {verifyPrivateToken} from '../../private-auth.js';
import {buildMultiAssetOverview,normalizeAssetInstrument,evaluateMultiAssetOpportunity,allocateAdaptiveCapital,evaluateStrategyLifecycle,replayEventsByEventTime,reconcileExecutionLedgers} from '../../../src/multi-asset-intelligence-engine.js';
const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:H});
const id=s=>String(s||'').trim().slice(0,120);
export async function onRequest({request,env}) {
 if(!env.JPTI_DB)return json(503,{error:'JPTI_DB is unavailable; persistent multi-asset state is disabled.'});
 const auth=await verifyPrivateToken(request,env,{unconfigured:'JPTI private API token is not configured.',rejected:'Private API authorization failed.'});
 if(!auth.ok)return json(auth.status,{error:auth.error});
 try{
  if(request.method==='GET'){
   const overview=buildMultiAssetOverview();
   const [instruments,decisions,cursors,strategies,agents]=await Promise.all([
    env.JPTI_DB.prepare('SELECT * FROM jpti_multi_asset_instruments ORDER BY asset_class,symbol').all(),
    env.JPTI_DB.prepare('SELECT decision_id,asset_class,symbol,venue,direction,score,confidence,eligible,action,veto_json,created_at FROM jpti_multi_asset_decisions ORDER BY created_at DESC LIMIT 100').all(),
    env.JPTI_DB.prepare('SELECT cursor_id,provider,asset_class,symbol,market_type,stream_kind,cursor_value,status,records_ingested,last_error,updated_at FROM jpti_multi_asset_backfill_cursors ORDER BY updated_at DESC LIMIT 100').all(),
    env.JPTI_DB.prepare('SELECT strategy_id,asset_class,symbol,closed_trades,expectancy_r,profit_factor,max_drawdown_pct,decay_detected,risk_breaches,data_integrity,lifecycle_status,updated_at FROM jpti_multi_asset_strategy_performance ORDER BY updated_at DESC LIMIT 100').all(),
    env.JPTI_DB.prepare('SELECT agent_id,squad_id,display_name,specialty,style,timeframe,enabled,execution_permission,updated_at FROM jpti_multi_asset_agent_roster ORDER BY squad_id,display_name').all()
   ]);
   return json(200,{...overview,persisted:{instruments:instruments.results||[],decisions:(decisions.results||[]).map(x=>({...x,vetoes:safe(x.veto_json)})),backfillCursors:cursors.results||[],strategies:strategies.results||[],agents:agents.results||[]},note:'Only configured and verified feeds can qualify an instrument for research. No exchange order routes are exposed.'});
  }
  if(request.method!=='POST')return json(405,{error:'Use GET or POST.'});
  const raw=await request.text();if(raw.length>50000)return json(413,{error:'Request exceeds 50 KB.'});
  const body=raw?JSON.parse(raw):{},action=id(body.action),now=new Date().toISOString();
  if(action==='evaluate'){
   const trustedInput={...body,riskContext:null,evidence:{...(body.evidence||{}),dataQuality:'unverified-client-input',eventTimeReliable:false}};
   const result=evaluateMultiAssetOpportunity(trustedInput,{});
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_decisions(decision_id,asset_class,symbol,venue,agent_squad,direction,score,confidence,eligible,action,veto_json,evidence_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(result.decisionId,result.instrument.assetClass,result.instrument.symbol,result.instrument.venue,String(body.agentSquad||'scalping'),result.direction,result.score,result.confidence,result.eligible?1:0,result.action,JSON.stringify(result.veto),JSON.stringify(body.evidence||{}),now).run();
   return json(200,{...result,persisted:true,evidenceTrust:'unverified-client-input',liveExecutionAuthorized:false});
  }
  if(action==='backfill-stream-history'){
   if(!env.JPTI_MARKET_STREAM?.fetch)return json(503,{error:'JPTI_MARKET_STREAM service binding is unavailable.'});
   const instrument=normalizeAssetInstrument(body),exchange=id(body.exchange||instrument.venue).toLowerCase();
   if(instrument.assetClass!=='crypto')return json(400,{error:'Durable Object stream-history recovery currently supports crypto instruments only; other asset-class backfill requires its configured provider adapter.'});
   if(!['binance','bybit','okx','bitget'].includes(exchange))return json(400,{error:'Unsupported stream exchange.'});
   const from=Date.parse(body.since||''),requestedUntil=Date.parse(body.until||now);
   if(!Number.isFinite(from)||!Number.isFinite(requestedUntil)||requestedUntil<=from)return json(400,{error:'Valid since and until timestamps are required.'});
   const limit=Math.max(100,Math.min(20000,Number(body.limit)||5000));
   const cursorId=['stream',exchange,instrument.marketType,instrument.symbol,'all-events'].join(':');
   const previous=await env.JPTI_DB.prepare('SELECT cursor_value,status FROM jpti_multi_asset_backfill_cursors WHERE cursor_id=?').bind(cursorId).first();
   const until=previous?.cursor_value?Date.parse(previous.cursor_value):requestedUntil;
   if(!Number.isFinite(until)||until<=from)return json(200,{status:'complete',cursorId,ingested:0,nextCursor:null});
   const url=new URL('https://jpti-market-stream-collector/history');
   url.searchParams.set('exchange',exchange);url.searchParams.set('marketType',instrument.marketType);url.searchParams.set('symbol',instrument.symbol);
   url.searchParams.set('since',new Date(from).toISOString());url.searchParams.set('until',new Date(until).toISOString());url.searchParams.set('limit',String(limit));
   const response=await env.JPTI_MARKET_STREAM.fetch(url.toString(),{headers:{accept:'application/json'}});
   if(!response.ok)throw new Error('Market stream history returned HTTP '+response.status+'.');
   const page=await response.json(),events=Array.isArray(page.events)?page.events:[];
   const statements=events.map(event=>{
    const observedAt=event.observedAt||event.observed_at,receivedAt=event.received_at||event.receivedAt||observedAt;
    const eventId=String(event.event_id||event.eventId||observedAt),kind=String(event.event_kind||event.kind||'unknown');
    const key=[page.streamId||cursorId,kind,eventId].join('|');
    return env.JPTI_DB.prepare('INSERT OR IGNORE INTO jpti_market_stream_events(event_key,stream_id,exchange,market_type,symbol,event_kind,event_id,sequence,observed_at,received_at,payload,quality) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
     .bind(key,page.streamId||cursorId,exchange,instrument.marketType,instrument.symbol,kind,eventId,event.sequence==null?null:(Number.isFinite(Number(event.sequence))?Number(event.sequence):null),new Date(observedAt).toISOString(),new Date(receivedAt).toISOString(),JSON.stringify(event.payload||{}),JSON.stringify(event.quality||{}));
   });
   let ingested=0;
   for(let i=0;i<statements.length;i+=100){const results=await env.JPTI_DB.batch(statements.slice(i,i+100));ingested+=results.reduce((sum,result)=>sum+(Number(result.meta?.changes)||0),0);}
   const oldest=events.length?Date.parse(events[0].observedAt||events[0].observed_at):NaN;
   const nextUntil=events.length===limit&&Number.isFinite(oldest)&&oldest>from?new Date(oldest-1).toISOString():null;
   const status=nextUntil?'partial':'complete';
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_backfill_cursors(cursor_id,provider,asset_class,symbol,market_type,stream_kind,cursor_value,status,records_ingested,last_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cursor_id) DO UPDATE SET cursor_value=excluded.cursor_value,status=excluded.status,records_ingested=jpti_multi_asset_backfill_cursors.records_ingested+excluded.records_ingested,last_error=NULL,updated_at=excluded.updated_at')
    .bind(cursorId,exchange,instrument.assetClass,instrument.symbol,instrument.marketType,'stream-events',nextUntil, status,ingested,null,now).run();
   return json(200,{cursorId,status,requested:events.length,ingested,nextCursor:nextUntil,source:'persistent Durable Object event history',streamId:page.streamId||null,liveExecutionAuthorized:false});
  }
  if(action==='backfill-checkpoint'){
   const instrument=normalizeAssetInstrument(body),provider=id(body.provider||instrument.venue),streamKind=id(body.streamKind||'ohlcv'),cursorId=[provider,instrument.assetClass,instrument.symbol,instrument.marketType,streamKind].join(':');
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_backfill_cursors(cursor_id,provider,asset_class,symbol,market_type,stream_kind,cursor_value,status,records_ingested,last_error,updated_at) VALUES(?,?,?,?,?,?,?, ?,?,?,?) ON CONFLICT(cursor_id) DO UPDATE SET cursor_value=excluded.cursor_value,status=excluded.status,records_ingested=jpti_multi_asset_backfill_cursors.records_ingested+excluded.records_ingested,last_error=excluded.last_error,updated_at=excluded.updated_at')
    .bind(cursorId,provider,instrument.assetClass,instrument.symbol,instrument.marketType,streamKind,body.cursorValue==null?null:String(body.cursorValue),id(body.status||'ready'),Math.max(0,Number(body.recordsIngested)||0),body.lastError?String(body.lastError).slice(0,300):null,now).run();
   return json(200,{cursorId,status:'checkpointed',cursorValue:body.cursorValue??null,liveExecutionAuthorized:false});
  }
  if(action==='allocate'){
   const result=allocateAdaptiveCapital(Array.isArray(body.candidates)?body.candidates:[],body.portfolio||{},body.policy||{});
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_capital_allocations(allocation_id,portfolio_equity_usd,portfolio_risk_budget_usd,drawdown_pct,allocations_json,blocked,created_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),result.equityUsd,result.portfolioRiskBudgetUsd,Number(body.portfolio?.drawdownPct)||0,JSON.stringify(result.allocations),result.blocked?1:0,now).run();
   return json(200,{...result,persisted:true});
  }
  if(action==='strategy-review'){
   const result=evaluateStrategyLifecycle(body.metrics||{},body.policy||{});
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_strategy_lifecycle(strategy_id,asset_class,symbol,status,reason_json,human_review_required,updated_at) VALUES(?,?,?,?,?,1,?) ON CONFLICT(strategy_id,asset_class,symbol) DO UPDATE SET status=excluded.status,reason_json=excluded.reason_json,human_review_required=1,updated_at=excluded.updated_at').bind(id(body.strategyId),String(body.assetClass),String(body.symbol),result.status,JSON.stringify(result.failures),now).run();
   return json(200,{...result,liveExecutionAuthorized:false});
  }
  if(action==='reconcile'){
   const result=reconcileExecutionLedgers(body.backtest||[],body.paper||[],body.actual||[]);
   await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_reconciliation(reconciliation_id,matched,discrepancy_count,discrepancies_json,created_at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),result.matched,result.discrepancyCount,JSON.stringify(result.discrepancies),now).run();
   return json(200,{...result,persisted:true});
  }
  if(action==='replay-order'){
   const replayId=id(body.replayId),streamId=id(body.streamId);
   if(!replayId||!streamId||!Array.isArray(body.events))return json(400,{error:'replayId, streamId and an events array are required.'});
   const events=replayEventsByEventTime(body.events),last=events.at(-1)||null;
   if(last){
    const eventTime=last.eventTime||last.observedAt||last.timestamp;
    await env.JPTI_DB.prepare('INSERT INTO jpti_multi_asset_replay_checkpoints(replay_id,stream_id,last_event_time,last_sequence,processed_events,state_json,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(replay_id,stream_id) DO UPDATE SET last_event_time=excluded.last_event_time,last_sequence=excluded.last_sequence,processed_events=jpti_multi_asset_replay_checkpoints.processed_events+excluded.processed_events,state_json=excluded.state_json,updated_at=excluded.updated_at')
     .bind(replayId,streamId,new Date(typeof eventTime==='number'?(eventTime<1e11?eventTime*1000:eventTime):Date.parse(eventTime)).toISOString(),Number.isFinite(Number(last.sequence))?Number(last.sequence):null,events.length,JSON.stringify(body.state||{}),now).run();
   }
   return json(200,{events,processed:events.length,lastEvent:last,checkpointPersisted:!!last,liveExecutionAuthorized:false});
  }
  return json(400,{error:'Unknown action. Supported actions: evaluate, backfill-stream-history, backfill-checkpoint, allocate, strategy-review, reconcile, replay-order.'});
 }catch(error){const missing=/no such table/i.test(String(error?.message||''));return json(missing?503:400,{error:missing?'Apply migration 0019_multi_asset_intelligence_3 before using this API.':String(error?.message||error).slice(0,300),liveExecutionAuthorized:false});}
}
function safe(v){try{return JSON.parse(v||'[]')}catch{return[]}}
