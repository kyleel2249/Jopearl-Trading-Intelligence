export const CAPABILITY_CATALOG = Object.freeze([
  { id:'market-data-read', label:'Read public market data', risk:'low', approvalRequired:false },
  { id:'shared-memory-read', label:'Read shared intelligence memory', risk:'low', approvalRequired:false },
  { id:'shared-memory-write', label:'Write shared intelligence memory', risk:'medium', approvalRequired:true },
  { id:'research-run', label:'Run research and analysis tasks', risk:'low', approvalRequired:false },
  { id:'strategy-experiment', label:'Create and run strategy experiments', risk:'medium', approvalRequired:true },
  { id:'paper-trade-propose', label:'Propose paper trades', risk:'medium', approvalRequired:true },
  { id:'paper-trade-manage', label:'Manage paper positions', risk:'high', approvalRequired:true },
  { id:'cross-department-message', label:'Send cross-department handoffs', risk:'medium', approvalRequired:true },
  { id:'report-generate', label:'Generate operational reports', risk:'low', approvalRequired:false },
  { id:'risk-read', label:'Read independent risk assessments', risk:'low', approvalRequired:false }
]);
export const FORBIDDEN_CAPABILITIES = Object.freeze(['live-order-submit','exchange-account-write','withdrawals','secrets-read','risk-policy-override']);
const byId = new Map(CAPABILITY_CATALOG.map(item => [item.id,item]));
export function normalizeCapability(value) { return String(value || '').trim().toLowerCase().slice(0,80); }
export function validateCapabilityGrant(value) {
  const id=normalizeCapability(value);
  if(FORBIDDEN_CAPABILITIES.includes(id))return{valid:false,reason:'This capability is permanently prohibited for autonomous agents.'};
  const item=byId.get(id);
  return item?{valid:true,capability:item}:{valid:false,reason:'Capability is not in the approved allowlist.'};
}
export function validateGovernanceRequest(input={}) {
  const type=String(input.requestType||'').trim(),targetType=String(input.targetType||'').trim(),targetId=String(input.targetId||'').trim(),action=String(input.action||'').trim(),reason=String(input.reason||'').trim();
  const allowedTypes=['capability-grant','capability-revoke','strategy-promotion','risk-policy-change','agent-pause','agent-resume'];
  if(!allowedTypes.includes(type))return{valid:false,reason:'Unsupported governance request type.'};
  if(!['agent','strategy','risk-policy'].includes(targetType)||!targetId||targetId.length>120)return{valid:false,reason:'A valid target type and identifier are required.'};
  if(!action||action.length>80||!reason||reason.length<12||reason.length>2000)return{valid:false,reason:'Action and a reason of at least 12 characters are required.'};
  const payload=input.payload&&typeof input.payload==='object'&&!Array.isArray(input.payload)?input.payload:{};
  if(type.startsWith('capability-')){const grant=validateCapabilityGrant(payload.capability);if(!grant.valid)return grant;if(type==='capability-grant'&&payload.enabled===false)return{valid:false,reason:'Use capability-revoke to disable a capability.'};}
  if(type==='risk-policy-change')return{valid:false,reason:'Risk policy changes must be submitted through the independent risk-policy review process; autonomous requests cannot alter risk limits.'};
  if(type==='strategy-promotion'&&payload.targetStatus==='live')return{valid:false,reason:'Live strategy promotion is prohibited. Approval can only qualify a strategy for paper evaluation.'};
  return{valid:true,request:{requestType:type,targetType,targetId,action,reason,payload}};
}
export function evaluateGovernanceReview(request,review={}) {
  if(!request||request.status!=='pending')return{valid:false,reason:'Only pending requests can be reviewed.'};
  const now=Date.parse(review.now||new Date().toISOString()),expires=Date.parse(request.expiresAt||'');
  if(Number.isFinite(expires)&&expires<=now)return{valid:false,status:'expired',reason:'The approval request has expired.'};
  const decision=String(review.decision||'').toLowerCase();
  if(!['approved','rejected'].includes(decision))return{valid:false,reason:'Review decision must be approved or rejected.'};
  const reviewer=String(review.reviewer||'').trim();
  if(!reviewer)return{valid:false,reason:'Reviewer identity is required.'};
  if(reviewer===request.requestedBy)return{valid:false,reason:'A requester cannot approve their own request.'};
  if(decision==='approved'&&request.requestType==='capability-grant'){
    const grant=validateCapabilityGrant(request.payload?.capability);
    if(!grant.valid)return grant;
  }
  return{valid:true,status:decision,reviewer,note:String(review.note||'').trim().slice(0,2000)};
}
export function scoreAgentHeartbeat(heartbeat,now=Date.now()) {
  const seen=Date.parse(heartbeat?.lastSeen||heartbeat?.last_seen||'');
  if(!Number.isFinite(seen))return{health:'unknown',ageMs:null,stale:true};
  const ageMs=Math.max(0,now-seen),status=String(heartbeat.status||'unknown');
  const health=ageMs>15*60e3||status==='offline'?'offline':ageMs>5*60e3||status==='degraded'||status==='blocked'?'degraded':status==='busy'?'busy':'healthy';
  return{health,ageMs,stale:ageMs>5*60e3};
}
export function isRiskPolicyTightening(current={},proposed={}) {
  const lowerOnly=['maxRiskPercent','maxNotionalUsd','maxOpenPositions','maxDailyLossPercent','maxDrawdownPercent','maxCorrelationExposure','maxSpreadPercent'];
  for(const key of lowerOnly)if(proposed[key]!==undefined&&(!Number.isFinite(Number(proposed[key]))||Number(proposed[key])<0||Number(proposed[key])>Number(current[key]??Infinity)))return false;
  if(proposed.requireFreshData===false&&current.requireFreshData===true)return false;
  if(proposed.circuitBreaker===false&&current.circuitBreaker===true)return false;
  if(proposed.killSwitch===false&&current.killSwitch===true)return false;
  return true;
}
