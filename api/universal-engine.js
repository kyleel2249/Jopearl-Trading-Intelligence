import express from 'express';
import { withExchange } from './exchanges.js';
import { requirePrivateApiAuth } from './policy.js';
import { getLedgerTransactions, ingestLedgerEvent } from './operations.js';
import { buildEvidenceCouncil } from './advanced-intelligence.js';
import { normalizeDexPair, scoreAssetEvidence } from './multi-asset-intelligence.js';
import { listExchangeCatalog } from './exchanges.js';
import { buildUniversalCoverage } from './universal-coverage.js';
import { buildInstitutionalScorecards, evaluateInstitutionalPaperGovernance, buildSafetySnapshot } from './institutional-governance.js';

export const universalRouter = express.Router();
const MACRO_SERIES = Object.freeze([
  { id: 'FEDFUNDS', key: 'policyRate', label: 'Effective federal funds rate', unit: '%', frequency: 'daily' },
  { id: 'CPIAUCSL', key: 'cpi', label: 'Consumer price index', unit: 'index', frequency: 'monthly' },
  { id: 'UNRATE', key: 'unemploymentRate', label: 'Unemployment rate', unit: '%', frequency: 'monthly' },
  { id: 'DGS10', key: 'treasury10Year', label: '10-year Treasury yield', unit: '%', frequency: 'daily' },
  { id: 'DGS2', key: 'treasury2Year', label: '2-year Treasury yield', unit: '%', frequency: 'daily' },
  { id: 'WALCL', key: 'fedBalanceSheet', label: 'Federal Reserve total assets', unit: 'millions USD', frequency: 'weekly' }
]);

export async function fetchMacroSnapshot({ apiKey = process.env.JPTI_FRED_API_KEY, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const generatedAt = new Date(now).toISOString();
  if (!apiKey) return { status: 'unconfigured', generatedAt, source: 'FRED', dataAvailable: false, observations: [], missingSeries: MACRO_SERIES.map(s => s.id), message: 'Configure JPTI_FRED_API_KEY to retrieve macro observations.' };
  const observations = await Promise.all(MACRO_SERIES.map(async series => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = new URL('https://api.stlouisfed.org/fred/series/observations');
      url.searchParams.set('series_id', series.id); url.searchParams.set('api_key', apiKey); url.searchParams.set('file_type', 'json'); url.searchParams.set('sort_order', 'desc'); url.searchParams.set('limit', '1');
      const response = await fetchImpl(url.toString(), { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('FRED returned HTTP ' + response.status);
      const payload = await response.json(), row = payload?.observations?.[0], value = row && row.value !== '.' ? Number(row.value) : null;
      if (!row || !Number.isFinite(value)) throw new Error('Latest observation unavailable');
      return { ...series, value, date: row.date, status: 'ok' };
    } catch (error) { return { ...series, value: null, date: null, status: 'unavailable', error: String(error.message || error).slice(0,120) }; }
    finally { clearTimeout(timer); }
  }));
  const count = observations.filter(item => item.status === 'ok').length;
  return { status: count === observations.length ? 'available' : count ? 'partial' : 'unavailable', generatedAt, source: 'FRED', dataAvailable: count > 0, observations, missingSeries: observations.filter(item => item.status !== 'ok').map(item => item.id) };
}

let macroSnapshotCache = { at: 0, value: null };


const finite = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const STRATEGY_PROFILES = Object.freeze({
  spot_trend: { assetClasses:['crypto_spot','token'], timeframes:['15m','1h','4h','1d'], horizon:'intraday-to-swing', leverageAllowed:false, description:'Trend continuation with volume and multi-timeframe confirmation.' },
  perp_momentum: { assetClasses:['crypto_perpetual','crypto_future'], timeframes:['5m','15m','1h','4h'], horizon:'intraday', leverageAllowed:true, maxSuggestedLeverage:2, description:'Funding-aware momentum with volatility and liquidation-risk filters.' },
  mean_reversion: { assetClasses:['crypto_spot','crypto_perpetual','equity','fx'], timeframes:['5m','15m','1h','4h'], horizon:'intraday', leverageAllowed:false, description:'Range/volatility reversion; disabled in strong trend or thin liquidity.' },
  breakout: { assetClasses:['crypto_spot','token','equity','commodity'], timeframes:['15m','1h','4h','1d'], horizon:'swing', leverageAllowed:false, description:'Range breakout confirmed by relative volume and retest.' },
  defi_rotation: { assetClasses:['defi_token','defi_protocol'], timeframes:['1h','4h','1d','1w'], horizon:'swing', leverageAllowed:false, description:'Relative strength combined with TVL, fees and protocol-risk evidence.' },
  meme_new_pair: { assetClasses:['meme_token','new_pair'], timeframes:['1m','5m','15m'], horizon:'very_short', leverageAllowed:false, description:'New-pair momentum subject to strict contract, liquidity and holder checks.' },
  equity_swing: { assetClasses:['equity','etf'], timeframes:['1h','4h','1d','1w'], horizon:'swing', leverageAllowed:false, description:'Equity trend and volatility framework; corporate actions and venue hours required.' },
  macro_rotation: { assetClasses:['fx','commodity','index','bond'], timeframes:['4h','1d','1w'], horizon:'swing-to-position', leverageAllowed:false, description:'Macro regime and cross-asset relative-strength framework; provider coverage required.' }
});

export function classifyInstrument({ market = {}, chain = null, pair = null } = {}) {
  if (pair || chain) return { assetClass: 'token', instrumentType: 'dex_pair', chain: chain || null };
  if (market.option) return { assetClass: 'derivative_option', instrumentType: 'option' };
  if (market.swap) return { assetClass: 'crypto_perpetual', instrumentType: 'perpetual_swap' };
  if (market.future) return { assetClass: 'crypto_future', instrumentType: 'future' };
  if (market.spot) return { assetClass: 'crypto_spot', instrumentType: 'spot' };
  return { assetClass: market.type || 'unknown', instrumentType: market.type || 'unknown' };
}

export function evaluateStrategyProfile(profileId, evidence = {}) {
  const profile = STRATEGY_PROFILES[profileId];
  if (!profile) throw new Error('Unknown strategy profile.');
  const fields = {
    momentumPct: finite(evidence.momentumPct), relativeVolume: finite(evidence.relativeVolume),
    timeframeAlignment: finite(evidence.timeframeAlignment), rsi14: finite(evidence.rsi14),
    orderBookImbalance: finite(evidence.orderBookImbalance), fundingRate: finite(evidence.fundingRate),
    liquidityUsd: finite(evidence.liquidityUsd), tvlChangePct: finite(evidence.tvlChangePct),
    feesChangePct: finite(evidence.feesChangePct), protocolRiskScore: finite(evidence.protocolRiskScore),
    earningsRiskDays: finite(evidence.earningsRiskDays), macroMomentumPct: finite(evidence.macroMomentumPct),
    relativeStrengthPct: finite(evidence.relativeStrengthPct), dollarIndexChangePct: finite(evidence.dollarIndexChangePct),
    rateDifferentialBps: finite(evidence.rateDifferentialBps)
  };
  const required = {
    spot_trend: ['momentumPct','relativeVolume','timeframeAlignment','liquidityUsd'],
    perp_momentum: ['momentumPct','relativeVolume','timeframeAlignment','fundingRate','liquidityUsd'],
    mean_reversion: ['rsi14','relativeVolume','liquidityUsd'],
    breakout: ['momentumPct','relativeVolume','timeframeAlignment','liquidityUsd'],
    defi_rotation: ['tvlChangePct','feesChangePct','protocolRiskScore','liquidityUsd'],
    meme_new_pair: ['momentumPct','relativeVolume','liquidityUsd'],
    equity_swing: ['momentumPct','relativeVolume','timeframeAlignment','earningsRiskDays','liquidityUsd'],
    macro_rotation: ['macroMomentumPct','relativeStrengthPct','liquidityUsd']
  }[profileId] || ['liquidityUsd'];
  const missing = required.filter(key => fields[key] === null && !(key === 'macroMomentumPct' && ['risk-on','risk-off','neutral'].includes(evidence.macroBias)));
  const signals = [];
  const push = (factor,bias,value) => signals.push({factor,bias,value});
  let score = 50;
  if (fields.momentumPct !== null) { push('momentum',fields.momentumPct>0?'bullish':fields.momentumPct<0?'bearish':'neutral',fields.momentumPct); score += clamp(fields.momentumPct,-10,10)*1.5; }
  if (fields.relativeVolume !== null) { push('relative_volume',fields.relativeVolume>=1.5?'confirming':'weak',fields.relativeVolume); score += clamp(fields.relativeVolume-1,-2,3)*5; }
  if (fields.timeframeAlignment !== null) { push('timeframe_alignment',fields.timeframeAlignment>0?'bullish':fields.timeframeAlignment<0?'bearish':'mixed',fields.timeframeAlignment); score += clamp(fields.timeframeAlignment,-1,1)*12; }
  if (fields.orderBookImbalance !== null) { push('order_book',fields.orderBookImbalance>.15?'bullish':fields.orderBookImbalance<-.15?'bearish':'balanced',fields.orderBookImbalance); score += clamp(fields.orderBookImbalance,-1,1)*8; }
  if (fields.fundingRate !== null) { push('funding',Math.abs(fields.fundingRate)>.001?'crowded':'normal',fields.fundingRate); score -= clamp(Math.abs(fields.fundingRate)*10000,0,15); }
  if (profileId === 'mean_reversion' && fields.rsi14 !== null) {
    const bias=fields.rsi14<30?'bullish-reversion':fields.rsi14>70?'bearish-reversion':'neutral';
    push('rsi14',bias,fields.rsi14); score += fields.rsi14<30?14:fields.rsi14>70?-14:0;
  }
  if (profileId === 'defi_rotation') {
    push('protocol_tvl',fields.tvlChangePct>0?'improving':fields.tvlChangePct<0?'declining':'flat',fields.tvlChangePct);
    push('protocol_fees',fields.feesChangePct>0?'improving':fields.feesChangePct<0?'declining':'flat',fields.feesChangePct);
    push('protocol_risk','risk_score',fields.protocolRiskScore);
    score += clamp(fields.tvlChangePct,-30,30)*.45 + clamp(fields.feesChangePct,-40,40)*.3 - clamp(fields.protocolRiskScore,0,100)*.2;
  }
  if (profileId === 'equity_swing' && fields.earningsRiskDays !== null) {
    push('earnings_calendar',fields.earningsRiskDays<=2?'event-risk':'clear-window',fields.earningsRiskDays);
    if (fields.earningsRiskDays<=2) score-=18;
  }
  if (profileId === 'macro_rotation') {
    const macroBias=String(evidence.macroBias||'').toLowerCase();
    if (macroBias) { push('macro_regime',macroBias,macroBias); score += macroBias==='risk-on'?10:macroBias==='risk-off'?-10:0; }
    if (fields.macroMomentumPct!==null) score+=clamp(fields.macroMomentumPct,-20,20)*.4;
    if (fields.relativeStrengthPct!==null) score+=clamp(fields.relativeStrengthPct,-20,20)*.5;
    if (fields.dollarIndexChangePct!==null) score-=clamp(fields.dollarIndexChangePct,-10,10)*.5;
    if (fields.rateDifferentialBps!==null) push('rate_differential','context-only',fields.rateDifferentialBps);
  }
  if (fields.liquidityUsd !== null && fields.liquidityUsd < 10000) score -= 20;
  score = Math.round(clamp(score,0,100));
  const directional = signals.map(s=>s.bias).filter(b=>['bullish','bearish'].includes(b));
  const conflict = directional.includes('bullish') && directional.includes('bearish');
  const ready = missing.length === 0 && fields.liquidityUsd !== null && fields.liquidityUsd >= 10000 && !conflict;
  return { profileId, profile, score, bias:score>=60?'bullish':score<=40?'bearish':'neutral',
    status:!ready?'insufficient_or_conflicting_evidence':score>=65?'research_candidate':'monitor',
    signals, missingEvidence:missing, conflicts:conflict,
    leveragePolicy:profile.leverageAllowed?'exchange and account risk limits still required; profile maximum is not an authorization':'no leverage',
    decision:'research-only; not an order instruction',
    caveat:'Profile-specific required evidence must be present. Scores are deterministic heuristics, not calibrated probabilities or validated live strategies.' };
}


export function evaluatePaperEntryPreflight(input = {}, events = [], now = Date.now(), settings = {}) {
  const profileId = String(input.profileId || '');
  const assetClass = String(input.assetClass || 'unknown').toLowerCase();
  const evaluation = evaluateStrategyProfile(profileId, input.evidence || {});
  const risk = calculateUnifiedRisk(events, {
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    maxDailyLossUsd: settings.maxDailyLossUsd,
    now
  });
  const configuredAge = Number(settings.maxEvidenceAgeSeconds);
  const maxEvidenceAgeSeconds = Number.isFinite(configuredAge) ? clamp(configuredAge, 15, 300) : 90;
  const observedAt = Date.parse(input.observedAt || '');
  const evidenceAgeSeconds = Number.isFinite(observedAt) ? Math.max(0, (now - observedAt) / 1000) : null;
  const stale = evidenceAgeSeconds === null || evidenceAgeSeconds > maxEvidenceAgeSeconds;
  const securityRequired = ['token', 'dex_token', 'meme_token', 'new_pair'].includes(assetClass);
  const securityStatus = String(input.securityStatus || '').toLowerCase();
  const securityPassed = !securityRequired || ['clear', 'passed'].includes(securityStatus);
  const reasons = [];
  if (!risk.newEntriesAllowed) reasons.push(...(risk.pauseReasons.length ? risk.pauseReasons : ['shared_risk_gate_blocked']));
  if (!risk.riskConfiguration.valid) reasons.push('risk_configuration_invalid');
  if (stale) reasons.push('market_evidence_missing_or_stale');
  if (evaluation.status !== 'research_candidate') reasons.push('strategy_evidence_not_candidate');
  if (securityRequired && !securityPassed) reasons.push('independent_token_security_gate_not_passed');
  const allowed = reasons.length === 0;
  return {
    generatedAt: new Date(now).toISOString(), allowed, decision: allowed ? 'paper_candidate' : 'blocked',
    reasons, profileId, assetClass, evaluation,
    risk: { newEntriesAllowed: risk.newEntriesAllowed, pauseReasons: risk.pauseReasons, exitsRemainEnabled: true },
    evidenceFreshness: { observedAt: Number.isFinite(observedAt) ? new Date(observedAt).toISOString() : null, ageSeconds: evidenceAgeSeconds, maxAgeSeconds: maxEvidenceAgeSeconds, stale },
    security: { required: securityRequired, status: securityStatus || 'not-provided', passed: securityPassed },
    execution: 'No order is created, submitted, or authorized by this endpoint. This is a paper-entry preflight only.',
    caveat: 'A passing preflight is a research/paper eligibility result, not a profitability claim or permission for live execution.'
  };
}

export function buildStrategyScorecards(events, options = {}) {
  const days = Math.max(1, Math.min(3650, Number(options.days) || 90));
  const minTrades = Math.max(3, Math.min(500, Number(options.minTrades) || 20));
  const cutoff = Date.now() - days * 86400000;
  const groups = new Map();
  for (const event of events) {
    if (event.source !== 'tbots' || event.eventType !== 'bot_trade' || event.metadata?.action !== 'paper_closed') continue;
    const pnl = finite(event.metadata?.pnl);
    const at = Date.parse(event.occurredAt || '');
    if (pnl === null || !Number.isFinite(at) || at < cutoff) continue;
    const profile = String(event.metadata?.strategyProfile || 'untagged').slice(0, 64);
    const key = profile;
    const rows = groups.get(key) || [];
    rows.push({ pnl, at, symbol: event.symbol || 'unknown', assetClass: event.metadata?.assetClass || 'untagged', venue: event.metadata?.venue || 'untagged' });
    groups.set(key, rows);
  }
  const scorecards = [...groups.entries()].map(([strategyProfile, rows]) => {
    rows.sort((a,b) => a.at - b.at);
    const wins = rows.filter(x => x.pnl > 0);
    const losses = rows.filter(x => x.pnl < 0);
    const grossProfit = wins.reduce((s,x) => s + x.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s,x) => s + x.pnl, 0));
    const totalPnl = rows.reduce((s,x) => s + x.pnl, 0);
    let equity = 0, peak = 0, maxDrawdown = 0;
    for (const row of rows) { equity += row.pnl; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
    const avgWin = wins.length ? grossProfit / wins.length : null;
    const avgLoss = losses.length ? grossLoss / losses.length : null;
    const expectancy = totalPnl / rows.length;
    const sampleQuality = rows.length >= minTrades ? 'usable_for_review' : rows.length >= 10 ? 'early_sample' : 'insufficient_sample';
    return {
      strategyProfile, trades: rows.length, wins: wins.length, losses: losses.length,
      winRatePercent: wins.length / rows.length * 100, totalPnlUsd: totalPnl,
      expectancyUsdPerTrade: expectancy, averageWinUsd: avgWin, averageLossUsd: avgLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
      maxClosedTradeDrawdownUsd: maxDrawdown, sampleQuality,
      minimumTradesForReview: minTrades,
      byAssetClass: Object.fromEntries([...new Set(rows.map(x => x.assetClass))].map(k => [k, rows.filter(x => x.assetClass === k).length])),
      byVenue: Object.fromEntries([...new Set(rows.map(x => x.venue))].map(k => [k, rows.filter(x => x.venue === k).length])),
      lastTradeAt: new Date(rows.at(-1).at).toISOString(),
      interpretation: 'Historical paper outcomes only; not a forecast, calibrated probability, or authorization to trade.'
    };
  }).sort((a,b) => b.expectancyUsdPerTrade - a.expectancyUsdPerTrade);
  return { generatedAt: new Date().toISOString(), windowDays: days, minimumTradesForReview: minTrades,
    count: scorecards.length, scorecards,
    caveat: 'Only persisted T-Bots paper_closed events are included. Missing or untagged strategy metadata is grouped as untagged. No exchange fills or live trades are mixed into these paper scorecards.' };
}

function fillsCount(events) { return events.filter(e=>e.eventType==='fill').length; }

export function calculateExchangeRealized(events, now = Date.now()) {
  const inventory=new Map(),realizedByQuote={},dailyByQuote={},feeTotals={},unmatchedSellQuantityBySymbol={};
  let invalidBaseFeeEvents=0;
  const fills=events.filter(e=>e.eventType==='fill'&&e.symbol&&!String(e.symbol).includes(':')&&e.side&&finite(e.quantity)>0&&finite(e.price)>0)
    .sort((a,b)=>(Date.parse(a.occurredAt)||0)-(Date.parse(b.occurredAt)||0));
  for(const e of fills){
    const key=e.source+':'+e.accountId+':'+e.symbol;
    const [base,quote]=String(e.symbol).split('/');
    if(!base||!quote)continue;
    const row=inventory.get(key)||{quantity:0,cost:0,base,quote,exchange:e.source,accountId:e.accountId,symbol:e.symbol};
    const qty=Number(e.quantity),price=Number(e.price),fee=finite(e.fee)||0,feeCurrency=String(e.feeCurrency||'').toUpperCase();
    if(feeCurrency)feeTotals[feeCurrency]=(feeTotals[feeCurrency]||0)+fee;
    let realized=0;
    if(e.side==='buy'){
      const acquired=qty-(feeCurrency===base?fee:0);
      if(acquired>0){row.cost+=qty*price+(feeCurrency===quote?fee:0);row.quantity+=acquired;}
      else invalidBaseFeeEvents++;
    } else {
      const baseFee=feeCurrency===base?fee:0;
      const requestedOut=qty+baseFee;
      const averageCost=row.quantity>0?row.cost/row.quantity:0;
      const matched=Math.min(requestedOut,row.quantity);
      const matchedFee=Math.min(baseFee,matched);
      const matchedSale=Math.min(qty,Math.max(0,matched-matchedFee));
      realized=matchedSale*price-averageCost*matched;
      if(feeCurrency===quote)realized-=fee*(qty>0?matchedSale/qty:0);
      if(matched+1e-12<requestedOut)unmatchedSellQuantityBySymbol[e.symbol]=(unmatchedSellQuantityBySymbol[e.symbol]||0)+(requestedOut-matched);
      row.quantity-=matched;row.cost=Math.max(0,row.cost-averageCost*matched);
      if(row.quantity<1e-12){row.quantity=0;row.cost=0;}
      realizedByQuote[quote]=(realizedByQuote[quote]||0)+realized;
      const occurredAt=Date.parse(e.occurredAt);
      if(Number.isFinite(occurredAt)&&occurredAt>=now-86400000)dailyByQuote[quote]=(dailyByQuote[quote]||0)+realized;
    }
    inventory.set(key,row);
  }
  return {realizedByQuote,dailyByQuote,feeTotals,unmatchedSellQuantityBySymbol,invalidBaseFeeEvents,
    openInventory:[...inventory.values()].filter(x=>x.quantity>0).map(x=>({...x,averageCost:x.cost/x.quantity})),
    caveat:'Weighted-average cost on recorded spot fills only. Base-denominated fees reduce acquired/disposed inventory; quote-denominated fees affect cost/proceeds. Missing opening inventory, transfers, funding, taxes and third-token fee conversion prevent a complete account PnL statement.'};
}

function riskSetting(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: fallback, warning: null };
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || (integer && !Number.isInteger(parsed))) {
    return { value: fallback, warning: `Invalid risk setting; using safe default ${fallback}.` };
  }
  return { value: clamp(parsed, min, max), warning: null };
}

export function calculateUnifiedRisk(events, options = {}) {
  const now=options.now !== undefined && options.now !== null && String(options.now).trim() !== '' && Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const lossLimit = riskSetting(options.maxConsecutiveLosses, 3, { min: 1, max: 20, integer: true });
  const dailyLimit = riskSetting(options.maxDailyLossUsd, 100, { min: 0, max: 10000000 });
  const drawdownLimit = riskSetting(options.maxDrawdownPct, 10, { min: 1, max: 50 });
  const maxConsecutiveLosses = lossLimit.value;
  const maxDailyLossUsd = dailyLimit.value;
  const maxDrawdownPct = drawdownLimit.value;
  const configurationWarnings = [lossLimit.warning, dailyLimit.warning, drawdownLimit.warning].filter(Boolean);
  const botEvents=events.filter(e=>e.source==='tbots'&&e.eventType==='bot_trade'&&e.metadata?.action==='paper_closed')
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const closed=botEvents.map(e=>({at:e.occurredAt,pnl:finite(e.metadata?.pnl)})).filter(e=>e.pnl!==null);
  const dayAgo=now-86400000,recent=closed.filter(e=>Date.parse(e.at)>=dayAgo);
  let streak=0;for(const trade of [...closed].reverse()){if(trade.pnl<0)streak++;else break;}
  const paperEquityEvents=events.filter(e=>e.source==='tbots'&&['bot_trade','bot_session'].includes(e.eventType)
    && (finite(e.metadata?.equity)!==null || finite(e.metadata?.equityPeak)!==null))
    .sort((a,b)=>Date.parse(a.occurredAt||0)-Date.parse(b.occurredAt||0));
  const peakEquity=Math.max(0,...paperEquityEvents.map(e=>finite(e.metadata?.equityPeak)).filter(v=>v!==null));
  const latestEquity=[...paperEquityEvents].reverse().map(e=>finite(e.metadata?.equity)).find(v=>v!==null);
  const paperDrawdownPct=peakEquity>0&&latestEquity!==undefined
    ? Math.max(0,(peakEquity-latestEquity)/peakEquity*100) : null;
  const exchangeRealized=calculateExchangeRealized(events,now);
  const dailyByQuote={...exchangeRealized.dailyByQuote};
  for(const trade of recent)dailyByQuote.USD=(dailyByQuote.USD||0)+trade.pnl;
  const stableDailyUsd=['USDT','USDC','DAI','FDUSD'].reduce((sum,q)=>sum+(exchangeRealized.dailyByQuote[q]||0),0);
  const paperDailyUsd=recent.reduce((sum,e)=>sum+e.pnl,0);
  const usdDaily=paperDailyUsd+stableDailyUsd+(exchangeRealized.dailyByQuote.USD||0);
  dailyByQuote.USD=usdDaily;
  const usdLoss=Math.max(0,-usdDaily);
  const controlEvents=events.filter(e=>e.source==='jpti-control'&&e.eventType==='bot_decision'&&['global_pause','global_resume'].includes(e.metadata?.action)).sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
  const globalPaused=controlEvents.at(-1)?.metadata?.action==='global_pause';
  const reasons=[];
  if(globalPaused)reasons.push('global_kill_switch');
  if(streak>=maxConsecutiveLosses)reasons.push('consecutive_paper_loss_limit');
  if(maxDailyLossUsd>0&&usdLoss>=maxDailyLossUsd)reasons.push('daily_usd_loss_limit');
  if(paperDrawdownPct!==null&&paperDrawdownPct>=maxDrawdownPct)reasons.push('shared_paper_drawdown_limit');
  return {generatedAt:new Date(now).toISOString(),newEntriesAllowed:reasons.length===0,pauseReasons:reasons,
    consecutiveLosses:streak,maxConsecutiveLosses,rolling24hRealizedPnlByQuote:dailyByQuote,
    maxDailyLossUsd,rolling24hUsdLoss:usdLoss,maxDrawdownPct,paperDrawdownPct,
    paperEquity:{peak:peakEquity||null,latest:latestEquity??null},
    sources:{tbotsPaperClosedTrades:closed.length,jptiExchangeFills:fillsCount(events)},
    exchangeRealizedPnlByQuote:exchangeRealized.realizedByQuote,exchangeFeesByCurrency:exchangeRealized.feeTotals,
    globalPaused, exitsRemainEnabled:true,mode:'paper-first',
    riskConfiguration:{valid:configurationWarnings.length===0,warnings:configurationWarnings},
    caveat:'T-Bots paper PnL is USD-denominated. Exchange realized PnL uses recorded spot fills; USD/USDT/USDC/DAI/FDUSD are approximate USD equivalents for the daily guard. Other quote currencies remain separate until FX marks exist. Unrealized PnL and full cashflow reconciliation are not included.'};
}

export function buildUnifiedPerformance(events) {
  const trades = events.filter(e=>e.source==='tbots' && e.eventType==='bot_trade' && e.metadata?.action==='paper_closed');
  const pnl = trades.map(e=>finite(e.metadata?.pnl)).filter(v=>v!==null);
  const wins=pnl.filter(v=>v>0).length;
  const bySymbol={},byStrategy={},byAssetClass={},byVenue={},byChain={},bySession={};
  const add=(map,key,value)=>{const row=map[key]||(map[key]={trades:0,pnl:0,wins:0,losses:0});row.trades++;row.pnl+=value;if(value>0)row.wins++;if(value<0)row.losses++;};
  for(const e of trades){
    const value=finite(e.metadata?.pnl);if(value===null)continue;
    add(bySymbol,e.symbol||'unknown',value);
    add(byStrategy,e.metadata?.strategyProfile||'untagged',value);
    add(byAssetClass,e.metadata?.assetClass||'untagged',value);
    add(byVenue,e.metadata?.venue||'untagged',value);
    add(byChain,e.metadata?.chain||'unknown',value);
    add(bySession,e.metadata?.runId||'untagged',value);
  }
  const fills=events.filter(e=>e.eventType==='fill');
  const venueFills={};
  for(const e of fills){const row=venueFills[e.source]||(venueFills[e.source]={fills:0,buyQty:0,sellQty:0,feesByCurrency:{}});row.fills++;if(e.side==='buy')row.buyQty+=e.quantity||0;if(e.side==='sell')row.sellQty+=e.quantity||0;if(e.feeCurrency)row.feesByCurrency[e.feeCurrency]=(row.feesByCurrency[e.feeCurrency]||0)+(e.fee||0);}
  const realized=calculateExchangeRealized(events);
  return {generatedAt:new Date().toISOString(),paperStrategy:{closedTrades:pnl.length,wins,losses:pnl.length-wins,winRatePercent:pnl.length?wins/pnl.length*100:null,realizedPnlUsd:pnl.reduce((a,b)=>a+b,0),bySymbol,byStrategy,byAssetClass,byVenue,byChain,bySession},
    exchangeExecution:{fillCount:fills.length,byVenue:venueFills,realizedPnlByQuote:realized.realizedByQuote,feesByCurrency:realized.feeTotals,openInventory:realized.openInventory,realizedPnl:'weighted-average on recorded spot fills only; quote currencies remain separate'},
    attributionDimensions:['asset/pair','venue','paper-vs-exchange','strategy profile','asset class','chain','session'],
    caveat:'Paper trade attribution uses metadata recorded by connected T-Bots runs. Exchange fills are activity records; weighted-average realized PnL covers recorded spot fills only and does not equal a complete reconciled account statement.'};
}

universalRouter.get('/universal/macro', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    if (macroSnapshotCache.value && Date.now() - macroSnapshotCache.at < 60000) return res.set('Cache-Control', 'no-store').json({ ...macroSnapshotCache.value, cache: 'hit' });
    macroSnapshotCache.value = await fetchMacroSnapshot();
    macroSnapshotCache.at = Date.now();
    res.set('Cache-Control', 'no-store').json({ ...macroSnapshotCache.value, cache: 'miss' });
  } catch (error) { res.status(error.status || 502).json({ status: 'unavailable', error: error.message }); }
});

universalRouter.get('/universal/profiles',(req,res)=>res.json({profiles:STRATEGY_PROFILES,assetClasses:[...new Set(Object.values(STRATEGY_PROFILES).flatMap(p=>p.assetClasses))]}));

// Configuration/catalog visibility only; this deliberately does not claim provider health or symbol entitlement.
universalRouter.get('/universal/coverage',(_req,res)=>{
  try { res.set('Cache-Control','no-store').json(buildUniversalCoverage(process.env,listExchangeCatalog())); }
  catch(error) { res.status(500).json({error:'Coverage registry unavailable.',detail:error.message}); }
});

universalRouter.post('/universal/strategy/evaluate',(req,res)=>{
  try{res.json(evaluateStrategyProfile(String(req.body?.profileId||''),req.body?.evidence||{}));}
  catch(e){res.status(400).json({error:e.message});}
});


universalRouter.get('/universal/cex-watchlist',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const watchlist=String(process.env.JPTI_TBOTS_CEX_MARKETS||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,30);
    if(!watchlist.length)return res.json({fetchedAt:new Date().toISOString(),markets:[],status:'waiting-for-watchlist',note:'Configure JPTI_TBOTS_CEX_MARKETS=binance:BTC/USDT,bitget:ETH/USDT. Only active spot markets are included.'});
    const outcomes=await Promise.allSettled(watchlist.map(async entry=>{
      const split=entry.indexOf(':');if(split<1)throw new Error('Invalid CEX watchlist entry '+entry);
      const exchange=entry.slice(0,split).toLowerCase(),symbol=entry.slice(split+1).toUpperCase();
      return withExchange(exchange,{privateAccess:false},async ex=>{
        const market=ex.markets[symbol];
        if(!market||market.active===false||!market.spot)throw new Error('Active spot market unavailable: '+exchange+' '+symbol);
        if(!['USD','USDT','USDC','DAI','FDUSD'].includes(String(market.quote||'').toUpperCase()))throw new Error('T-Bots CEX paper feed requires a USD/stablecoin quote market: '+symbol);
        const [ticker,candles,book]=await Promise.all([
          ex.has?.fetchTicker?ex.fetchTicker(symbol):Promise.resolve(null),
          ex.has?.fetchOHLCV?ex.fetchOHLCV(symbol,'5m',undefined,24):Promise.resolve(null),
          ex.has?.fetchOrderBook?ex.fetchOrderBook(symbol,20):Promise.resolve(null)
        ]);
        const rows=candles||[],last=rows.at(-1),prev=rows.length>=13?rows.at(-13):rows[0];
        const volumeUsd=rows.map(row=>(finite(row[5])||0)*(finite(row[4])||0));
        const closes=rows.map(row=>finite(row[4])).filter(v=>v!==null);
        const changes=closes.slice(-15).slice(1).map((v,i)=>v-closes.slice(-15)[i]);
        const gains=changes.filter(v=>v>0),losses=changes.filter(v=>v<0).map(v=>-v);
        const avgGain=gains.reduce((a,b)=>a+b,0)/14,avgLoss=losses.reduce((a,b)=>a+b,0)/14;
        const rsi14=avgLoss===0?(avgGain>0?100:50):100-100/(1+avgGain/avgLoss);
        const avg=volumeUsd.length>1?volumeUsd.slice(0,-1).reduce((a,b)=>a+b,0)/(volumeUsd.length-1):null;
        const bidDepth=(book?.bids||[]).slice(0,10).reduce((s,x)=>s+x[0]*x[1],0);
        const askDepth=(book?.asks||[]).slice(0,10).reduce((s,x)=>s+x[0]*x[1],0);
        const spread=ticker?.bid>0&&ticker?.ask>0?(ticker.ask-ticker.bid)/((ticker.ask+ticker.bid)/2)*100:null;
        return {id:'cex:'+exchange+':'+symbol,chain:'cex',marketType:'cex',exchange,symbol,base:market.base,quote:market.quote,
          price:finite(ticker?.last),quoteVolume24h:finite(ticker?.quoteVolume),liquidityUsd:bidDepth+askDepth,
          volume5mUsd:volumeUsd.at(-1)??0,volume5mAvgUsd:avg,change1hPct:last&&prev&&prev[4]>0?(last[4]/prev[4]-1)*100:null,
          spreadPct:spread,rsi14,exchangeMarketActive:true,security:{exchangeListed:true},fetchedAt:new Date().toISOString()};
      });
    }));
    const markets=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);
    const errors=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason?.message||'Market unavailable');
    res.set('Cache-Control','no-store').json({fetchedAt:new Date().toISOString(),markets,errors,status:errors.length?'partial':'live',
      note:'Read-only CEX spot market feed. This is the explicitly configured watchlist, not every market on every exchange. T-Bots paper execution only.'});
  }catch(e){res.status(e.status||401).json({error:e.message});}
});

universalRouter.get('/universal/market/:exchange/:symbol',async(req,res)=>{
  try{
    const exchangeId=String(req.params.exchange).toLowerCase(),symbol=String(req.params.symbol).toUpperCase().replace('-','/');
    const timeframe=String(req.query.timeframe||'1h');
    const data=await withExchange(exchangeId,{privateAccess:false},async ex=>{
      const market=ex.markets[symbol];
      if(!market)throw Object.assign(new Error('Market is not listed on this venue.'),{status:404});
      const tasks={};
      if(ex.has?.fetchTicker)tasks.ticker=ex.fetchTicker(symbol).catch(()=>null);
      if(ex.has?.fetchOHLCV && (!ex.timeframes||ex.timeframes[timeframe]))tasks.candles=ex.fetchOHLCV(symbol,timeframe,undefined,120).catch(()=>null);
      if(ex.has?.fetchOHLCV)tasks.mtf=Promise.all(['15m','1h','4h','1d'].filter(tf=>!ex.timeframes||ex.timeframes[tf]).map(async tf=>({timeframe:tf,candles:await ex.fetchOHLCV(symbol,tf,undefined,40).catch(()=>null)})));
      if(ex.has?.fetchOrderBook)tasks.orderBook=ex.fetchOrderBook(symbol,25).catch(()=>null);
      if(market.contract && ex.has?.fetchFundingRate)tasks.funding=ex.fetchFundingRate(symbol).catch(()=>null);
      if(market.contract && ex.has?.fetchOpenInterest)tasks.openInterest=ex.fetchOpenInterest(symbol).catch(()=>null);
      const values=await Promise.all(Object.entries(tasks).map(async([k,p])=>[k,await p]));
      return {market:{symbol,base:market.base,quote:market.quote,spot:market.spot,contract:market.contract,swap:market.swap,future:market.future},...Object.fromEntries(values)};
    });
    const closes=(data.candles||[]).map(c=>finite(c[4])).filter(v=>v>0);
    const momentumPct=closes.length>1?(closes.at(-1)/closes[0]-1)*100:null;
    const volumes=(data.candles||[]).slice(-20).map(c=>finite(c[5])).filter(v=>v!==null);
    const avgVol=volumes.length?volumes.reduce((a,b)=>a+b,0)/volumes.length:null;
    const relVol=volumes.length>1&&avgVol>0?volumes.at(-1)/avgVol:null;
    const bids=data.orderBook?.bids||[],asks=data.orderBook?.asks||[];
    const bd=bids.slice(0,10).reduce((s,x)=>s+x[0]*x[1],0),ad=asks.slice(0,10).reduce((s,x)=>s+x[0]*x[1],0);
    const imbalance=bd+ad?(bd-ad)/(bd+ad):null;
    const mtf=(data.mtf||[]).map(row=>({timeframe:row.timeframe,direction:row.candles?.length>=20&&Number(row.candles.at(-1)[4])>Number(row.candles.at(-20)[4])?1:row.candles?.length>=20&&Number(row.candles.at(-1)[4])<Number(row.candles.at(-20)[4])?-1:0}));
    const alignment=mtf.length?mtf.reduce((s,x)=>s+x.direction,0)/mtf.length:null;
    const gains=[],losses=[];for(let i=Math.max(1,closes.length-14);i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains.push(d);else losses.push(-d);}
    const avgGain=gains.reduce((a,b)=>a+b,0)/14,avgLoss=losses.reduce((a,b)=>a+b,0)/14;
    const rsi14=avgLoss===0?(avgGain>0?100:50):100-100/(1+avgGain/avgLoss);
    const visibleDepthUsd=bd+ad;
    const evidence={momentumPct,relativeVolume:relVol,orderBookImbalance:imbalance,fundingRate:finite(data.funding?.fundingRate),openInterest:data.openInterest||null,
      timeframeAlignment:alignment,rsi14,visibleDepthUsd,multiTimeframe:mtf};
    const council=buildEvidenceCouncil({priceChangePct:momentumPct,volumeChangePct:relVol===null?null:(relVol-1)*100,depthImbalance:imbalance,fundingRate:evidence.fundingRate,openInterestChangePct:null});
    const riskScore=Math.round(clamp(50+(momentumPct??0)*2+(imbalance??0)*20,0,100));
    const regime=(momentumPct!==null&&momentumPct<=-5)||(imbalance!==null&&imbalance<=-.3)?'risk_off':(momentumPct!==null&&momentumPct>=3&&imbalance!==null&&imbalance>0)?'risk_on':'neutral';
    res.set('Cache-Control','no-store');
    res.json({exchange:exchangeId,market:data.market,timeframe,fetchedAt:new Date().toISOString(),regime,riskScore,
      sources:{exchange:{status:'live',capabilities:{ticker:Boolean(data.ticker),candles:Boolean(data.candles),orderBook:Boolean(data.orderBook),funding:Boolean(data.funding),openInterest:Boolean(data.openInterest)}}},
      ticker:data.ticker?{last:data.ticker.last,bid:data.ticker.bid,ask:data.ticker.ask,quoteVolume:data.ticker.quoteVolume,timestamp:data.ticker.timestamp}:null,
      evidence,council,availableStrategyProfiles:Object.keys(STRATEGY_PROFILES).filter(id=>STRATEGY_PROFILES[id].assetClasses.includes(data.market.spot?'crypto_spot':data.market.swap?'crypto_perpetual':data.market.future?'crypto_future':'unknown')),
      limitations:['CEX venue evidence only; on-chain, macro and news feeds must be independently configured and are not inferred from a ticker.','No order is placed.']});
  }catch(e){res.status(e.status||502).json({error:e.message});}
});

universalRouter.get('/universal/dex/search',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const q=String(req.query.q||'').trim().slice(0,80);
    if(q.length<2)return res.status(400).json({error:'Search query must be at least two characters.'});
    const response=await fetch('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(q),{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error('DEX Screener HTTP '+response.status);
    const body=await response.json();
    const pairs=(body.pairs||[]).slice(0,100).map(normalizeDexPair).map(p=>({...p,evidence:scoreAssetEvidence(p)}));
    res.set('Cache-Control','no-store').json({query:q,source:'DexScreener',fetchedAt:new Date().toISOString(),pairs,chains:[...new Set(pairs.map(p=>p.chain))],coverage:'Provider search results, not exhaustive token registry.'});
  }catch(e){res.status(e.status||502).json({error:e.message});}
});


universalRouter.post('/universal/asset-evidence',(req,res)=>{
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  const items=req.body?.assets;
  if(!Array.isArray(items)||items.length>80)return res.status(400).json({error:'assets must be an array of at most 80 token observations.'});
  const evidence=items.map(item=>{
    const asset={chain:String(item.chain||'unknown').toLowerCase(),base:{address:item.address||null,symbol:item.symbol||null},quote:{address:item.quoteAddress||null,symbol:item.quoteSymbol||null},
      liquidityUsd:finite(item.liquidityUsd)??0,volume24hUsd:finite(item.volume24hUsd)??0,volume1hUsd:finite(item.volume1hUsd)??0,
      priceChange1hPercent:finite(item.change1hPct),txns:{h1:{buys:finite(item.buys)??0,sells:finite(item.sells)??0}},ageHours:finite(item.ageMin)===null?null:Number(item.ageMin)/60};
    const score=scoreAssetEvidence(asset);
    return {id:String(item.id||item.chain+':'+item.address),chain:asset.chain,address:asset.base.address,symbol:asset.base.symbol,
      score:score.score,verdict:score.verdict,warnings:score.warnings,components:score.components,rsi14:finite(item.rsi14),
      sources:{dexMarketObservation:'T-Bots live DEX feed',jptiEvidenceModel:'JPTI explainable heuristic'},
      observedAt:new Date().toISOString(),decision:'research-only'};
  });
  res.set('Cache-Control','no-store').json({generatedAt:new Date().toISOString(),count:evidence.length,evidence,
    policy:'Evidence score is a discovery/ranking feature, not a token safety pass. Rug Check remains an independent mandatory gate.'});
});


const GOPLUS_IDS={ethereum:'1',bsc:'56',polygon:'137',arbitrum:'42161',optimism:'10',base:'8453',avalanche:'43114',linea:'59144',blast:'81457'};
universalRouter.get('/universal/dex-watchlist',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const entries=String(process.env.JPTI_TBOTS_DEX_WATCHLIST||'').split(',').map(x=>x.trim()).filter(Boolean).slice(0,60);
    if(!entries.length)return res.json({fetchedAt:new Date().toISOString(),pairs:[],status:'waiting-for-watchlist',note:'Configure JPTI_TBOTS_DEX_WATCHLIST=solana:tokenAddress,base:0xToken. DEX paper watchlist only.'});
    const grouped=new Map();
    for(const entry of entries){const i=entry.indexOf(':');if(i<1)continue;const chain=entry.slice(0,i).toLowerCase(),address=entry.slice(i+1);if(!/^[a-z0-9-]{2,32}$/.test(chain)||address.length<20||address.length>64)continue;const list=grouped.get(chain)||[];list.push(address);grouped.set(chain,list);}
    const results=await Promise.allSettled([...grouped.entries()].map(async([chain,addresses])=>{
      const batches=[];for(let i=0;i<addresses.length;i+=30)batches.push(addresses.slice(i,i+30));
      const rows=await Promise.all(batches.map(async batch=>{const r=await fetch('https://api.dexscreener.com/tokens/v1/'+encodeURIComponent(chain)+'/'+batch.map(encodeURIComponent).join(','),{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('DexScreener HTTP '+r.status);return r.json();}));
      return rows.flat();
    }));
    const raw=results.filter(x=>x.status==='fulfilled').flatMap(x=>x.value);
    const best=new Map();
    for(const pair of raw){const item=normalizeDexPair(pair);const key=item.chain+':'+item.base.address;if(!item.base.address)continue;if(!best.has(key)||item.liquidityUsd>(best.get(key).liquidityUsd||0))best.set(key,item);}
    const pairs=[...best.values()].map(item=>({...item,evidence:scoreAssetEvidence(item)}));
    res.set('Cache-Control','no-store').json({fetchedAt:new Date().toISOString(),pairs,status:results.some(x=>x.status==='rejected')?'partial':'live',coverage:'Configured token-address watchlist only; provider pair discovery is not exhaustive.'});
  }catch(e){res.status(e.status||401).json({error:e.message});}
});

universalRouter.get('/universal/asset/:chain/:address',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const chain=String(req.params.chain).toLowerCase(),address=String(req.params.address);
    if(!/^[a-z0-9-]{2,32}$/.test(chain)||address.length<20||address.length>64)return res.status(400).json({error:'Invalid chain or token address.'});
    const [pairsResult,securityResult]=await Promise.allSettled([
      fetch('https://api.dexscreener.com/token-pairs/v1/'+encodeURIComponent(chain)+'/'+encodeURIComponent(address),{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error('DexScreener HTTP '+r.status);return r.json();}),
      chain==='solana'
        ? fetch('https://api.rugcheck.xyz/v1/tokens/'+encodeURIComponent(address)+'/report',{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error('RugCheck HTTP '+r.status);return r.json();})
        : GOPLUS_IDS[chain]
          ? fetch('https://api.gopluslabs.io/api/v1/token_security/'+GOPLUS_IDS[chain]+'?contract_addresses='+encodeURIComponent(address),{signal:AbortSignal.timeout(10000)}).then(async r=>{if(!r.ok)throw new Error('GoPlus HTTP '+r.status);return r.json();})
          : Promise.reject(new Error('No validated security adapter for this chain.'))
    ]);
    const pairs=pairsResult.status==='fulfilled'&&Array.isArray(pairsResult.value)?pairsResult.value:[];
    const normalized=pairs.map(normalizeDexPair).map(p=>({...p,evidence:scoreAssetEvidence(p)})).sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
    let security=null,securityError=null;
    if(securityResult.status==='fulfilled'){
      const report=securityResult.value;
      if(chain==='solana'){
        const top=Array.isArray(report.topHolders)?report.topHolders:[];
        const risks=Array.isArray(report.risks)?report.risks:[];
        const lpPct=finite(report.markets?.[0]?.lp?.lpLockedPct);
        security={provider:'RugCheck',holders:finite(report.totalHolders),freezeAuthorityOpen:report.freezeAuthority!=null,mintAuthorityOpen:report.mintAuthority!=null,
          top10Percent:top.length?top.slice(0,10).reduce((s,h)=>s+(finite(h.pct)||0),0):null,
          lpLockedPercent:lpPct,risks:risks.map(r=>({name:r.name||null,level:r.level||null,description:r.description||null})).slice(0,30),
          status:report.mintAuthority==null&&report.freezeAuthority==null&&lpPct!==null&&top.length?'evidence_available':'incomplete'};
      }else{
        const item=report?.result?.[address.toLowerCase()]||report?.result?.[address]||null;
        if(item)security={provider:'GoPlus',holders:finite(item.holder_count),mintable:item.is_mintable,honeypot:item.is_honeypot,
          blacklist:item.is_blacklisted,hiddenOwner:item.hidden_owner,proxy:item.is_proxy,buyTax:finite(item.buy_tax),sellTax:finite(item.sell_tax),
          lpHolders:Array.isArray(item.lp_holders)?item.lp_holders.length:null,
          status:item.is_mintable!==undefined&&item.is_honeypot!==undefined&&item.is_blacklisted!==undefined?'evidence_available':'incomplete'};
      }
    }else securityError=securityResult.reason?.message||'Security provider unavailable';
    res.set('Cache-Control','no-store').json({chain,address,fetchedAt:new Date().toISOString(),pairCount:normalized.length,pairs:normalized,
      security,securityError,securityDecision:security?.status==='evidence_available'?'review_required':'fail_closed',
      note:'Provider evidence is not a safety guarantee. Run chain-specific simulations, holder and LP verification, and independent contract review before considering a trade.'});
  }catch(e){res.status(e.status||502).json({error:e.message});}
});


universalRouter.get('/universal/strategy/scorecards',async(req,res)=>{
  try {
    requirePrivateApiAuth(req);
    const days=Math.max(1,Math.min(3650,Number.parseInt(req.query.days||'90',10)||90));
    const minTrades=Math.max(3,Math.min(500,Number.parseInt(req.query.minTrades||'20',10)||20));
    const events=await getLedgerTransactions();
    const baseline=buildStrategyScorecards(events,{days,minTrades});
    const institutional=buildInstitutionalScorecards(events,{days,minTrades,
      minProfitFactor:process.env.JPTI_GOVERNANCE_MIN_PROFIT_FACTOR});
    res.set('Cache-Control','no-store').json({...baseline,institutional});
  } catch(error) { res.status(error.status||401).json({error:error.message}); }
});

universalRouter.post('/universal/entry-preflight',async(req,res)=>{
  try {
    requirePrivateApiAuth(req);
    const events=await getLedgerTransactions();
    const now=Date.now();
    const input=req.body||{};
    const result=evaluatePaperEntryPreflight(input,events,now,{
      maxConsecutiveLosses:process.env.JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES,
      maxDailyLossUsd:process.env.JPTI_TBOTS_DAILY_LOSS_LIMIT_USD,
      maxEvidenceAgeSeconds:process.env.JPTI_TBOTS_PREFLIGHT_MAX_EVIDENCE_AGE_SECONDS
    });
    const governance=evaluateInstitutionalPaperGovernance(input,result,events,now,{
      minClosedTrades:process.env.JPTI_GOVERNANCE_MIN_CLOSED_TRADES,
      minProfitFactor:process.env.JPTI_GOVERNANCE_MIN_PROFIT_FACTOR,
      maxTrialSizePct:process.env.JPTI_GOVERNANCE_MAX_TRIAL_SIZE_PCT,
      validatedSizePct:process.env.JPTI_GOVERNANCE_VALIDATED_SIZE_PCT
    });
    const allowed=result.allowed&&governance.allowed;
    res.set('Cache-Control','no-store').json({...result,...governance,allowed,
      decision:allowed?'paper_candidate':'blocked',
      reasons:[...new Set([...(result.reasons||[]),...(governance.reasons||[])])],
      execution:'Paper-entry governance only. The endpoint never creates an order or grants live execution permission.'});
  } catch(error) { res.status(error.status||400).json({error:error.message}); }
});

universalRouter.get('/universal/institutional/scorecards',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const days=Math.max(1,Math.min(3650,Number.parseInt(req.query.days||'90',10)||90));
    const minTrades=Math.max(3,Math.min(500,Number.parseInt(req.query.minTrades||process.env.JPTI_GOVERNANCE_MIN_CLOSED_TRADES||'20',10)||20));
    const events=await getLedgerTransactions();
    res.set('Cache-Control','no-store').json(buildInstitutionalScorecards(events,{days,minTrades,
      minProfitFactor:process.env.JPTI_GOVERNANCE_MIN_PROFIT_FACTOR}));
  }catch(error){res.status(error.status||401).json({error:error.message});}
});

universalRouter.get('/universal/safety/status',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const events=await getLedgerTransactions();
    res.set('Cache-Control','no-store').json(buildSafetySnapshot(events));
  }catch(error){res.status(error.status||401).json({error:error.message});}
});

universalRouter.post('/universal/safety/kill-switch',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const action=String(req.body?.action||'');
    if(!['engage','release'].includes(action))return res.status(400).json({error:'action must be engage or release.'});
    if(action==='release'&&req.body?.confirmation!=='I_CONFIRM_RESUME_PAPER_ENTRIES')
      return res.status(403).json({error:'Explicit operator confirmation is required to release the paper-entry kill switch.'});
    const reason=String(req.body?.reason|| (action==='engage'?'Operator engaged institutional kill switch':'Operator released institutional kill switch')).trim().slice(0,200);
    const event=await ingestLedgerEvent({source:'jpti-control',accountId:'global',eventType:'bot_decision',
      externalId:'jpti-safety-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),symbol:'SYSTEM',
      occurredAt:new Date().toISOString(),metadata:{action:action==='engage'?'global_kill_switch':'global_resume',
        reason,scope:'all JPTI-governed T-Bots paper entries',operatorConfirmed:action==='release'}});
    const events=await getLedgerTransactions();
    res.set('Cache-Control','no-store').json({ok:true,action,reason,eventId:event.event?.externalId||event.externalId||null,
      safety:buildSafetySnapshot(events),exitsRemainEnabled:true,liveExecutionAuthorized:false});
  }catch(error){res.status(error.status||401).json({error:error.message});}
});

universalRouter.post('/universal/control',async(req,res)=>{
  try{
    requirePrivateApiAuth(req);
    const action=String(req.body?.action||'');
    if(!['pause_new_entries','resume_new_entries'].includes(action))return res.status(400).json({error:'action must be pause_new_entries or resume_new_entries.'});
    const reason=String(req.body?.reason||'Manual operator control').slice(0,200);
    const event=await ingestLedgerEvent({source:'jpti-control',accountId:'global',eventType:'bot_decision',
      externalId:'jpti-control-'+Date.now()+'-'+Math.random().toString(36).slice(2,8),symbol:'SYSTEM',
      occurredAt:new Date().toISOString(),metadata:{action:action==='pause_new_entries'?'global_pause':'global_resume',reason,scope:'T-Bots new entries only'}});
    res.set('Cache-Control','no-store').json({ok:true,action,reason,occurredAt:event.occurredAt,exitsRemainEnabled:true,
      note:'T-Bots consumes this persisted control state on its next shared-risk refresh. Existing positions keep their exit logic.'});
  }catch(e){res.status(e.status||401).json({error:e.message});}
});

universalRouter.get('/universal/risk',async(req,res)=>{
  try{requirePrivateApiAuth(req);const events=await getLedgerTransactions();const settings={maxConsecutiveLosses:req.query.maxConsecutiveLosses??process.env.JPTI_TBOTS_MAX_CONSECUTIVE_LOSSES,maxDailyLossUsd:req.query.maxDailyLossUsd??process.env.JPTI_TBOTS_DAILY_LOSS_LIMIT_USD,maxDrawdownPct:req.query.maxDrawdownPct??process.env.JPTI_TBOTS_MAX_DRAWDOWN_PCT};res.set('Cache-Control','no-store').json(calculateUnifiedRisk(events,settings));}
  catch(e){res.status(e.status||401).json({error:e.message});}
});

universalRouter.get('/universal/performance',async(req,res)=>{
  try{requirePrivateApiAuth(req);res.set('Cache-Control','no-store').json(buildUnifiedPerformance(await getLedgerTransactions()));}
  catch(e){res.status(e.status||401).json({error:e.message});}
});

universalRouter.get('/universal/portfolio',async(req,res)=>{
  try {
    requirePrivateApiAuth(req);
    const events=await getLedgerTransactions();
    const accounting=calculateExchangeRealized(events);
    const grouped=new Map();
    for(const item of accounting.openInventory){
      const rows=grouped.get(item.exchange)||[];
      rows.push(item);grouped.set(item.exchange,rows);
    }
    const outcomes=await Promise.all([...grouped.entries()].map(async([exchangeId,items])=>{
      try {
        return await withExchange(exchangeId,{privateAccess:false},async exchange=>{
          if(!exchange.has?.fetchTicker)throw new Error('Public ticker capability unavailable.');
          return await Promise.all(items.map(async item=>{
            try {
              if(!exchange.markets[item.symbol])throw new Error('Recorded market is not currently listed.');
              const ticker=await exchange.fetchTicker(item.symbol);
              return {item,ticker};
            } catch(error) { return {item,error:error.message}; }
          }));
        });
      } catch(error) { return items.map(item=>({item,error:error.message})); }
    }));
    const flat=outcomes.flat();
    const positions=[];
    for(const outcome of flat){
      if(outcome.error){positions.push({...outcome.item,status:'mark_unavailable',markPrice:null,marketValue:null,unrealizedPnl:null,error:outcome.error});continue;}
      const ticker=outcome.ticker;
      const mark=finite(ticker?.last)??finite(ticker?.close);
      if(mark===null||mark<=0){positions.push({...outcome.item,status:'mark_unavailable',markPrice:null,marketValue:null,unrealizedPnl:null,error:'No valid last/close price returned.'});continue;}
      positions.push({...outcome.item,status:'marked',markPrice:mark,marketValue:outcome.item.quantity*mark,
        unrealizedPnl:(mark-outcome.item.averageCost)*outcome.item.quantity,markedAt:new Date().toISOString()});
    }
    const byQuote={};
    for(const p of positions){
      const row=byQuote[p.quote]||(byQuote[p.quote]={positions:0,costBasis:0,marketValue:0,unrealizedPnl:0,unmarkedPositions:0});
      row.positions++;
      if(p.status==='marked'){row.costBasis+=p.cost;row.marketValue+=p.marketValue;row.unrealizedPnl+=p.unrealizedPnl;}
      else row.unmarkedPositions++;
    }
    res.set('Cache-Control','no-store').json({
      generatedAt:new Date().toISOString(),valuation:'Public exchange last/close price; no FX conversion or account-balance reconciliation.',
      positions,byQuote,realizedPnlByQuote:accounting.realizedByQuote,feesByCurrency:accounting.feeTotals,
      unmatchedSellQuantityBySymbol:accounting.unmatchedSellQuantityBySymbol,invalidBaseFeeEvents:accounting.invalidBaseFeeEvents,
      completeness:{openSpotInventory:'recorded fills only',unrealizedPnl:'only positions with a current public mark',cashBalances:'not included',paperPositions:'reported separately in paper performance',derivatives:'not included'},
      caveat:accounting.caveat
    });
  } catch(e) { res.status(e.status||401).json({error:e.message}); }
});
