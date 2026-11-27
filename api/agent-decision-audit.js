import {createHash} from 'node:crypto';
const sides=new Set(['long','short','neutral']);
const stable=v=>Array.isArray(v)?'['+v.map(stable).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}':JSON.stringify(v);
export function validateAgentDecision(decision={}) {
 const errors=[];
 const id=String(decision.agentId||'').trim(),symbol=String(decision.symbol||'').trim().toUpperCase(),side=String(decision.direction||'').toLowerCase(),confidence=Number(decision.confidence),timestamp=Date.parse(decision.timestamp||'');
 if(!id)errors.push('agent_id_required');
 if(!symbol||!/^[A-Z0-9._-]{2,30}(\/[A-Z0-9._-]{2,30})?$/.test(symbol))errors.push('symbol_invalid');
 if(!sides.has(side))errors.push('direction_invalid');
 if(!Number.isFinite(confidence)||confidence<0||confidence>1)errors.push('confidence_out_of_range');
 if(!Number.isFinite(timestamp))errors.push('timestamp_invalid');
 if(!Array.isArray(decision.evidence)||decision.evidence.length===0)errors.push('evidence_required');
 if(Array.isArray(decision.evidence)&&decision.evidence.some(x=>!x||typeof x!=='object'||!String(x.source||'').trim()||!String(x.observedAt||'').trim()))errors.push('evidence_provenance_invalid');
 return {valid:errors.length===0,errors,normalized:errors.length?null:{agentId:id,symbol,direction:side,confidence,timestamp:new Date(timestamp).toISOString(),evidence:decision.evidence.map(x=>({source:String(x.source),observedAt:String(x.observedAt),reference:x.reference?String(x.reference).slice(0,300):null}))}};
}
export function arbitrateIndependentDecisions(decisions=[],{minimumAgents=2,minimumConfidence=0.65}={}) {
 const valid=[],rejected=[],seen=new Set();
 for(const decision of Array.isArray(decisions)?decisions:[]) {
  const checked=validateAgentDecision(decision);
  if(!checked.valid){rejected.push({agentId:decision?.agentId||null,errors:checked.errors});continue;}
  const d=checked.normalized,key=d.agentId+'|'+d.symbol;
  if(seen.has(key)){rejected.push({agentId:d.agentId,errors:['duplicate_agent_vote']});continue;}
  seen.add(key);valid.push(d);
 }
 const symbols=[...new Set(valid.map(x=>x.symbol))],results=[];
 for(const symbol of symbols) {
  const votes=valid.filter(x=>x.symbol===symbol),directions=new Set(votes.filter(x=>x.direction!=='neutral').map(x=>x.direction));
  const independentSources=new Set(votes.flatMap(x=>x.evidence.map(e=>e.source)));
  const confidence=votes.length?votes.reduce((s,x)=>s+x.confidence,0)/votes.length:0;
  const conflict=directions.size>1,eligible=votes.length>=minimumAgents&&independentSources.size>=minimumAgents&&!conflict&&confidence>=minimumConfidence;
  results.push({symbol,decision:eligible?(directions.size?[...directions][0]:'neutral'):'veto',eligible,agentCount:votes.length,independentEvidenceSources:independentSources.size,meanConfidence:confidence,conflict,reason:conflict?'direction_conflict':votes.length<minimumAgents?'insufficient_independent_agents':independentSources.size<minimumAgents?'evidence_not_independent':confidence<minimumConfidence?'confidence_below_threshold':null});
 }
 return {results,accepted:results.filter(x=>x.eligible),vetoed:results.filter(x=>!x.eligible),rejected,liveExecutionAuthorized:false};
}
export function appendDecisionAudit(previousHash='',event={}) {
 const payload={previousHash:String(previousHash||''),event};
 return {hash:createHash('sha256').update(stable(payload)).digest('hex'),previousHash:String(previousHash||''),event,algorithm:'sha256'};
}
