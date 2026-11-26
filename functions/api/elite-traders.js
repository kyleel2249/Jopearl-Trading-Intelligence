import { rankEliteTraders, ETRD_AGENTS, ETRD_POLICY } from '../../src/elite-trader-replication-engine.js';
import { verifyPrivateToken } from '../private-auth.js';

const headers={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
const parse=(value)=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
async function readBody(request){
  const declared=Number(request.headers.get('content-length')||0);
  if(declared>512000)return {error:'Request exceeds 512 KB.',status:413};
  const raw=await request.text();
  if(new TextEncoder().encode(raw).byteLength>512000)return {error:'Request exceeds 512 KB.',status:413};
  try{return {value:raw.trim()?JSON.parse(raw):{}};}catch{return {error:'Valid JSON is required.',status:400};}
}
async function saveEvent(db,kind,id,payload){
  await db.prepare("INSERT INTO jpti_events (id,kind,source,external_id,occurred_at,payload) VALUES (?,?,?,?,?,?)")
    .bind(id,kind,'jpti-elite-trader-replication',id,payload.generatedAt||payload.recordedAt||new Date().toISOString(),JSON.stringify(payload)).run();
}
export async function onRequest({request,env}){
  const path=new URL(request.url).pathname.replace(/\/+$/,'');
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{allow:'GET, POST, OPTIONS'}});
  if(request.method==='GET'&&path==='/api/elite-traders'){
    return reply(200,{system:'JPTI Elite Trader Replication Division',version:ETRD_POLICY.version,agents:ETRD_AGENTS,policy:ETRD_POLICY,
      status:{available:true,storageConfigured:Boolean(env.JPTI_DB),authConfigured:Boolean(env.JPTI_JOURNAL_TOKEN||env.JPTI_API_TOKEN),
      traderFeedConfigured:Boolean(env.JPTI_ELITE_TRADER_FEED_URL),scheduledMonitoringConfigured:false,
      executionMode:'paper-only',liveExecutionAuthorized:false},
      integration:{bitgetPublicTraderFeed:'not-configured',bitgetPrivateCopyTrading:'not-connected',sharedIntelligenceMemory:'not-yet-wired',riskCommandCentre:'final-authority-required'}});
  }
  if(!['GET','POST'].includes(request.method))return reply(405,{error:'ETRD supports GET and POST.'});
  if(!env.JPTI_DB)return reply(503,{error:'Cloudflare D1 binding JPTI_DB is unavailable.'});
  const auth=await verifyPrivateToken(request,env);
  if(!auth.ok)return reply(auth.status,{error:auth.error});
  try{
    if(request.method==='POST'){
      const body=await readBody(request);if(body.error)return reply(body.status,{error:body.error});
      const candidates=body.value?.candidates;
      if(!Array.isArray(candidates)||candidates.length<1||candidates.length>100)
        return reply(400,{error:'Submit between 1 and 100 candidate records with source, traderId, retrievedAt, trade count, history, ROI, win rate, drawdown, copier PnL and at least three performance windows.'});
      const result=rankEliteTraders(candidates);
      await saveEvent(env.JPTI_DB,'elite-trader-ranking',result.id,result);
      return reply(201,{...result,persisted:true,storage:'cloudflare-d1',
        warning:'Candidate statistics are provider-reported and remain unverified until reconciled against authoritative Bitget records. This operation creates no orders.'});
    }
    const requested=Number(new URL(request.url).searchParams.get('limit')||20);
    const limit=Number.isFinite(requested)?Math.min(100,Math.max(1,Math.floor(requested))):20;
    const rows=await env.JPTI_DB.prepare("SELECT payload FROM jpti_events WHERE kind='elite-trader-ranking' ORDER BY occurred_at DESC,created_at DESC LIMIT ?").bind(limit).all();
    const rankings=(rows.results||[]).map(row=>parse(row.payload)).filter(Boolean);
    return reply(200,{rankings,count:rankings.length,storage:'cloudflare-d1',executionMode:'paper-only'});
  }catch(error){
    console.error('[JPTI ETRD] operation failed:',String(error?.message||error).slice(0,180));
    return reply(500,{error:'Elite trader division operation failed.'});
  }
}
