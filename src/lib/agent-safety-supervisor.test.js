import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateAgentSafety,scoreAgentHealth,detectAgentAnomalies,arbitrateAgentIntents} from './agent-safety-supervisor.js';

const healthy={agentStatus:'active',heartbeatStatus:'healthy',healthScore:100,trustScore:80,dataAgeMs:1000,dataFresh:true,dailyLossPct:0,drawdownPct:0,consecutiveLosses:0,sessionAllowed:true};
test('healthy agent may submit a paper candidate but never receives live authority',()=>{
 const result=evaluateAgentSafety(healthy);assert.equal(result.allowed,true);assert.equal(result.status,'HEALTHY');assert.equal(result.permissions.live,false);assert.equal(result.liveExecutionAuthorized,false);
});
test('missing and stale market data fail closed',()=>{
 for(const input of [{...healthy,dataFresh:false},{...healthy,dataAgeMs:90000},{...healthy,dataAgeMs:null}])assert.equal(evaluateAgentSafety(input).allowed,false);
});
test('global kill switch, circuit breaker and quarantine veto entries',()=>{
 for(const key of ['killSwitch','circuitBreaker','quarantined'])assert.equal(evaluateAgentSafety({...healthy,[key]:true}).allowed,false);
});
test('loss, drawdown, loss-streak and session limits veto entries',()=>{
 for(const input of [{dailyLossPct:2},{drawdownPct:5},{consecutiveLosses:4},{sessionAllowed:false}])assert.equal(evaluateAgentSafety({...healthy,...input}).allowed,false);
});
test('critical security and policy anomalies quarantine the agent',()=>{
 const result=evaluateAgentSafety({...healthy,anomalies:[{type:'policy-bypass',summary:'attempted risk override'}]});assert.equal(result.allowed,false);assert.equal(result.quarantine,true);assert.equal(result.status,'QUARANTINED');
});
test('health score degrades on stale heartbeat, errors and latency',()=>{
 assert.equal(scoreAgentHealth({heartbeatStatus:'offline'}).score,0);
 assert.ok(scoreAgentHealth({heartbeatStatus:'degraded',errorRate:.5,latencyMs:12000}).score<70);
});
test('anomaly classification normalises known critical event types',()=>{
 assert.equal(detectAgentAnomalies([{type:'unauthorized-order'}])[0].severity,'critical');
});
test('opposite direction collisions reject every conflicting intent',()=>{
 const result=arbitrateAgentIntents([{symbol:'BTCUSDT',direction:'LONG',agentId:'a'},{symbol:'BTCUSDT',direction:'SHORT',agentId:'b'}]);
 assert.equal(result.accepted.length,0);assert.equal(result.collisions.length,1);assert.equal(result.rejected.length,2);
});
test('same-direction duplicates resolve to highest confidence',()=>{
 const result=arbitrateAgentIntents([{symbol:'ETHUSDT',direction:'LONG',agentId:'a',confidence:.6},{symbol:'ETHUSDT',direction:'LONG',agentId:'b',confidence:.9}]);
 assert.equal(result.accepted[0].agentId,'b');assert.equal(result.rejected.length,1);
});
