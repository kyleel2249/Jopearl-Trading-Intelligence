import {CAPABILITY_CATALOG,validateCapabilityGrant,validateGovernanceRequest,evaluateGovernanceReview,scoreAgentHeartbeat} from '../src/agent-governance-engine.js';
const clean=(v,n=1000)=>String(v??'').trim().slice(0,n),parse=(v,f={})=>{try{return typeof v==='string'?JSON.parse(v):v??f}catch{return f}},reply=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function audit(db,{actorType='operator',actorId='operator',decisionType,targetType,targetId,decision,rationale,evidence=[]}){const id=crypto.randomUUID(),createdAt=new Date().toISOString();await db.prepare('INSERT INTO jpti_decision_ledger(decision_id,actor_type,actor_id,decision_type,target_type,target_id,decision,rationale,evidence_json,policy_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,actorType,actorId,decisionType,targetType,targetId,decision,rationale,JSON.stringify(Array.isArray(evidence)?evidence.slice(0,30):[]),'1',createdAt).run();return{id,createdAt};}
export async function handleAgentGovernanceApi({request,env,db,path}){
 try{
  if(path==='/api/intelligence-foundation/governance/health'&&request.method==='GET'){const names=['jpti_agent_capabilities','jpti_governance_requests','jpti_decision_ledger','jpti_agent_heartbeats','jpti_intelligence_sources'];const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'jpti_%'").all();const have=new Set((rows.results||[]).map(x=>x.name));const missing=names.filter(x=>!have.has(x));return reply(missing.length?503:200,{status:missing.length?'migration-required':'ready',migration:'0011_agent_governance_control_plane',missingTables:missing,capabilityCatalog:CAPABILITY_CATALOG.length,liveExecutionEnabled:false});}
  if(path==='/api/intelligence-foundation/governance/overview'&&request.method==='GET'){
   const [agents,requests,caps,decisions,heartbeats,sources]=await Promise.all([
    db.prepare('SELECT COUNT(*) total FROM jpti_org_agents').first(),db.prepare("SELECT status,COUNT(*) n FROM jpti_governance_requests GROUP BY status").all(),
    db.prepare('SELECT COUNT(*) total,SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) enabled FROM jpti_agent_capabilities').first(),
    db.prepare('SELECT COUNT(*) total FROM jpti_decision_ledger').first(),db.prepare('SELECT status,COUNT(*) n FROM jpti_agent_heartbeats GROUP BY status').all(),
    db.prepare('SELECT COUNT(*) total,SUM(CASE WHEN verification_status="verified" THEN 1 ELSE 0 END) verified FROM jpti_intelligence_sources').first()
   ]);
   return reply(200,{generatedAt:new Date().toISOString(),agents:agents?.total||0,requests:(requests.results||[]).reduce((a,x)=>(a[x.status]=x.n,a),{}),capabilities:{total:caps?.total||0,enabled:caps?.enabled||0},decisions:decisions?.total||0,heartbeats:(heartbeats.results||[]).reduce((a,x)=>(a[x.status]=x.n,a),{}),sources:{total:sources?.total||0,verified:sources?.verified||0},liveExecutionEnabled:false});
  }
  if(path==='/api/intelligence-foundation/governance/capabilities'&&request.method==='GET'){
   const r=await db.prepare('SELECT c.*,a.name agent_name,a.department_id FROM jpti_agent_capabilities c JOIN jpti_org_agents a ON a.agent_id=c.agent_id ORDER BY a.department_id,a.name,c.capability').all();
   return reply(200,{catalog:CAPABILITY_CATALOG,forbidden:['live-order-submit','exchange-account-write','withdrawals','secrets-read','risk-policy-override'],records:(r.results||[]).map(x=>({...x,constraints:parse(x.constraints_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/requests'&&request.method==='GET'){
   const r=await db.prepare('SELECT * FROM jpti_governance_requests ORDER BY CASE status WHEN \'pending\' THEN 0 ELSE 1 END,requested_at DESC LIMIT 200').all();
   return reply(200,{requests:(r.results||[]).map(x=>({...x,payload:parse(x.payload_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/requests'&&request.method==='POST'){
   const x=await request.json(),checked=validateGovernanceRequest(x);if(!checked.valid)return reply(400,{error:checked.reason});
   if(checked.request.targetType==='agent'&&!await db.prepare('SELECT agent_id FROM jpti_org_agents WHERE agent_id=?').bind(checked.request.targetId).first())return reply(404,{error:'Target agent does not exist.'});
   if(checked.request.targetType==='strategy'&&!await db.prepare('SELECT strategy_id FROM jpti_strategy_registry WHERE strategy_id=?').bind(checked.request.targetId).first())return reply(404,{error:'Target strategy does not exist.'});
   const id=crypto.randomUUID(),requestedAt=new Date(),expiresAt=new Date(requestedAt.getTime()+7*864e5).toISOString(),requestedBy=clean(x.requestedBy||'operator',120);
   await db.prepare('INSERT INTO jpti_governance_requests(request_id,request_type,target_type,target_id,action,reason,payload_json,status,requested_by,requested_at,expires_at) VALUES(?,?,?,?,?,?,?,\'pending\',?,?,?)').bind(id,checked.request.requestType,checked.request.targetType,checked.request.targetId,checked.request.action,checked.request.reason,JSON.stringify(checked.request.payload),requestedBy,requestedAt.toISOString(),expiresAt).run();
   const record=await audit(db,{actorId:requestedBy,decisionType:'approval-request',targetType:checked.request.targetType,targetId:checked.request.targetId,decision:'pending',rationale:checked.request.reason,evidence:[id]});
   return reply(201,{request:{id,status:'pending',requestType:checked.request.requestType,targetType:checked.request.targetType,targetId:checked.request.targetId,action:checked.request.action,reason:checked.request.reason,payload:checked.request.payload,requestedBy,requestedAt:requestedAt.toISOString(),expiresAt},audit:record});
  }
  const review=path.match(/^\/api\/intelligence-foundation\/governance\/requests\/([a-f0-9-]+)\/review$/i);
  if(review&&request.method==='POST'){
   const x=await request.json(),row=await db.prepare('SELECT * FROM jpti_governance_requests WHERE request_id=?').bind(review[1]).first();if(!row)return reply(404,{error:'Approval request not found.'});
   const normalized={id:row.request_id,status:row.status,requestType:row.request_type,requestedBy:row.requested_by,expiresAt:row.expires_at,payload:parse(row.payload_json)};
   const result=evaluateGovernanceReview(normalized,{decision:x.decision,reviewer:x.reviewer||'operator',note:x.note,now:new Date().toISOString()});
   if(!result.valid){if(result.status==='expired')await db.prepare("UPDATE jpti_governance_requests SET status='expired' WHERE request_id=? AND status='pending'").bind(row.request_id).run();return reply(409,{error:result.reason,status:result.status||row.status});}
   const reviewedAt=new Date().toISOString();
   if(result.status==='approved'&&row.request_type==='capability-grant'){
    const grant=validateCapabilityGrant(normalized.payload.capability);if(!grant.valid)return reply(400,{error:grant.reason});
    await db.prepare('INSERT INTO jpti_agent_capabilities(capability_id,agent_id,capability,enabled,approval_required,constraints_json,granted_by,granted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(agent_id,capability) DO UPDATE SET enabled=1,approval_required=excluded.approval_required,constraints_json=excluded.constraints_json,granted_by=excluded.granted_by,granted_at=excluded.granted_at,updated_at=excluded.updated_at').bind(crypto.randomUUID(),row.target_id,grant.capability.id,1,1,JSON.stringify(normalized.payload.constraints||{}),result.reviewer,reviewedAt,reviewedAt).run();
   }
   if(result.status==='approved'&&row.request_type==='capability-revoke')await db.prepare('UPDATE jpti_agent_capabilities SET enabled=0,updated_at=? WHERE agent_id=? AND capability=?').bind(reviewedAt,row.target_id,normalized.payload.capability).run();
   if(result.status==='approved'&&row.request_type==='agent-pause')await db.prepare("UPDATE jpti_org_agents SET status='paused',updated_at=? WHERE agent_id=?").bind(reviewedAt,row.target_id).run();
   if(result.status==='approved'&&row.request_type==='agent-resume')await db.prepare("UPDATE jpti_org_agents SET status='ready',updated_at=? WHERE agent_id=?").bind(reviewedAt,row.target_id).run();
   if(result.status==='approved'&&row.request_type==='strategy-promotion')await db.prepare("UPDATE jpti_strategy_registry SET status='challenger',updated_at=? WHERE strategy_id=? AND status IN ('experimental','retired')").bind(reviewedAt,row.target_id).run();
   await db.prepare('UPDATE jpti_governance_requests SET status=?,reviewed_by=?,review_note=?,reviewed_at=? WHERE request_id=? AND status=\'pending\'').bind(result.status,result.reviewer,result.note,reviewedAt,row.request_id).run();
   const record=await audit(db,{actorId:result.reviewer,decisionType:'approval-review',targetType:row.target_type,targetId:row.target_id,decision:result.status,rationale:result.note||row.reason,evidence:[row.request_id]});
   return reply(200,{requestId:row.request_id,status:result.status,reviewedAt,audit:record,effects:{liveExecutionAuthorized:false}});
  }
  if(path==='/api/intelligence-foundation/governance/decisions'&&request.method==='GET'){
   const r=await db.prepare('SELECT * FROM jpti_decision_ledger ORDER BY created_at DESC LIMIT 250').all();return reply(200,{decisions:(r.results||[]).map(x=>({...x,evidence:parse(x.evidence_json,[])}))});
  }
  if(path==='/api/intelligence-foundation/governance/decisions'&&request.method==='POST'){
   const x=await request.json(),actorId=clean(x.actorId||'operator',120),targetId=clean(x.targetId,120),rationale=clean(x.rationale,2000);
   if(!targetId||!rationale||rationale.length<8)return reply(400,{error:'Target and a substantive rationale are required.'});
   const decision=clean(x.decision,80),type=clean(x.decisionType,80),targetType=clean(x.targetType,50);
   if(!['approved','rejected','deferred','vetoed','observed','escalated'].includes(decision)||!type||!targetType)return reply(400,{error:'Decision type, target type and a valid decision are required.'});
   const record=await audit(db,{actorType:clean(x.actorType||'operator',40),actorId,decisionType:type,targetType,targetId,decision,rationale,evidence:x.evidence});return reply(201,{decision:record,persisted:true,appendOnly:true});
  }
  if(path==='/api/intelligence-foundation/governance/heartbeats'&&request.method==='GET'){
   const r=await db.prepare('SELECT h.*,a.name,a.department_id FROM jpti_agent_heartbeats h JOIN jpti_org_agents a ON a.agent_id=h.agent_id ORDER BY h.last_seen DESC').all();
   return reply(200,{heartbeats:(r.results||[]).map(x=>({...x,details:parse(x.details_json),health:scoreAgentHeartbeat({status:x.status,lastSeen:x.last_seen})}))});
  }
  if(path==='/api/intelligence-foundation/governance/heartbeats'&&request.method==='POST'){
   const x=await request.json(),agentId=clean(x.agentId,120),status=clean(x.status||'healthy',20);
   if(!agentId||!['healthy','degraded','busy','offline','blocked'].includes(status))return reply(400,{error:'Valid agentId and heartbeat status are required.'});
   if(!await db.prepare('SELECT agent_id FROM jpti_org_agents WHERE agent_id=?').bind(agentId).first())return reply(404,{error:'Agent does not exist.'});
   const lastSeen=new Date().toISOString(),latency=Number.isFinite(Number(x.latencyMs))?Math.max(0,Math.min(600000,Math.round(Number(x.latencyMs)))):null,errorCount=Math.max(0,Math.min(100000,Number(x.errorCount)||0));
   await db.prepare('INSERT INTO jpti_agent_heartbeats(agent_id,status,last_seen,latency_ms,error_count,details_json) VALUES(?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET status=excluded.status,last_seen=excluded.last_seen,latency_ms=excluded.latency_ms,error_count=excluded.error_count,details_json=excluded.details_json').bind(agentId,status,lastSeen,latency,errorCount,JSON.stringify(x.details||{})).run();
   return reply(200,{agentId,status,lastSeen,health:scoreAgentHeartbeat({status,lastSeen}),persisted:true});
  }
  return reply(405,{error:'Unsupported governance route or method.'});
 }catch(error){return reply(error.status||500,{error:clean(error.message||'Governance request failed.',500)});}
}
