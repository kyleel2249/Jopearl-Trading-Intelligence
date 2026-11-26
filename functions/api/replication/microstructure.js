import {
 normalizeMicrostructurePlan, buildMicrostructureUrl, normalizeMicrostructurePayload,
 microstructureObservationKey, summarizeMicrostructureCoverage, summarizeMicrostructureObservations
} from '../../src/microstructure-replication-engine.js';
import { verifyPrivateToken } from '../private-auth.js';

const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:H});
const MAX_BODY=16000;
async function readBody(request){const raw=await request.text();if(new TextEncoder().encode(raw).length>MAX_BODY)return{error:'Request exceeds 16 KB.',status:413};try{return{value:raw?JSON.parse(raw):{}};}catch{return{error:'Invalid JSON request.',status:400};}}
async function fetchJson(url,fetchImpl,timeoutMs=9000){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetchImpl(url,{method:'GET',headers:{accept:'application/json'},cache:'no-store',signal:controller.signal});
  const payload=await response.json().catch(()=>null);
  if(!response.ok)throw new Error('Exchange HTTP '+response.status+' '+String(payload?.msg||payload?.message||'').slice(0,100));
  if(payload?.retCode!==undefined&&Number(payload.retCode)!==0)throw new Error(String(payload.retMsg||'Exchange rejected request').slice(0,160));
  if(payload?.code!==undefined&&String(payload.code)!=='0'&&String(payload.code)!=='00000')throw new Error(String(payload.msg||'Exchange rejected request').slice(0,160));
  if(payload?.code!==undefined&&Number(payload.code)<0)throw new Error(String(payload.msg||'Exchange rejected request').slice(0,160));
  return payload;
 }finally{clearTimeout(timer);}
}
async function mapLimit(items,limit,worker){
 const out=new Array(items.length);let cursor=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;try{out[i]=await worker(items[i]);}catch(error){out[i]={status:'failed',error:String(error?.message||error).slice(0,180)};}}}));
 return out;
}
function supports(exchange,kind,marketType){
 if((kind==='funding'||kind==='open_interest')&&(marketType==='spot'||marketType==='margin'))return false;
 if(kind==='liquidation')return exchange==='okx';
 return true;
}
async function save(db,rows){
 let inserted=0;
 for(let i=0;i<rows.length;i+=40){
  const batch=rows.slice(i,i+40).map(row=>db.prepare(
   'INSERT OR IGNORE INTO jpti_microstructure_observations (observation_key,exchange,market_type,symbol,observation_kind,event_id,observed_at,received_at,payload,quality) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(microstructureObservationKey(row),row.exchange,row.marketType,row.symbol,row.kind,row.eventId,row.observedAt,row.receivedAt,JSON.stringify(row.payload),JSON.stringify(row.quality||{})));
  const result=await db.batch(batch);inserted+=(result||[]).reduce((sum,r)=>sum+Number(r?.meta?.changes||0),0);
 }
 return inserted;
}
async function status(db){
 const [totals,runs,coverage]=await Promise.all([
  db.prepare('SELECT COUNT(*) observations,COUNT(DISTINCT exchange) exchanges,COUNT(DISTINCT symbol) symbols,MAX(received_at) last_received_at FROM jpti_microstructure_observations').first(),
  db.prepare('SELECT run_id,status,started_at,finished_at,duration_ms,summary_json FROM jpti_microstructure_runs ORDER BY started_at DESC LIMIT 8').all(),
  db.prepare('SELECT exchange,market_type,observation_kind,COUNT(*) observations,COUNT(DISTINCT symbol) symbols,MAX(received_at) last_received_at FROM jpti_microstructure_observations GROUP BY exchange,market_type,observation_kind ORDER BY exchange,market_type,observation_kind').all()
 ]);
 return{service:'JPTI microstructure replication',storage:'Cloudflare D1',totals:totals||{},coverage:coverage?.results||[],recentRuns:(runs?.results||[]).map(r=>({runId:r.run_id,status:r.status,startedAt:r.started_at,finishedAt:r.finished_at,durationMs:r.duration_ms,summary:safeJson(r.summary_json,{})}))};
}
function safeJson(v,fallback){try{return typeof v==='string'?JSON.parse(v):v??fallback;}catch{return fallback;}}
async function history(db,url){
 const exchange=String(url.searchParams.get('exchange')||'').toLowerCase(),symbol=String(url.searchParams.get('symbol')||'').toUpperCase(),kind=String(url.searchParams.get('kind')||'').toLowerCase(),marketType=String(url.searchParams.get('marketType')||'').toLowerCase();
 const limit=Math.max(1,Math.min(500,Number(url.searchParams.get('limit'))||100));
 const clauses=[],args=[];
 if(exchange){clauses.push('exchange=?');args.push(exchange);}
 if(symbol){clauses.push('symbol=?');args.push(symbol);}
 if(kind){if(!['orderbook','trade','funding','open_interest','liquidation'].includes(kind))return{status:400,body:{error:'Unsupported observation kind.'}};clauses.push('observation_kind=?');args.push(kind);}
 if(marketType){clauses.push('market_type=?');args.push(marketType);}
 if(url.searchParams.has('since')){const since=String(url.searchParams.get('since'));if(!Number.isFinite(Date.parse(since)))return{status:400,body:{error:'since must be an ISO timestamp.'}};clauses.push('observed_at>=?');args.push(new Date(since).toISOString());}
 args.push(limit);
 const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
 const result=await db.prepare('SELECT exchange,market_type,symbol,observation_kind,event_id,observed_at,received_at,payload,quality FROM jpti_microstructure_observations'+where+' ORDER BY observed_at DESC LIMIT ?').bind(...args).all();
 return{status:200,body:{count:result?.results?.length||0,observations:(result?.results||[]).map(r=>({...r,payload:safeJson(r.payload,{}),quality:safeJson(r.quality,{})})),source:'jpti-cloudflare-d1-microstructure'}};
}
export function createMicrostructureReplicationHandler({fetchImpl=fetch,now=()=>new Date(),verifyToken=verifyPrivateToken}={}){
 return async function onRequest({request,env={}}){
  const url=new URL(request.url);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{allow:'GET, POST, OPTIONS','access-control-allow-methods':'GET, POST, OPTIONS','access-control-allow-headers':'content-type, x-jpti-api-token, authorization'}});
  if(!env.JPTI_DB)return json(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'});
  if(request.method==='GET'){
   try{if(['exchange','symbol','kind','marketType','since'].some(k=>url.searchParams.has(k))) {const r=await history(env.JPTI_DB,url);return json(r.status,r.body);}return json(200,await status(env.JPTI_DB));}
   catch(error){return json(503,{error:'Microstructure history query failed.',detail:String(error?.message||error).slice(0,160)});}
  }
  if(request.method!=='POST')return json(405,{error:'Use GET or POST.'});
  const auth=await verifyToken(request,env,{unconfigured:'Set JPTI_API_TOKEN or JPTI_JOURNAL_TOKEN.',rejected:'Microstructure replication authorization failed.'});
  if(!auth.ok)return json(auth.status,{error:auth.error});
  const parsed=await readBody(request);if(parsed.error)return json(parsed.status,{error:parsed.error});
  let plan;try{plan=normalizeMicrostructurePlan(parsed.value);}catch(error){return json(error.status||400,{error:error.message});}
  const tasks=[];
  for(const symbol of plan.symbols)for(const kind of plan.kinds)for(const exchange of plan.exchanges)tasks.push({exchange,symbol,kind});
  const selected=tasks.slice(0,plan.maxRequests),omitted=tasks.length-selected.length;
  const startedAt=now().toISOString(),runId=crypto.randomUUID(),observations=[],results=[];
  await env.JPTI_DB.prepare("INSERT INTO jpti_microstructure_runs(run_id,status,started_at,plan_json,summary_json) VALUES(?,'running',?,?,?)").bind(runId,startedAt,JSON.stringify({...plan,selectedRequests:selected.length,omittedRequests:omitted}),JSON.stringify({})).run();
  const collected=await mapLimit(selected,3,async task=>{
   if(!supports(task.exchange,task.kind,plan.marketType))return{...task,status:'unsupported',count:0,reason:'This venue/category does not expose this observation through the configured public REST adapter.'};
   const endpoint=buildMicrostructureUrl(task.exchange,task.symbol,task.kind,plan.marketType,task.kind==='orderbook'?plan.depthLimit:plan.tradeLimit);
   if(!endpoint)return{...task,status:'unsupported',count:0,reason:'No public REST adapter is configured for this observation.'};
   const payload=await fetchJson(endpoint,fetchImpl);
   const rows=normalizeMicrostructurePayload({...task,marketType:plan.marketType,payload,receivedAt:now().getTime()});
   observations.push(...rows);
   return{...task,status:rows.length?'stored':'empty',count:rows.length};
  });
  results.push(...collected);
  let inserted=0,writeError=null;
  try{inserted=await save(env.JPTI_DB,observations);}catch(error){writeError=String(error?.message||error).slice(0,180);}
  const finishedAt=now().toISOString(),coverage=summarizeMicrostructureCoverage(results);
  const summary={runId,startedAt,finishedAt,durationMs:Math.max(0,Date.parse(finishedAt)-Date.parse(startedAt)),status:writeError?'failed':coverage.failed?(inserted?'partial':'failed'):coverage.unsupported||omitted?'partial':coverage.observations?'completed':'partial',plan,requestedTasks:tasks.length,processedTasks:selected.length,omittedTasks:omitted,inserted,duplicates:Math.max(0,coverage.observations-inserted),coverage,analytics:summarizeMicrostructureObservations(observations),writeError};
  try{await env.JPTI_DB.prepare('UPDATE jpti_microstructure_runs SET status=?,finished_at=?,duration_ms=?,summary_json=? WHERE run_id=?').bind(summary.status,finishedAt,summary.durationMs,JSON.stringify(summary),runId).run();}
  catch(error){return json(503,{error:'Collected observations but failed to finalize run metadata.',runId,detail:String(error?.message||error).slice(0,150),summary});}
  return json(summary.status==='failed'?502:200,{...summary,storage:'cloudflare-d1',publicDataOnly:true,liveExecutionAuthorized:false});
 };
}
const handler=createMicrostructureReplicationHandler();
export async function onRequest(context){return handler(context);}
