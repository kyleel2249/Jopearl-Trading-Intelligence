import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';

test('session memory API persists outcome records and returns grouped learning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jpti-session-memory-'));
 process.env.JPTI_DATA_DIR=dir;
 process.env.JPTI_STORAGE_BACKEND='file';
 process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS='false';
 process.env.JPTI_API_HOST='127.0.0.1';
 const {initializeStorage,closeStorage}=await import('./storage.js');
 const {sessionMemoryRouter}=await import('./session-memory.js');
 await initializeStorage();
 const app=express();app.use(express.json());app.use('/api/session',sessionMemoryRouter);
 const server=createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address(),base='http://127.0.0.1:'+address.port;
 try{
  const initial=await fetch(base+'/api/session/memory');assert.equal(initial.status,200);assert.equal((await initial.json()).count,0);
  const posted=await fetch(base+'/api/session/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:'London',symbol:'BTC/USDT',strategy:'reclaim',volatility:'normal',outcome:'win',returnR:1.5})});
  assert.equal(posted.status,201);const body=await posted.json();assert.equal(body.record.outcome,'win');assert.equal(body.count,1);
  const persisted=await fetch(base+'/api/session/memory');const data=await persisted.json();assert.equal(data.count,1);assert.equal(data.records[0].returnR,1.5);assert.equal(data.summary[0].winRate,100);
  const batchRecords=[{id:'legacy-a',session:'Tokyo',symbol:'ETH/USDT',strategy:'sweep',volatility:'normal',outcome:'loss',returnR:-1,createdAt:'2026-11-01T00:00:00.000Z'},{id:'legacy-b',session:'London',symbol:'BTC/USDT',strategy:'reclaim',volatility:'normal',outcome:'win',returnR:2,createdAt:'2026-11-02T00:00:00.000Z'}];
  const imported=await fetch(base+'/api/session/memory/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({records:batchRecords})});assert.equal(imported.status,201);const importBody=await imported.json();assert.equal(importBody.imported,2);assert.equal(importBody.count,3);
  const repeated=await fetch(base+'/api/session/memory/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({records:batchRecords})});assert.equal((await repeated.json()).duplicates,2);
  const invalid=await fetch(base+'/api/session/memory',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({outcome:'invalid'})});assert.equal(invalid.status,400);
 }finally{await new Promise(resolve=>server.close(resolve));await closeStorage();await rm(dir,{recursive:true,force:true});}
});
