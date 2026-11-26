import test from 'node:test';
import assert from 'node:assert/strict';
import { JptiBridge } from './jpti-bridge.js';

function fakeStorage() {
  const values = new Map();
  return { getItem:key=>values.get(key) ?? null, setItem:(key,value)=>values.set(key,value), values };
}

test('paper events survive a failed request and retry with the same idempotency key after restart', async () => {
  const storage=fakeStorage(), sent=[];
  let attempts=0;
  const now=1_800_000_000_000;
  const bridge=new JptiBridge({storage,now:()=>now,fetchImpl:async(_url,options)=>{
    sent.push(JSON.parse(options.body));
    if(attempts++===0) throw new Error('offline');
    return {ok:true,json:async()=>({stored:true})};
  }});
  bridge.setToken('local-test-token');
  const failed=await bridge.publish('bot_trade','run-1','BTC/USDT',{action:'paper_closed',pnl:-1});
  assert.equal(failed.queued,1);
  assert.ok(storage.getItem(bridge.queueKey));
  const firstId=sent[0].externalId;

  const restarted=new JptiBridge({storage,now:()=>now,fetchImpl:async(_url,options)=>{
    sent.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({stored:true,duplicate:true})};
  }});
  restarted.setToken('local-test-token');
  const flushed=await restarted.flushEvents(true);
  assert.equal(flushed.queued,0);
  assert.equal(sent[1].externalId,firstId);
  assert.equal(sent[1].metadata.sequence,1);
});

test('stale shared risk snapshots fail closed for new entries', async () => {
  const now=1_800_000_000_000;
  const bridge=new JptiBridge({now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({
    generatedAt:new Date(now-60000).toISOString(),newEntriesAllowed:true,pauseReasons:[]
  })})});
  bridge.setToken('local-test-token');
  const risk=await bridge.refreshRisk(true);
  assert.equal(risk.newEntriesAllowed,false);
  assert.match(risk.error,/stale/i);
  assert.equal(risk.exitsRemainEnabled,true);
});

test('fresh shared risk snapshots are accepted without weakening an active pause', async () => {
  const now=1_800_000_000_000;
  const bridge=new JptiBridge({now:()=>now,fetchImpl:async()=>({ok:true,json:async()=>({
    generatedAt:new Date(now).toISOString(),newEntriesAllowed:false,pauseReasons:['global_kill_switch']
  })})});
  bridge.setToken('local-test-token');
  const risk=await bridge.refreshRisk(true);
  assert.equal(risk.newEntriesAllowed,false);
  assert.deepEqual(risk.pauseReasons,['global_kill_switch']);
});

test('T-Bots fails closed until the shared historical validation gate qualifies its strategy', async () => {
  const calls=[];
  const bridge=new JptiBridge({storage:fakeStorage(),fetchImpl:async(url,options)=>{
    calls.push(url);
    return {ok:true,json:async()=>({paperTrialEligible:false,assessment:{failedChecks:['backtest_sample']}})};
  }});
  bridge.setToken('local-test-token');
  const result=await bridge.preflightEntry({token:{id:'x',symbol:'X'},profileId:'meme_new_pair',securityPassed:true});
  assert.equal(result.allowed,false);
  assert.match(result.reasons[0],/historical validation/i);
  assert.equal(calls.length,1);
  assert.match(calls[0],/validation\/latest/);
});

test('T-Bots proceeds to the existing independent entry preflight only after historical qualification', async () => {
  const calls=[];
  const bridge=new JptiBridge({storage:fakeStorage(),fetchImpl:async(url,options)=>{
    calls.push(url);
    const body=url.includes('/validation/latest/')
      ? {paperTrialEligible:true}
      : {allowed:true,maxEntrySizePct:0.5,reasons:[]};
    return {ok:true,json:async()=>body};
  }});
  bridge.setToken('local-test-token');
  const result=await bridge.preflightEntry({token:{id:'x',symbol:'X'},profileId:'meme_new_pair',securityPassed:true});
  assert.equal(result.allowed,true);
  assert.equal(calls.length,2);
  assert.match(calls[0],/validation\/latest/);
  assert.match(calls[1],/entry-preflight/);
});
