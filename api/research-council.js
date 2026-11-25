import express from 'express';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { evaluateResearchCouncil } from '../src/research-council-engine.js';

export { evaluateResearchCouncil };
export const researchCouncilRouter=express.Router();

researchCouncilRouter.post('/evaluate',async(req,res)=>{
 try{
  requirePrivateApiAuth(req);
  const result=evaluateResearchCouncil(req.body||{});
  const event={kind:'research-council-evaluation',source:'jpti-research-council',eventType:'council_evaluation',externalId:result.id,occurredAt:result.generatedAt,payload:result};
  await appendStoredEvent(event);
  res.json({...result,persisted:true});
 }catch(error){res.status(error.status||500).json({error:error.message||'Research council evaluation failed.'});}
});

researchCouncilRouter.get('/history',async(req,res)=>{
 try{
  requirePrivateApiAuth(req);
  const limit=Math.max(1,Math.min(100,Number.parseInt(req.query.limit||'25',10)||25));
  const events=await readStoredEvents(10000,'research-council-evaluation');
  const rows=events.filter(e=>e.source==='jpti-research-council').slice(-limit).reverse();
  res.json({generatedAt:new Date().toISOString(),count:rows.length,evaluations:rows.map(e=>e.payload),mode:'research-only'});
 }catch(error){res.status(error.status||500).json({error:error.message||'Research council history unavailable.'});}
});
