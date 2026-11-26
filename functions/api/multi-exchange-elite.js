import { rankMultiExchangeTraders, getMultiExchangeStatus } from '../../src/multi-exchange-elite-engine.js';
import { verifyPrivateToken } from '../private-auth.js';

const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
async function readJson(request){
 const raw=await request.text();
 if(new TextEncoder().encode(raw).byteLength>1024*1024)return {error:'Request exceeds 1 MB.',status:413};
 try{return {value:raw.trim()?JSON.parse(raw):{}};}catch{return {error:'Valid JSON is required.',status:400};}
}
async function persist(db,result){
 const now=result.generatedAt;
 const rows=[
  {kind:'multi-exchange-elite-ranking',payload:result},
  {kind:'shared-intelligence-memory-event',payload:{eventType:'multi-exchange-elite-ranking',rankingId:result.id,generatedAt:now,exchangeSummary:result.exchangeSummary,selected:result.selected.map(x=>({traderId:x.traderId,exchange:x.exchange,marketType:x.marketType,score:x.score,eligible:x.eligible,strategyFingerprint:x.strategyFingerprint}))}},
  {kind:'risk-command-centre-event',payload:{eventType:'multi-exchange-elite-risk-review',rankingId:result.id,generatedAt:now,executionMode:'paper-only',liveExecutionAuthorized:false,collisions:result.crossExchangeCollisions,riskFindings:result.assessments.filter(x=>x.riskFlags.length).map(x=>({traderId:x.traderId,exchange:x.exchange,flags:x.riskFlags,eligible:x.eligible,failedGates:x.failedGates}))}}
 ];
 await db.batch(rows.map((row,index)=>db.prepare('INSERT INTO jpti_events (id,kind,source,external_id,occurred_at,payload) VALUES (?,?,?,?,?,?)').bind('mxelite:'+result.id+':'+index,row.kind,'jpti-multi-exchange-elite',result.id,now,JSON.stringify(row.payload))));
}
export async function onRequest({request,env}){
 const url=new URL(request.url);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{allow:'GET, POST, OPTIONS','access-control-allow-headers':'content-type, x-jpti-api-token, authorization','access-control-allow-methods':'GET, POST, OPTIONS'}});
 if(request.method==='GET'&&!url.searchParams.has('limit'))return reply(200,getMultiExchangeStatus(env));
 if(!['GET','POST'].includes(request.method))return reply(405,{error:'Multi-exchange elite API supports GET and POST.'});
 const auth=await verifyPrivateToken(request,env);
 if(!auth.ok)return reply(auth.status,{error:auth.error});
 if(!env.JPTI_DB)return reply(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'});
 try{
  if(request.method==='POST'){
   const parsed=await readJson(request);if(parsed.error)return reply(parsed.status,{error:parsed.error});
   const candidates=parsed.value?.candidates;
   if(!Array.isArray(candidates)||candidates.length<1||candidates.length>300)return reply(400,{error:'Submit between 1 and 300 candidates. Every candidate must identify exchange, marketType, traderId, source, retrievedAt, trade count, history and four rolling-window metric records.'});
   const result=rankMultiExchangeTraders(candidates);
   await persist(env.JPTI_DB,result);
   return reply(201,{...result,persisted:true,storage:'cloudflare-d1',warning:'All imported statistics remain provider-reported and unverified until independently reconciled. No orders were placed.'});
  }
  const requested=Number(url.searchParams.get('limit')||20),limit=Number.isFinite(requested)?Math.min(100,Math.max(1,Math.floor(requested))):20;
  const rows=await env.JPTI_DB.prepare("SELECT payload FROM jpti_events WHERE kind='multi-exchange-elite-ranking' ORDER BY occurred_at DESC,created_at DESC LIMIT ?").bind(limit).all();
  const rankings=(rows.results||[]).map(row=>{try{return JSON.parse(row.payload)}catch{return null}}).filter(Boolean);
  return reply(200,{rankings,count:rankings.length,storage:'cloudflare-d1',executionMode:'paper-only'});
 }catch(error){
  console.error('[JPTI multi-exchange elite] operation failed:',String(error?.message||error).slice(0,200));
  return reply(500,{error:'Multi-exchange elite operation failed.'});
 }
}
