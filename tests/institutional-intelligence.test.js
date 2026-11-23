import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCalendarEvent, buildLiquidityMap, assessEventRisk, analyzeEventReactions } from '../api/institutional-intelligence.js';
import { evaluateAlphaSignal } from '../api/alpha-signal-engine.js';

test('normalizes economic calendar data and preserves actual, forecast and previous values', () => {
  const event=normalizeCalendarEvent({title:'US CPI',date:'2026-12-10T13:30:00Z',currency:'USD',impact:'High',actual:'3.1%',forecast:'3.0%',previous:'2.9%'},'forex-factory-feed');
  assert.equal(event.title,'US CPI');
  assert.equal(event.currency,'USD');
  assert.equal(event.impact,'high');
  assert.equal(event.actual,'3.1%');
  assert.equal(event.forecast,'3.0%');
  assert.equal(event.previous,'2.9%');
  assert.equal(event.status,'released');
  assert.deepEqual(event.surprise,{absolute:0.1,direction:'above'});
});

test('rejects calendar events without a valid scheduled timestamp', () => {
  assert.equal(normalizeCalendarEvent({title:'Missing date'},'test'),null);
  assert.equal(normalizeCalendarEvent({title:'Invalid date',date:'not-a-date'},'test'),null);
});

test('detects confirmed swing pools and visible order-book walls without inventing institution identity', () => {
  const candles=[];
  for(let i=0;i<40;i++){const close=100+Math.sin(i/2)*2;candles.push([Date.UTC(2026,0,1,0,i),close,close+1,close-1,close+0.1,100+i]);}
  const book={bids:[[99,100],[98.9,1],[98.8,1]],asks:[[101,1],[101.1,1],[101.2,100]]};
  const result=buildLiquidityMap(candles,book);
  assert.ok(Array.isArray(result.pools));
  assert.ok(result.visibleDepth.walls.length>0);
  assert.match(result.methodology,/do not identify the owner as an institution/);
});

test('high-impact event within the restricted window blocks new entries but never force-closes positions', () => {
  const now=Date.parse('2026-12-10T13:00:00Z');
  const event={title:'US CPI',currency:'USD',impact:'high',scheduledAt:'2026-12-10T13:20:00Z'};
  const risk=assessEventRisk([event],'BTC/USDT',now);
  assert.equal(risk.state,'RESTRICTED');
  assert.equal(risk.policy.blockNewEntries,true);
  assert.equal(risk.policy.closeExistingPositions,false);
});

test('unrelated currency events do not raise pair-specific event risk', () => {
  const now=Date.parse('2026-12-10T13:00:00Z');
  const event={title:'JPY CPI',currency:'JPY',impact:'high',scheduledAt:'2026-12-10T13:20:00Z'};
  const risk=assessEventRisk([event],'BTC/USDT',now);
  assert.equal(risk.state,'NORMAL');
});

test('dynamic volatility expansion restricts new entries even without a scheduled event', () => {
  const risk=assessEventRisk([],'BTC/USDT',Date.now(),{atrExpansionRatio:3.4,relativeVolume:4.2,spreadPercent:0.62});
  assert.equal(risk.state,'RESTRICTED');
  assert.equal(risk.dynamicVolatility.severe,true);
  assert.equal(risk.policy.blockNewEntries,true);
  assert.equal(risk.policy.closeExistingPositions,false);
});

test('event study measures forward candle returns for events inside the loaded chart history', () => {
  const candles=[];
  for(let i=0;i<40;i++){const close=100+i*.25;candles.push([Date.UTC(2026,0,1,0,i),close,close+1,close-1,close,100]);}
  const event={id:'cpi-1',title:'US CPI',currency:'USD',impact:'high',scheduledAt:new Date(candles[20][0]).toISOString(),provider:'forex-factory-feed'};
  const study=analyzeEventReactions(candles,[event]);
  assert.equal(study.status,'ready');
  assert.equal(study.observations.length,1);
  assert.equal(study.observations[0].eventId,'cpi-1');
  assert.ok(study.observations[0].returns['1bars']>0);
});

test('does not fabricate a numeric surprise from unavailable actual data', () => {
  const event=normalizeCalendarEvent({title:'US retail sales',date:'2026-12-10T13:30:00Z',currency:'USD',impact:'Medium',actual:'N/A',forecast:'0.2%'},'forex-factory-feed');
  assert.equal(event.surprise,null);
});

test('medium-impact event reduces risk without hard-blocking every new entry', () => {
  const now=Date.parse('2026-12-10T13:00:00Z');
  const event={title:'US PMI',currency:'USD',impact:'medium',scheduledAt:'2026-12-10T13:15:00Z'};
  const risk=assessEventRisk([event],'EUR/USD',now);
  assert.equal(risk.state,'CAUTION');
  assert.equal(risk.policy.blockNewEntries,false);
  assert.equal(risk.policy.reduceNewRisk,true);
});

function alphaFixture(eventRisk) {
  const start=Date.UTC(2026,0,1),candles=[];
  for(let i=0;i<120;i++){const close=100+i*.3+Math.sin(i)*.08;candles.push([start+i*3600000,close-.05,close+.2,close-.2,close,100+i]);}
  const now=start+121*3600000;
  return evaluateAlphaSignal({exchange:'binance',symbol:'BTC/USDT',timeframe:'1h',candles,quote:{last:candles.at(-1)[4],timestamp:new Date(now-1000).toISOString()},account:{equity:10000,dailyPnl:0,currency:'USDT',exposures:[]},limits:{maxDailyLoss:100,maxOrderNotional:100,maxGrossExposure:1000,maxRiskPercent:1,maxSymbolConcentrationPercent:10},eventRisk},now);
}

test('Alpha Signal Engine blocks paper intent during a restricted institutional event window', () => {
  const result=alphaFixture({state:'RESTRICTED',calendarAvailable:true,policy:{blockNewEntries:true,reduceNewRisk:true}});
  assert.equal(result.qualityChecks.find(check=>check.id==='institutional_event_risk').passed,false);
  assert.equal(result.decision,'blocked');
});

test('Alpha Signal Engine halves risk sizing during institutional caution state', () => {
  const result=alphaFixture({state:'CAUTION',calendarAvailable:true,policy:{blockNewEntries:false,reduceNewRisk:true}});
  assert.equal(result.riskBudgetMultiplier,0.5);
});

test('high-impact release transitions from halt to recovery instead of staying halted for the full hour', () => {
  const now=Date.parse('2026-12-10T14:00:00Z');
  const event={title:'FOMC rate decision',currency:'USD',impact:'high',scheduledAt:'2026-12-10T13:40:00Z'};
  assert.equal(assessEventRisk([event],'EUR/USD',now).state,'HALT_NEW_ENTRIES');
  const older={...event,scheduledAt:'2026-12-10T13:15:00Z'};
  assert.equal(assessEventRisk([older],'EUR/USD',now).state,'RECOVERY');
});
