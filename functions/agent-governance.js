import {CAPABILITY_CATALOG,validateCapabilityGrant,validateGovernanceRequest,evaluateGovernanceReview,scoreAgentHeartbeat,calculateAgentTrust,classifyBehaviourEvent,simulateGovernanceScenario} from '../src/agent-governance-engine.js';
const clean=(v,n=1000)=>String(v??'').trim().slice(0,n),parse=(v,f={})=>{try{return typeof v==='string'?JSON.parse(v):v??f}catch{return f}},reply=(status,body)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
async function audit(db,{actorType='operator',actorId='operator',decisionType,targetType,targetId,decision,rationale,evidence=[]}){const id=crypto.randomUUID(),createdAt=new Date().toISOString();await db.prepare('INSERT INTO jpti_decision_ledger(decision_id,actor_type,actor_id,decision_type,target_type,target_id,decision,rationale,evidence_json,policy_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,actorType,actorId,decisionType,targetType,targetId,decision,rationale,JSON.stringify(Array.isArray(evidence)?evidence.slice(0,30):[]),'1',createdAt).run();return{id,createdAt};}
export async function handleAgentGovernanceApi({request,env,db,path}){
 try{
  if(path==='/api/intelligence-foundation/governance/health'&&request.method==='GET'){const names=['jpti_agent_capabilities','jpti_governance_requests','jpti_decision_ledger','jpti_agent_heartbeats','jpti_intelligence_sources','jpti_governance_policies','jpti_governance_incidents','jpti_agent_behavior_events','jpti_agent_trust_snapshots','jpti_governance_simulations'];const rows=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'jpti_%'").all();const have=new Set((rows.results||[]).map(x=>x.name));const missing=names.filter(x=>!have.has(x));return reply(missing.length?503:200,{status:missing.length?'migration-required':'ready',migration:'0012_autonomous_governance_3',missingTables:missing,capabilityCatalog:CAPABILITY_CATALOG.length,liveExecutionEnabled:false});}
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
  if(path==='/api/intelligence-foundation/governance/sources'&&request.method==='GET'){
   const r=await db.prepare('SELECT * FROM jpti_intelligence_sources ORDER BY retrieved_at DESC LIMIT 200').all();
   return reply(200,{sources:(r.results||[]).map(x=>({...x,metadata:parse(x.metadata_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/sources'&&request.method==='POST'){
   const x=await request.json(),memoryId=clean(x.memoryId,80)||null,sourceType=clean(x.sourceType,60),sourceRef=clean(x.sourceRef,1200)||null,checksum=clean(x.checksum,160)||null;
   const verificationStatus=['verified','partially-verified','unverified','disputed','inferred'].includes(x.verificationStatus)?x.verificationStatus:'unverified';
   if(!sourceType||(!sourceRef&&!checksum))return reply(400,{error:'Source type and a source reference or checksum are required.'});
   if(verificationStatus==='verified'&&(!sourceRef||clean(x.verificationEvidence,2000).length<20))return reply(400,{error:'Verified provenance requires a source reference and substantive verification evidence.'});
   if(memoryId&&!await db.prepare('SELECT memory_id FROM jpti_intelligence_memory WHERE memory_id=?').bind(memoryId).first())return reply(404,{error:'Linked intelligence memory record does not exist.'});
   const id=crypto.randomUUID(),retrievedAt=new Date().toISOString(),observedAt=clean(x.observedAt,50)||null;
   await db.prepare('INSERT INTO jpti_intelligence_sources(source_id,memory_id,source_type,source_ref,checksum,verification_status,observed_at,retrieved_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,memoryId,sourceType,sourceRef,checksum,verificationStatus,observedAt,retrievedAt,JSON.stringify({...((x.metadata&&typeof x.metadata==='object')?x.metadata:{}),verificationEvidence:clean(x.verificationEvidence,2000)||null})).run();
   if(memoryId)await db.prepare('UPDATE jpti_intelligence_memory SET evidence_status=?,source=COALESCE(?,source),source_url=COALESCE(?,source_url),updated_at=? WHERE memory_id=?').bind(verificationStatus,sourceType,sourceRef,retrievedAt,memoryId).run();
   await audit(db,{actorId:clean(x.recordedBy||'operator',120),decisionType:'source-provenance-recorded',targetType:'intelligence-memory',targetId:memoryId||id,decision:verificationStatus,rationale:'Source provenance attached to intelligence memory.',evidence:[sourceRef||checksum]});
   return reply(201,{source:{id,memoryId,sourceType,sourceRef,checksum,verificationStatus,observedAt,retrievedAt},persisted:true});
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

  if(path==='/api/intelligence-foundation/governance/trust'&&request.method==='GET'){
   const agents=await db.prepare('SELECT agent_id,name,department_id FROM jpti_org_agents ORDER BY department_id,name').all();
   const rows=await db.prepare('SELECT agent_id,SUM(decisions) decisions,SUM(correct_decisions) correct_decisions,SUM(evidence_contributions) evidence_contributions,SUM(risk_violations) risk_violations,AVG(CAST(json_extract(metrics_json,\'$.brierScore\') AS REAL)) brier FROM jpti_agent_scorecards GROUP BY agent_id').all();
   const behaviour=await db.prepare('SELECT agent_id,AVG(risk_score) avg_risk,COUNT(*) event_count,MAX(observed_at) last_event FROM jpti_agent_behavior_events WHERE observed_at>=datetime(\'now\',\'-30 days\') GROUP BY agent_id').all();
   const score=new Map((rows.results||[]).map(x=>[x.agent_id,x])),events=new Map((behaviour.results||[]).map(x=>[x.agent_id,x]));
   const profiles=(agents.results||[]).map(a=>{const s=score.get(a.agent_id)||{},b=events.get(a.agent_id)||{},trust=calculateAgentTrust({...s,behaviourRisk:b.avg_risk||0});return{agentId:a.agent_id,name:a.name,departmentId:a.department_id,...trust,behaviourEvents:b.event_count||0,lastBehaviourEvent:b.last_event||null};});
   return reply(200,{profiles,generatedAt:new Date().toISOString(),method:'evidence-weighted deterministic score; missing samples are neutral and authority remains policy-bounded'});
  }
  if(path==='/api/intelligence-foundation/governance/behaviour'&&request.method==='GET'){
   const r=await db.prepare('SELECT e.*,a.name FROM jpti_agent_behavior_events e LEFT JOIN jpti_org_agents a ON a.agent_id=e.agent_id ORDER BY e.observed_at DESC LIMIT 200').all();return reply(200,{events:(r.results||[]).map(x=>({...x,details:parse(x.details_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/behaviour'&&request.method==='POST'){
   const x=await request.json(),checked=classifyBehaviourEvent(x);if(!checked.valid)return reply(400,{error:checked.reason});
   const agentId=clean(x.agentId,120),agent=await db.prepare('SELECT agent_id,department_id,name FROM jpti_org_agents WHERE agent_id=?').bind(agentId).first();if(!agent)return reply(404,{error:'Behaviour event agent does not exist.'});
   const e=checked.event,id=crypto.randomUUID(),t=new Date().toISOString();await db.prepare('INSERT INTO jpti_agent_behavior_events(event_id,agent_id,department_id,event_type,severity,risk_score,summary,details_json,source,observed_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,agentId,agent.department_id,e.eventType,e.severity,e.riskScore,e.summary,JSON.stringify(x.details&&typeof x.details==='object'?x.details:{}),clean(x.source||'agent-telemetry',80),clean(x.observedAt,50)||t,t).run();
   let incident=null;if(e.severity==='critical'||e.severity==='high'||e.riskScore>=80){const iid=crypto.randomUUID(),severity=e.severity==='critical'||e.riskScore>=95?'critical':'high';await db.prepare('INSERT INTO jpti_governance_incidents(incident_id,incident_type,severity,status,agent_id,department_id,title,description,response_action,evidence_json,detected_at,updated_at) VALUES(?,?,?,\'open\',?,?,?,?,?,?,?,?)').bind(iid,e.eventType,severity,agentId,agent.department_id,'Behaviour alert: '+e.eventType,e.summary,'restrict-and-investigate',JSON.stringify([id]),t,t).run();incident={id:iid,severity,status:'open'};}
   await audit(db,{actorType:'system',actorId:'behaviour-monitor',decisionType:'behaviour-event',targetType:'agent',targetId:agentId,decision:e.severity,rationale:e.summary,evidence:[id]});
   return reply(201,{event:{id,agentId,...e,observedAt:t},incident,persisted:true});
  }
  if(path==='/api/intelligence-foundation/governance/incidents'&&request.method==='GET'){
   const u=new URL(request.url),status=u.searchParams.get('status'),where=status&&['open','investigating','contained','resolved','false-positive'].includes(status)?' WHERE status=?':'',stmt=db.prepare('SELECT * FROM jpti_governance_incidents'+where+' ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END,detected_at DESC LIMIT 200'),q=where?await stmt.bind(status).all():await stmt.all();
   return reply(200,{incidents:(q.results||[]).map(x=>({...x,evidence:parse(x.evidence_json,[])}))});
  }
  if(path==='/api/intelligence-foundation/governance/incidents'&&request.method==='POST'){
   const x=await request.json(),title=clean(x.title,180),description=clean(x.description,3000),type=clean(x.incidentType,80),severity=['low','medium','high','critical'].includes(x.severity)?x.severity:'medium',agentId=clean(x.agentId,120)||null;
   if(!title||description.length<12||!type)return reply(400,{error:'Incident type, title and substantive description are required.'});
   if(agentId&&!await db.prepare('SELECT agent_id FROM jpti_org_agents WHERE agent_id=?').bind(agentId).first())return reply(404,{error:'Incident agent does not exist.'});
   const id=crypto.randomUUID(),t=new Date().toISOString();await db.prepare('INSERT INTO jpti_governance_incidents(incident_id,incident_type,severity,status,agent_id,title,description,response_action,evidence_json,assigned_to,detected_at,updated_at) VALUES(?,?,?,\'open\',?,?,?,?,?,?,?,?)').bind(id,type,severity,agentId,title,description,clean(x.responseAction||'review',80),JSON.stringify(Array.isArray(x.evidence)?x.evidence.slice(0,20):[]),clean(x.assignedTo,120)||null,t,t).run();
   await audit(db,{actorId:clean(x.reportedBy||'operator',120),decisionType:'incident-opened',targetType:'incident',targetId:id,decision:severity,rationale:description,evidence:x.evidence||[]});return reply(201,{incident:{id,status:'open',severity,title,detectedAt:t},persisted:true});
  }
  const incidentAction=path.match(/^\/api\/intelligence-foundation\/governance\/incidents\/([a-f0-9-]+)\/respond$/i);
  if(incidentAction&&request.method==='POST'){
   const x=await request.json(),row=await db.prepare('SELECT * FROM jpti_governance_incidents WHERE incident_id=?').bind(incidentAction[1]).first();if(!row)return reply(404,{error:'Incident not found.'});
   const status=String(x.status||'investigating');if(!['investigating','contained','resolved','false-positive'].includes(status))return reply(400,{error:'Unsupported incident response status.'});
   if(['resolved','false-positive'].includes(status)&&clean(x.resolution,20).length<20)return reply(400,{error:'Resolution requires at least 20 characters of evidence or explanation.'});
   const t=new Date().toISOString();await db.prepare('UPDATE jpti_governance_incidents SET status=?,assigned_to=COALESCE(?,assigned_to),resolution=COALESCE(?,resolution),response_action=COALESCE(?,response_action),updated_at=?,resolved_at=? WHERE incident_id=?').bind(status,clean(x.assignedTo,120)||null,clean(x.resolution,3000)||null,clean(x.responseAction,80)||null,t,['resolved','false-positive'].includes(status)?t:null,row.incident_id).run();
   await audit(db,{actorId:clean(x.actorId||'operator',120),decisionType:'incident-response',targetType:'incident',targetId:row.incident_id,decision:status,rationale:clean(x.resolution||x.note||'Incident response status changed.',2000),evidence:[row.incident_id]});return reply(200,{incidentId:row.incident_id,status,updatedAt:t,persisted:true});
  }
  if(path==='/api/intelligence-foundation/governance/simulations'&&request.method==='GET'){
   const r=await db.prepare('SELECT * FROM jpti_governance_simulations ORDER BY created_at DESC LIMIT 50').all();return reply(200,{simulations:(r.results||[]).map(x=>({...x,input:parse(x.input_json),result:parse(x.result_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/simulations'&&request.method==='POST'){
   const x=await request.json(),result=simulateGovernanceScenario(x);if(!result.valid)return reply(400,{error:result.reason});const id=crypto.randomUUID(),t=new Date().toISOString(),actor=clean(x.createdBy||'operator',120);await db.prepare('INSERT INTO jpti_governance_simulations(simulation_id,scenario_type,input_json,result_json,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(id,result.scenarioType,JSON.stringify(x),JSON.stringify(result),actor,t).run();await audit(db,{actorId:actor,decisionType:'governance-simulation',targetType:'scenario',targetId:id,decision:'simulated',rationale:result.disclaimer,evidence:[result.scenarioType]});return reply(201,{simulation:{id,...result,createdAt:t},persisted:true});
  }
  if(path==='/api/intelligence-foundation/governance/policies'&&request.method==='GET'){
   const r=await db.prepare('SELECT * FROM jpti_governance_policies ORDER BY policy_name,policy_version DESC').all();return reply(200,{policies:(r.results||[]).map(x=>({...x,rules:parse(x.rules_json)}))});
  }
  if(path==='/api/intelligence-foundation/governance/policies'&&request.method==='POST'){
   const x=await request.json(),name=clean(x.name,120),rules=x.rules&&typeof x.rules==='object'&&!Array.isArray(x.rules)?x.rules:null;if(!name||!rules)return reply(400,{error:'Policy name and structured rules are required.'});
   const allowed=['requireIndependentApproval','requireHumanForCritical','maxCapabilityDurationHours','maxBehaviourRisk','autoIncidentOnHighRisk','denySelfApproval','failClosedOnSupervisorOutage'];if(Object.keys(rules).some(k=>!allowed.includes(k)))return reply(400,{error:'Policy contains unsupported rule keys.'});
   if(rules.maxCapabilityDurationHours!==undefined&&(!Number.isFinite(Number(rules.maxCapabilityDurationHours))||Number(rules.maxCapabilityDurationHours)<1||Number(rules.maxCapabilityDurationHours)>8760))return reply(400,{error:'Capability duration must be between 1 and 8760 hours.'});
   const prev=await db.prepare('SELECT MAX(policy_version) version FROM jpti_governance_policies WHERE policy_name=?').bind(name).first(),version=(Number(prev?.version)||0)+1,id=crypto.randomUUID(),t=new Date().toISOString(),actor=clean(x.createdBy||'operator',120);await db.prepare('INSERT INTO jpti_governance_policies(policy_id,policy_name,policy_version,enabled,severity,rules_json,created_by,created_at,updated_at) VALUES(?,?,?,0,?,?,?,?,?)').bind(id,name,version,['low','medium','high','critical'].includes(x.severity)?x.severity:'high',JSON.stringify(rules),actor,t,t).run();await audit(db,{actorId:actor,decisionType:'governance-policy-versioned',targetType:'policy',targetId:id,decision:'created',rationale:'Created immutable policy version '+version+' for '+name,evidence:[name]});return reply(201,{policy:{id,name,version,rules,createdAt:t},persisted:true});
  }
  return reply(405,{error:'Unsupported governance route or method.'});
 }catch(error){return reply(error.status||500,{error:clean(error.message||'Governance request failed.',500)});}
}
