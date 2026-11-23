import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { summarizeSessionMemory } from '../src/session-trading-intelligence.js';

export const sessionMemoryRouter = express.Router();
const MAX_MEMORY = 20000;

function authorizeSessionMemory(req){
 const serverHost=String(process.env.JPTI_API_HOST||'127.0.0.1').toLowerCase().replace(/^::ffff:/,'');
 const loopbackServer=serverHost==='localhost'||serverHost==='::1'||serverHost.startsWith('127.');
 // Loopback-bound servers cannot be reached from another device; LAN-bound hosts remain token protected.
 if(loopbackServer)return;
 requirePrivateApiAuth(req);}
function cleanRecord(input = {}) {
  const outcome=String(input.outcome||'').toLowerCase();
  if(!['win','loss','breakeven'].includes(outcome)) throw Object.assign(new Error('Outcome must be win, loss or breakeven.'),{status:400});
  const session=String(input.session||'').trim().slice(0,120);
  const symbol=String(input.symbol||'').trim().toUpperCase().slice(0,32);
  const strategy=String(input.strategy||'Unspecified').trim().slice(0,120);
  const volatility=String(input.volatility||'unknown').trim().slice(0,40);
  const returnR=input.returnR===null||input.returnR===undefined||input.returnR===''?null:Number(input.returnR);
  if(returnR!==null&&!Number.isFinite(returnR)) throw Object.assign(new Error('Return in R must be a finite number.'),{status:400});
  const createdAt=input.createdAt?new Date(input.createdAt):new Date();
  if(!Number.isFinite(createdAt.getTime())) throw Object.assign(new Error('Invalid outcome timestamp.'),{status:400});
  return {id:String(input.id||randomUUID()),session:session||'unknown',symbol:symbol||'unknown',strategy:strategy||'Unspecified',volatility:volatility||'unknown',outcome,returnR,notes:String(input.notes||'').slice(0,500),createdAt:createdAt.toISOString()};
}
async function appendSessionRecord(record,existingRecords=null){const records=existingRecords||await getSessionRecords();const existing=records.find(r=>r.id&&r.id===record.id);if(existing)return {duplicate:true,record:existing};const event=await appendStoredEvent({kind:'session-outcome',source:'jpti-session-intelligence',externalId:'session:'+record.id,symbol:record.symbol,occurredAt:record.createdAt,payload:{record}});records.push(record);return {duplicate:false,record,eventId:event.id};}
async function getSessionRecords(limit=MAX_MEMORY) {
  const events=await readStoredEvents(limit,'session-outcome');
  return events.map(e=>e.payload?.record||e.record||e).filter(r=>r&&['win','loss','breakeven'].includes(r.outcome));
}
sessionMemoryRouter.get('/memory',async(req,res)=>{
  try{authorizeSessionMemory(req);const records=await getSessionRecords();res.set('Cache-Control','no-store').json({records,summary:summarizeSessionMemory(records),count:records.length,backend:true});}
  catch(error){res.status(error.status||500).json({error:error.message});}
});
sessionMemoryRouter.post('/memory',async(req,res)=>{
  try{authorizeSessionMemory(req);const record=cleanRecord(req.body);const saved=await appendSessionRecord(record);const records=await getSessionRecords();res.status(201).set('Cache-Control','no-store').json({ok:true,record:saved.record,duplicate:saved.duplicate,eventId:saved.eventId||null,count:records.length,summary:summarizeSessionMemory(records)});}
  catch(error){res.status(error.status||500).json({ok:false,error:error.message});}
});
sessionMemoryRouter.post('/memory/batch',async(req,res)=>{
 try{authorizeSessionMemory(req);const incoming=req.body?.records;if(!Array.isArray(incoming)||incoming.length>2000)throw Object.assign(new Error('Send an array of up to 2,000 session outcome records.'),{status:400});const cleaned=incoming.map(cleanRecord),saved=[],existing=await getSessionRecords();for(const record of cleaned)saved.push(await appendSessionRecord(record,existing));const records=await getSessionRecords();res.status(201).set('Cache-Control','no-store').json({ok:true,imported:saved.filter(x=>!x.duplicate).length,duplicates:saved.filter(x=>x.duplicate).length,count:records.length,summary:summarizeSessionMemory(records)});}
 catch(error){res.status(error.status||500).json({ok:false,error:error.message});}
});
sessionMemoryRouter.get('/performance',async(req,res)=>{
  try{authorizeSessionMemory(req);const records=await getSessionRecords();res.set('Cache-Control','no-store').json({count:records.length,summary:summarizeSessionMemory(records)});}
  catch(error){res.status(error.status||500).json({error:error.message});}
});
