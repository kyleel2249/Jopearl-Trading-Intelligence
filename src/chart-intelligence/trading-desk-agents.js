// JPTI specialist desk agents for scalping and day trading.
// Deterministic, explainable agents consume the canonical closed-candle chart result.
// They qualify research/paper candidates only; they never create signals or submit orders.
export const TRADING_DESK_AGENT_VERSION = 'trading-desk-agents-1.0.0';

const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, Number.isFinite(Number(value)) ? Number(value) : low));
const sign = (value) => Math.sign(Number(value) || 0);
const pct = (value) => Math.round(clamp(value) * 10) / 10;
const has = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const alignment = (direction, value) => direction && sign(direction) === sign(value) ? 1 : direction && sign(value) ? 0 : 0.5;

const PROFILES = {
  scalp: {
    id: 'scalp', label: 'Scalping desk', preferredTimeframes: ['1m','3m','5m','15m'],
    minRR: 1.25, minConfidence: 58, minConfluence: 0.30, maxTransitionRisk: 0.62,
    maxRiskPercent: 0.25, maxDailyLossPercent: 1.5,
    maxHoldBars: 12, requireSweepOrFvg: true, requireMtf: false,
    description: 'Short-horizon liquidity, displacement and execution-cost discipline.'
  },
  day: {
    id: 'day', label: 'Day-trading desk', preferredTimeframes: ['5m','15m','30m','1h'],
    minRR: 1.6, minConfidence: 62, minConfluence: 0.36, maxTransitionRisk: 0.55,
    maxRiskPercent: 0.25, maxDailyLossPercent: 1.5,
    maxHoldBars: 48, requireSweepOrFvg: false, requireMtf: true,
    description: 'Session-aware directional trades with higher-timeframe confirmation.'
  }
};

function specialist(id, name, mandate, raw, weight, reason, available = true) {
  return { id, name, mandate, score: available ? pct(raw) : null, weight, vote: !available ? 'ABSTAIN' : raw >= 58 ? 'SUPPORT' : raw <= 38 ? 'OPPOSE' : 'NEUTRAL', reason: available ? reason : 'Required evidence is unavailable; this agent abstains.' };
}

function evaluateProfile(profile, input) {
  const direction = input.signal === 'BUY' ? 1 : input.signal === 'SELL' ? -1 : 0;
  const regime = input.regime || {};
  const mtf = Array.isArray(input.mtf) ? input.mtf : [];
  const freshMtf = mtf.filter(item => item.status === 'fresh' && has(item.bias));
  const alignedMtf = freshMtf.length ? freshMtf.filter(item => sign(item.bias) === direction).length / freshMtf.length : null;
  const setup = (input.fvgLiquidity?.setups || []).filter(item => item.state !== 'expired' && item.state !== 'invalidated');
  const linkedSetup = setup.find(item => (item.direction === 'bullish' ? 1 : -1) === direction);
  const structureItems = input.smc?.items || [];
  const sweep = structureItems.some(item => item.kind === 'LIQUIDITY_SWEEP' && sign(item.direction === 'bullish' ? 1 : -1) === direction);
  const flow = input.flow;
  const flowReady = flow?.status === 'ready' && has(flow.summary?.pressure);
  const plan = input.plan;
  const rr = plan?.targets?.[0]?.rr ?? plan?.rr1 ?? null;
  const confluence = Number(input.confluence?.score);
  const confidence = Number(input.confidence);
  const regimeAligned = regime.state === 'trending-up' ? direction > 0 : regime.state === 'trending-down' ? direction < 0 : regime.state === 'ranging' ? true : false;
  const regimeConfidence = clamp(Number(regime.confidence) * 100, 0, 100);
  const transitionRisk = Number(regime.transitionRisk);
  const costsKnown = has(input.executionCosts?.spreadPct) && has(input.executionCosts?.slippagePct);
  const flowAlignment = flowReady ? alignment(direction, flow.summary.pressure) : null;
  const mtfScore = alignedMtf == null ? null : alignedMtf * 100;
  const fvgScore = linkedSetup ? clamp(linkedSetup.score) : (sweep ? 62 : null);
  const gradePoints = Number(input.grade?.points);
  const agents = [
    specialist('structure','Structure & SMC','BOS/CHoCH/MSS, sweep/reclaim and confirmed structure', input.smc?.status === 'ready' ? (direction && sign(input.smc.trend) === direction ? 76 : 34) : 0, 1.2, 'Closed-candle structure trend ' + (input.smc?.trend ?? 'unavailable') + (sweep ? '; aligned liquidity sweep present.' : '; no aligned sweep confirmed.'), input.smc?.status === 'ready'),
    specialist('liquidity','Liquidity & FVG','Sweep quality, linked FVG freshness and target-side liquidity', fvgScore ?? 0, 1.25, linkedSetup ? 'Linked sweep-to-FVG setup score ' + linkedSetup.score + '.' : sweep ? 'Aligned sweep exists; no linked FVG setup confirmed.' : 'No aligned sweep-to-FVG setup.' , fvgScore != null),
    specialist('momentum','Momentum & displacement','Signal confidence, displacement and confluence strength', confidence * 0.55 + clamp(confluence * 100) * 0.45, 1.0, 'Signal confidence ' + confidence + '; confluence ' + (has(confluence) ? confluence.toFixed(3) : 'unavailable') + '. ', direction !== 0 && Number.isFinite(confidence) && Number.isFinite(confluence)),
    specialist('regime','Market regime','Regime suitability and transition risk', regimeAligned ? regimeConfidence : regime.state === 'ranging' ? 55 : 30, 1.0, 'Current regime: ' + (regime.state || 'unknown') + '; confidence ' + regimeConfidence.toFixed(0) + '%.', Boolean(regime.state && regime.state !== 'unknown')),
    specialist('mtf','Multi-timeframe alignment','Fresh higher-timeframe directional agreement', mtfScore ?? 50, profile.requireMtf ? 1.2 : 0.7, freshMtf.length ? Math.round(alignedMtf * 100) + '% of fresh higher timeframes align.' : 'No fresh higher-timeframe readings.', freshMtf.length > 0),
    specialist('orderflow','Order-flow pressure','Measured or estimated flow alignment', flowAlignment == null ? 50 : flowAlignment * 100, 0.85, flowReady ? 'Order-flow pressure ' + Number(flow.summary.pressure).toFixed(3) + '.' : 'Order-flow feed unavailable or stale.', flowReady),
    specialist('execution','Execution quality','Reward/risk, fee/slippage and plan completeness', has(rr) ? (rr >= profile.minRR ? (costsKnown ? 95 : 65) : clamp(rr / profile.minRR * 55)) : 0, 1.0, (has(rr) ? 'First target reward/risk ' + Number(rr).toFixed(2) + 'R.' : 'First target reward/risk unavailable.') + (costsKnown ? ' Spread and slippage assumptions are configured.' : ' Spread/slippage assumptions are missing.'), has(rr) && has(plan?.entry) && has(plan?.stopLoss)),
    specialist('capital','Independent capital protection','Hard risk veto, conflict veto and evidence integrity', 100, 1.5, 'Independent guard checks signal, plan, regime and conflict gates.', true)
  ];
  const weighted = agents.filter(agent => agent.score != null).reduce((sum, agent) => sum + agent.score * agent.weight, 0);
  const weights = agents.filter(agent => agent.score != null).reduce((sum, agent) => sum + agent.weight, 0);
  const consensus = weights ? pct(weighted / weights) : 0;
  const blockers = [];
  if (!direction || !input.active) blockers.push('No confirmed GainzAlpha BUY/SELL signal; watch-only evidence cannot qualify an entry.');
  if (!plan) blockers.push('No canonical risk plan is available.');
  if (Number(input.conflictSeverity) >= 3) blockers.push('Severe cross-domain conflict veto.');
  if (!has(rr) || rr < profile.minRR) blockers.push('First-target reward/risk is below the ' + profile.minRR.toFixed(2) + 'R desk minimum.');
  if (!profile.preferredTimeframes.includes(input.timeframe)) blockers.push('Timeframe is outside this desk profile’s supported execution horizon.');
  if (!costsKnown) blockers.push('Spread and slippage assumptions are missing; net reward/risk cannot be assessed.');
  if (!Number.isFinite(confidence) || confidence < profile.minConfidence) blockers.push('Signal confidence is below the desk minimum of ' + profile.minConfidence + '%.');
  if (!Number.isFinite(confluence) || confluence < profile.minConfluence) blockers.push('Confluence is below the desk minimum of ' + profile.minConfluence.toFixed(2) + '.');
  if (regime.state === 'volatile' && regimeConfidence < 70) blockers.push('Volatile regime lacks the desk confirmation threshold.');
  if (Number.isFinite(transitionRisk) && transitionRisk > profile.maxTransitionRisk) blockers.push('Market-regime transition risk exceeds the desk tolerance.');
  if (profile.requireSweepOrFvg && !sweep && !linkedSetup) blockers.push('Scalping requires a confirmed aligned liquidity sweep or linked FVG setup.');
  if (profile.requireMtf && alignedMtf != null && alignedMtf < 0.6) blockers.push('Fewer than 60% of fresh higher timeframes agree with the trade.');
  if (profile.requireMtf && alignedMtf == null) blockers.push('Day-trading desk requires fresh higher-timeframe evidence.');
  if (flowReady && flowAlignment === 0) blockers.push('Order-flow pressure is directly opposed to the proposed direction.');
  if (input.eventRisk?.active && Number(input.eventRisk.severity) >= 3) blockers.push('High-severity event-risk veto.');

  const riskPolicy = {
    maxRiskPercent: profile.maxRiskPercent,
    maxTransitionRisk: profile.maxTransitionRisk,
    maxDailyLossPercent: profile.maxDailyLossPercent,
    maxConcurrentPositionsPerSymbol: 1,
    maxCorrelatedPositions: 2,
    maxLeverage: 1,
    stopAfterConsecutiveLosses: 3,
    requireFeeAndSlippageEstimate: true,
    requireExchangeMinNotionalCheck: true,
    requirePaperQualificationBeforeLiveReview: true
  };
  const qualified = blockers.length === 0 && consensus >= (profile.id === 'scalp' ? 64 : 66);
  return {
    id: profile.id, label: profile.label, status: blockers.length ? 'blocked' : qualified ? 'paper-review' : 'standby',
    direction: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'WAIT',
    consensus, minConsensus: profile.id === 'scalp' ? 64 : 66, blockers,
    agents, evidence: { timeframe: input.timeframe, regime: regime.state || 'unknown', alignedHigherTimeframes: alignedMtf, linkedFvgLiquidityScore: linkedSetup?.score ?? null, firstTargetRR: rr, confidence: Number.isFinite(confidence) ? confidence : null, confluence: Number.isFinite(confluence) ? confluence : null },
    riskPolicy, preferredTimeframes: profile.preferredTimeframes, maxHoldBars: profile.maxHoldBars,
    rationale: qualified ? 'All desk gates passed. This is a paper-review candidate only.' : blockers.length ? 'The desk abstains from entry qualification until every hard gate passes.' : 'Consensus is below the desk review threshold.'
  };
}

export function evaluateTradingDeskAgents(input = {}) {
  const normalized = {
    ...input,
    active: input.active || null,
    signal: input.active?.signal || input.signal || 'WAIT',
    confidence: Number(input.active?.confidence ?? input.confidence ?? 0)
  };
  const profiles = Object.values(PROFILES).map(profile => evaluateProfile(profile, normalized));
  return {
    version: TRADING_DESK_AGENT_VERSION,
    generatedAt: new Date(Number(input.now) || Date.now()).toISOString(),
    authority: 'research-and-paper-review-only',
    signalAuthority: 'GainzAlpha',
    executionAuthority: 'none',
    profiles,
    summary: { totalAgents: profiles.reduce((n, profile) => n + profile.agents.length, 0), qualifiedProfiles: profiles.filter(profile => profile.status === 'paper-review').map(profile => profile.id), blockedProfiles: profiles.filter(profile => profile.status === 'blocked').map(profile => profile.id) }
  };
}
