import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGY_PROFILES, classifyInstrument, evaluateStrategyProfile, calculateUnifiedRisk, buildUnifiedPerformance } from './universal-engine.js';

test('strategy registry covers spot, perpetuals, tokens, equities and macro assets', () => {
  assert.ok(STRATEGY_PROFILES.spot_trend.assetClasses.includes('crypto_spot'));
  assert.ok(STRATEGY_PROFILES.perp_momentum.assetClasses.includes('crypto_perpetual'));
  assert.ok(STRATEGY_PROFILES.equity_swing.assetClasses.includes('equity'));
  assert.equal(classifyInstrument({market:{swap:true}}).assetClass,'crypto_perpetual');
  assert.equal(classifyInstrument({chain:'base',pair:{}}).assetClass,'token');
});

test('strategy evaluation is explicit about missing evidence and never issues an order', () => {
  const result=evaluateStrategyProfile('spot_trend',{momentumPct:4,relativeVolume:2,timeframeAlignment:1,liquidityUsd:50000});
  assert.equal(result.status,'research_candidate');
  assert.equal(result.decision,'research-only; not an order instruction');
  const missing=evaluateStrategyProfile('spot_trend',{momentumPct:4});
  assert.equal(missing.status,'insufficient_or_conflicting_evidence');
  assert.ok(missing.missingEvidence.includes('relativeVolume'));
});

test('unified risk gate pauses on a consecutive paper loss streak', () => {
  const events=[-1,-2,-3].map((pnl,i)=>({source:'tbots',eventType:'bot_trade',occurredAt:new Date(Date.now()-i*1000).toISOString(),metadata:{action:'paper_closed',pnl}}));
  const risk=calculateUnifiedRisk(events);
  assert.equal(risk.newEntriesAllowed,false);
  assert.ok(risk.pauseReasons.includes('consecutive_paper_loss_limit'));
  assert.equal(risk.exitsRemainEnabled,true);
});

test('unified performance attributes paper results and exchange fills separately', () => {
  const events=[
    {source:'tbots',eventType:'bot_trade',symbol:'ABC',metadata:{action:'paper_closed',pnl:5}},
    {source:'binance',eventType:'fill',side:'buy',quantity:2,fee:0.1,feeCurrency:'USDT'}
  ];
  const report=buildUnifiedPerformance(events);
  assert.equal(report.paperStrategy.closedTrades,1);
  assert.equal(report.paperStrategy.realizedPnlUsd,5);
  assert.equal(report.exchangeExecution.fillCount,1);
  assert.equal(report.exchangeExecution.realizedPnl,'weighted-average on recorded spot fills only; quote currencies remain separate');
  assert.equal(report.paperStrategy.byStrategy.untagged.trades,1);
});

test('exchange fill realized PnL uses weighted average and preserves quote currencies', async () => {
  const { calculateExchangeRealized } = await import('./universal-engine.js');
  const now=Date.now();
  const events=[
    {source:'binance',accountId:'a',eventType:'fill',symbol:'BTC/USDT',side:'buy',quantity:1,price:100,fee:0,occurredAt:new Date(now-3000).toISOString()},
    {source:'binance',accountId:'a',eventType:'fill',symbol:'BTC/USDT',side:'buy',quantity:1,price:120,fee:0,occurredAt:new Date(now-2000).toISOString()},
    {source:'binance',accountId:'a',eventType:'fill',symbol:'BTC/USDT',side:'sell',quantity:1,price:130,fee:1,feeCurrency:'USDT',occurredAt:new Date(now-1000).toISOString()}
  ];
  const result=calculateExchangeRealized(events,now);
  assert.equal(result.realizedByQuote.USDT,19);
  assert.equal(result.openInventory[0].quantity,1);
  assert.equal(result.openInventory[0].averageCost,110);
});

test('DeFi strategy requires protocol TVL, fees and risk evidence', () => {
  const missing=evaluateStrategyProfile('defi_rotation',{liquidityUsd:50000});
  assert.equal(missing.status,'insufficient_or_conflicting_evidence');
  assert.ok(missing.missingEvidence.includes('tvlChangePct'));
  const complete=evaluateStrategyProfile('defi_rotation',{liquidityUsd:50000,tvlChangePct:8,feesChangePct:12,protocolRiskScore:10});
  assert.equal(complete.missingEvidence.length,0);
  assert.equal(complete.decision,'research-only; not an order instruction');
});

test('persisted global pause and resume controls the shared entry gate', () => {
  const paused={source:'jpti-control',eventType:'bot_decision',occurredAt:new Date().toISOString(),metadata:{action:'global_pause'}};
  const resumed={...paused,occurredAt:new Date(Date.now()+1000).toISOString(),metadata:{action:'global_resume'}};
  assert.equal(calculateUnifiedRisk([paused]).newEntriesAllowed,false);
  assert.equal(calculateUnifiedRisk([paused]).globalPaused,true);
  assert.equal(calculateUnifiedRisk([paused,resumed]).newEntriesAllowed,true);
});

test('invalid consecutive-loss configuration falls back to the safe default', () => {
  const events=[-1,-2,-3].map((pnl,i)=>({source:'tbots',eventType:'bot_trade',occurredAt:new Date(Date.now()-i*1000).toISOString(),metadata:{action:'paper_closed',pnl}}));
  const risk=calculateUnifiedRisk(events,{maxConsecutiveLosses:'not-a-number'});
  assert.equal(risk.maxConsecutiveLosses,3);
  assert.equal(risk.newEntriesAllowed,false);
  assert.equal(risk.riskConfiguration.valid,false);
  assert.match(risk.riskConfiguration.warnings[0],/safe default 3/);
});

test('invalid daily-loss configuration cannot silently disable the loss guard', () => {
  const event={source:'tbots',eventType:'bot_trade',occurredAt:new Date().toISOString(),metadata:{action:'paper_closed',pnl:-125}};
  const risk=calculateUnifiedRisk([event],{maxDailyLossUsd:'NaN'});
  assert.equal(risk.maxDailyLossUsd,100);
  assert.equal(risk.rolling24hUsdLoss,125);
  assert.equal(risk.newEntriesAllowed,false);
  assert.equal(risk.riskConfiguration.valid,false);
});

test('valid zero daily-loss limit remains an explicit opt-out', () => {
  const risk=calculateUnifiedRisk([],{maxDailyLossUsd:0});
  assert.equal(risk.maxDailyLossUsd,0);
  assert.equal(risk.riskConfiguration.valid,true);
});

test('exchange inventory accounts for base-denominated buy and sell fees', async () => {
  const { calculateExchangeRealized } = await import('./universal-engine.js');
  const now=Date.now();
  const events=[
    {source:'binance',accountId:'a',eventType:'fill',symbol:'BTC/USDT',side:'buy',quantity:1,price:100,fee:0.01,feeCurrency:'BTC',occurredAt:new Date(now-2000).toISOString()},
    {source:'binance',accountId:'a',eventType:'fill',symbol:'BTC/USDT',side:'sell',quantity:0.5,price:120,fee:0.005,feeCurrency:'BTC',occurredAt:new Date(now-1000).toISOString()}
  ];
  const result=calculateExchangeRealized(events,now);
  assert.ok(Math.abs(result.openInventory[0].quantity-0.485)<1e-10);
  assert.ok(Math.abs(result.openInventory[0].cost-48.98989898989899)<1e-8);
  assert.ok(Math.abs(result.realizedByQuote.USDT-8.98989898989899)<1e-8);
  assert.equal(result.unmatchedSellQuantityBySymbol['ETH/USDT'],undefined);
  assert.equal(result.feeTotals.BTC,0.015);
});

test('exchange sells exceeding recorded inventory are reported instead of fabricating full proceeds', async () => {
  const { calculateExchangeRealized } = await import('./universal-engine.js');
  const now=Date.now();
  const events=[
    {source:'bitget',accountId:'a',eventType:'fill',symbol:'ETH/USDT',side:'buy',quantity:1,price:100,occurredAt:new Date(now-2000).toISOString()},
    {source:'bitget',accountId:'a',eventType:'fill',symbol:'ETH/USDT',side:'sell',quantity:1.5,price:120,occurredAt:new Date(now-1000).toISOString()}
  ];
  const result=calculateExchangeRealized(events,now);
  assert.equal(result.realizedByQuote.USDT,20);
  assert.equal(result.unmatchedSellQuantityBySymbol['ETH/USDT'],0.5);
  assert.equal(result.openInventory.length,0);
});


test('strategy scorecards compute expectancy and keep low sample sizes visibly unqualified', async () => {
  const { buildStrategyScorecards } = await import('./universal-engine.js');
  const now=Date.now();
  const events=[
    {source:'tbots',eventType:'bot_trade',occurredAt:new Date(now-3000).toISOString(),symbol:'A',metadata:{action:'paper_closed',strategyProfile:'spot_trend',assetClass:'crypto_spot',venue:'binance',pnl:10}},
    {source:'tbots',eventType:'bot_trade',occurredAt:new Date(now-2000).toISOString(),symbol:'B',metadata:{action:'paper_closed',strategyProfile:'spot_trend',assetClass:'crypto_spot',venue:'binance',pnl:-4}},
    {source:'binance',eventType:'fill',occurredAt:new Date(now-1000).toISOString(),metadata:{pnl:999}}
  ];
  const report=buildStrategyScorecards(events,{days:30,minTrades:20});
  assert.equal(report.count,1);
  assert.equal(report.scorecards[0].trades,2);
  assert.equal(report.scorecards[0].totalPnlUsd,6);
  assert.equal(report.scorecards[0].expectancyUsdPerTrade,3);
  assert.equal(report.scorecards[0].profitFactor,2.5);
  assert.equal(report.scorecards[0].sampleQuality,'insufficient_sample');
});

test('strategy scorecards isolate profiles and ignore events outside the requested window', async () => {
  const { buildStrategyScorecards } = await import('./universal-engine.js');
  const events=[
    {source:'tbots',eventType:'bot_trade',occurredAt:new Date().toISOString(),metadata:{action:'paper_closed',strategyProfile:'breakout',pnl:2}},
    {source:'tbots',eventType:'bot_trade',occurredAt:new Date(Date.now()-100*86400000).toISOString(),metadata:{action:'paper_closed',strategyProfile:'breakout',pnl:100}},
    {source:'tbots',eventType:'bot_trade',occurredAt:new Date().toISOString(),metadata:{action:'paper_closed',strategyProfile:'mean_reversion',pnl:-1}}
  ];
  const report=buildStrategyScorecards(events,{days:30,minTrades:3});
  assert.equal(report.count,2);
  assert.equal(report.scorecards.find(x=>x.strategyProfile==='breakout').trades,1);
  assert.equal(report.scorecards.find(x=>x.strategyProfile==='mean_reversion').totalPnlUsd,-1);
});


test('paper preflight passes only with fresh complete strategy, healthy risk and token security evidence', async () => {
  const { evaluatePaperEntryPreflight } = await import('./universal-engine.js');
  const now=Date.now();
  const input={profileId:'meme_new_pair',assetClass:'meme_token',observedAt:new Date(now).toISOString(),securityStatus:'passed',
    evidence:{momentumPct:10,relativeVolume:2,liquidityUsd:50000}};
  const result=evaluatePaperEntryPreflight(input,[],now,{maxEvidenceAgeSeconds:90});
  assert.equal(result.allowed,true);
  assert.equal(result.decision,'paper_candidate');
  assert.equal(result.execution,'No order is created, submitted, or authorized by this endpoint. This is a paper-entry preflight only.');
});

test('paper preflight blocks stale, incomplete and unverified token evidence', async () => {
  const { evaluatePaperEntryPreflight } = await import('./universal-engine.js');
  const now=Date.now();
  const result=evaluatePaperEntryPreflight({profileId:'meme_new_pair',assetClass:'meme_token',
    observedAt:new Date(now-180000).toISOString(),securityStatus:'not-verified',
    evidence:{momentumPct:10,relativeVolume:2,liquidityUsd:50000}},[],now,{maxEvidenceAgeSeconds:90});
  assert.equal(result.allowed,false);
  assert.ok(result.reasons.includes('market_evidence_missing_or_stale'));
  assert.ok(result.reasons.includes('independent_token_security_gate_not_passed'));
  const missing=evaluatePaperEntryPreflight({profileId:'spot_trend',assetClass:'crypto_spot',
    observedAt:new Date(now).toISOString(),evidence:{momentumPct:4}},[],now,{maxEvidenceAgeSeconds:90});
  assert.ok(missing.reasons.includes('strategy_evidence_not_candidate'));
});

test('paper preflight fails closed when global risk is paused or risk config is invalid', async () => {
  const { evaluatePaperEntryPreflight } = await import('./universal-engine.js');
  const now=Date.now();
  const paused={source:'jpti-control',eventType:'bot_decision',occurredAt:new Date(now).toISOString(),metadata:{action:'global_pause'}};
  const input={profileId:'meme_new_pair',assetClass:'meme_token',observedAt:new Date(now).toISOString(),securityStatus:'passed',
    evidence:{momentumPct:10,relativeVolume:2,liquidityUsd:50000}};
  const result=evaluatePaperEntryPreflight(input,[paused],now,{maxEvidenceAgeSeconds:90});
  assert.equal(result.allowed,false);
  assert.ok(result.reasons.includes('global_kill_switch'));
  const invalid=evaluatePaperEntryPreflight(input,[],now,{maxEvidenceAgeSeconds:90,maxConsecutiveLosses:'bad'});
  assert.ok(invalid.reasons.includes('risk_configuration_invalid'));
});

test('macro snapshot reports missing FRED credentials without fabricating observations', async () => {
  const { fetchMacroSnapshot } = await import('./universal-engine.js');
  const result = await fetchMacroSnapshot({ apiKey: '', now: 1700000000000, fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal(result.status, 'unconfigured'); assert.equal(result.dataAvailable, false); assert.equal(result.observations.length, 0);
});

test('macro snapshot parses latest observations and degrades per series on provider errors', async () => {
  const { fetchMacroSnapshot } = await import('./universal-engine.js');
  const result = await fetchMacroSnapshot({ apiKey: 'test-key', now: 1700000000000, fetchImpl: async url => {
    const id = new URL(url).searchParams.get('series_id'); if (id === 'DGS2') throw new Error('network down');
    return { ok: true, json: async () => ({ observations: [{ date: '2026-11-20', value: '4.25' }] }) };
  }});
  assert.equal(result.status, 'partial'); assert.equal(result.dataAvailable, true);
  assert.equal(result.observations.find(x => x.id === 'FEDFUNDS').value, 4.25);
  assert.equal(result.observations.find(x => x.id === 'DGS2').status, 'unavailable'); assert.ok(result.missingSeries.includes('DGS2'));
});
