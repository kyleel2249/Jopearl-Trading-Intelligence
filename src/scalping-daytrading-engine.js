// JPTI Scalping & Day-Trading Intelligence Engine
// Deterministic, explainable research agents. Paper-only: this module cannot submit orders.
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const ageOf = (timestamp, now) => { const value = typeof timestamp === 'number' ? (timestamp < 1e11 ? timestamp * 1000 : timestamp) : Date.parse(timestamp || ''); return Number.isFinite(value) ? now - value : null; };

export const SHORT_TERM_SQUADS = Object.freeze([
  { id: 'scalping', name: 'SCALP STRIKE DIVISION', style: 'scalping', horizon: 'seconds-to-minutes', agents: [
    { id: 'nyx', name: 'Nyx', specialty: 'microstructure', requires: ['spreadBps','orderBookImbalance','tradeFlowImbalance','bookAgeMs'] },
    { id: 'vega', name: 'Vega', specialty: 'liquidity-sweep', requires: ['liquiditySweep','sweepReclaimed','relativeVolume'] },
    { id: 'cipher', name: 'Cipher', specialty: 'smc-fvg', requires: ['marketStructure','fvg','displacementPct','premiumDiscount'] },
    { id: 'razor', name: 'Razor', specialty: 'execution-cost', requires: ['spreadBps','slippageBps','feeBps','expectedMoveBps'] },
    { id: 'pulse', name: 'Pulse', specialty: 'momentum-burst', requires: ['momentumPct','relativeVolume','volatilityPct'] },
    { id: 'wraith', name: 'Wraith', specialty: 'absorption-exhaustion', requires: ['absorptionDetected','tradeFlowImbalance','priceResponsePct'] },
    { id: 'vector', name: 'Vector', specialty: 'breakout-retest', requires: ['breakoutConfirmed','retestConfirmed','relativeVolume'] },
    { id: 'shade', name: 'Shade', specialty: 'mean-reversion', requires: ['vwapDeviationPct','rsi','volatilityPct'] }
  ]},
  { id: 'day-trading', name: 'INTRADAY TACTICAL DIVISION', style: 'day-trading', horizon: 'minutes-to-session', agents: [
    { id: 'atlas', name: 'Atlas', specialty: 'multi-timeframe-structure', requires: ['marketStructure','timeframeAlignment','higherTimeframeBias'] },
    { id: 'lyra', name: 'Lyra', specialty: 'session-opening-range', requires: ['session','sessionOpen','openingRangeHigh','openingRangeLow','price'] },
    { id: 'kestrel', name: 'Kestrel', specialty: 'trend-vwap', requires: ['vwap','emaFast','emaSlow','adx','momentumPct'] },
    { id: 'morpheus', name: 'Morpheus', specialty: 'reversal-exhaustion', requires: ['reversalConfirmed','rsi','momentumPct','volatilityPct'] },
    { id: 'oracle', name: 'Oracle', specialty: 'event-risk', requires: ['highImpactEvent','minutesToEvent','eventSourceVerified'] },
    { id: 'titan', name: 'Titan', specialty: 'position-risk', requires: ['equityUsd','riskPct','stopDistancePct','drawdownPct'] },
    { id: 'solstice', name: 'Solstice', specialty: 'regime-fit', requires: ['marketRegime','strategyRegimeFit'] },
    { id: 'meridian', name: 'Meridian', specialty: 'cross-market-confirmation', requires: ['crossAssetBias','correlationQuality','crossAssetTimestamp'] }
  ]}
]);

const directional = (e, specialty) => {
  switch (specialty) {
    case 'microstructure': return clamp((Number(e.orderBookImbalance) * .55 + Number(e.tradeFlowImbalance) * .45), -1, 1);
    case 'liquidity-sweep': return e.liquiditySweep && e.sweepReclaimed ? (e.sweepDirection === 'short' ? -1 : 1) : 0;
    case 'smc-fvg': return e.marketStructure === 'bullish' && e.premiumDiscount === 'discount' ? 1 : e.marketStructure === 'bearish' && e.premiumDiscount === 'premium' ? -1 : 0;
    case 'execution-cost': return Number(e.expectedMoveBps) > Number(e.spreadBps) + Number(e.slippageBps) + Number(e.feeBps) * 2 ? 1 : 0;
    case 'momentum-burst': return Math.sign(Number(e.momentumPct)) * clamp(Number(e.relativeVolume) / 2, 0, 1);
    case 'absorption-exhaustion': return e.absorptionDetected ? -Math.sign(Number(e.tradeFlowImbalance)) * clamp(Math.abs(Number(e.priceResponsePct)) || .25, 0, 1) : 0;
    case 'breakout-retest': return e.breakoutConfirmed && e.retestConfirmed ? (e.breakoutDirection === 'short' ? -1 : 1) : 0;
    case 'mean-reversion': return Math.abs(Number(e.vwapDeviationPct)) >= .8 ? -Math.sign(Number(e.vwapDeviationPct)) * (Number(e.rsi) > 75 || Number(e.rsi) < 25 ? 1 : .5) : 0;
    case 'multi-timeframe-structure': return e.marketStructure === 'bullish' ? Math.abs(Number(e.timeframeAlignment)) : e.marketStructure === 'bearish' ? -Math.abs(Number(e.timeframeAlignment)) : 0;
    case 'session-opening-range': return Number(e.price) > Number(e.openingRangeHigh) ? 1 : Number(e.price) < Number(e.openingRangeLow) ? -1 : 0;
    case 'trend-vwap': return Number(e.emaFast) > Number(e.emaSlow) && Number(e.price) > Number(e.vwap) ? 1 : Number(e.emaFast) < Number(e.emaSlow) && Number(e.price) < Number(e.vwap) ? -1 : 0;
    case 'reversal-exhaustion': return e.reversalConfirmed ? -Math.sign(Number(e.momentumPct)) : 0;
    case 'event-risk': return e.highImpactEvent === true || Number(e.minutesToEvent) <= 5 ? 0 : 1;
    case 'position-risk': return Number(e.drawdownPct) < 8 && Number(e.riskPct) > 0 && Number(e.riskPct) <= 1 ? 1 : 0;
    case 'regime-fit': return Number(e.strategyRegimeFit) >= .65 ? Math.sign(Number(e.regimeDirection) || 1) : 0;
    case 'cross-market-confirmation': return Number(e.correlationQuality) >= .6 ? clamp(Number(e.crossAssetBias), -1, 1) : 0;
    default: return 0;
  }
};

export function evaluateShortTermAgents(input = {}, options = {}) {
  const style = String(input.style || 'both').toLowerCase();
  if (!['scalping','day-trading','both'].includes(style)) throw new Error('Unsupported short-term trading style.');
  const evidence = input.evidence || {};
  const now = Number(options.now) || Date.now();
  const maxAge = clamp(options.maxAgeMs ?? (style === 'scalping' ? 5000 : 60000), 1000, 86400000);
  const eventAgeMs = ageOf(evidence.timestamp, now);
  const stale = eventAgeMs === null || eventAgeMs < -5000 || eventAgeMs > maxAge;
  const squads = SHORT_TERM_SQUADS.filter(s => style === 'both' || s.style === style);
  const agents = squads.flatMap(squad => squad.agents.map(agent => {
    const missingEvidence = agent.requires.filter(key => evidence[key] === undefined || evidence[key] === null || evidence[key] === '');
    const agentStale = agent.specialty === 'microstructure' && (!finite(evidence.bookAgeMs) || Number(evidence.bookAgeMs) > maxAge);
    const ready = missingEvidence.length === 0 && !stale && !agentStale;
    const score = ready ? Number(directional(evidence, agent.specialty).toFixed(4)) : null;
    return { ...agent, squadId: squad.id, style: squad.style, status: ready ? 'evaluated' : 'abstain', score, confidence: ready ? Number(Math.min(1, Math.abs(score) * .8 + .2).toFixed(4)) : 0, missingEvidence: [...missingEvidence, ...(stale ? ['fresh-event-time'] : []), ...(agentStale ? ['fresh-order-book'] : [])], executionPermission: 'none' };
  }));
  const results = squads.map(squad => {
    const members = agents.filter(agent => agent.squadId === squad.id);
    const votes = members.filter(agent => agent.status === 'evaluated' && Math.abs(Number(agent.score)) >= .2);
    const longVotes = votes.filter(agent => agent.score > 0).length;
    const shortVotes = votes.filter(agent => agent.score < 0).length;
    const score = votes.length ? votes.reduce((sum, agent) => sum + agent.score * agent.confidence, 0) / votes.reduce((sum, agent) => sum + agent.confidence, 0) : 0;
    const direction = score > .15 ? 'long' : score < -.15 ? 'short' : 'flat';
    const conflicts = longVotes > 0 && shortVotes > 0 && Math.min(longVotes, shortVotes) / Math.max(longVotes, shortVotes) >= .5;
    const spread = Number(evidence.spreadBps), slippage = Number(evidence.slippageBps), fee = Number(evidence.feeBps);
    const costBps = finite(spread) && finite(slippage) && finite(fee) ? spread + slippage + fee * 2 : null;
    const expectedMove = Number(evidence.expectedMoveBps);
    const costEdgePassed = costBps !== null && finite(expectedMove) && expectedMove > costBps * Number(options.minimumNetEdgeMultiple ?? 1.5);
    const sessionAllowed = evidence.sessionOpen === true && evidence.venueCalendarVerified === true;
    const eventAllowed = evidence.highImpactEvent !== true && !(finite(evidence.minutesToEvent) && Number(evidence.minutesToEvent) <= Number(options.eventBufferMinutes ?? 5));
    const riskInputs = ['equityUsd','riskPct','stopDistancePct','drawdownPct'].every(key => finite(evidence[key]));
    const riskAllowed = riskInputs && Number(evidence.equityUsd) > 0 && Number(evidence.riskPct) > 0 && Number(evidence.riskPct) <= Number(options.maxRiskPct ?? .5) && Number(evidence.drawdownPct) < Number(options.maxDrawdownPct ?? 8) && Number(evidence.stopDistancePct) > 0;
    const sampleAllowed = evidence.strategyQualified === true && evidence.forwardValidationPassed === true;
    const styleSpecific = squad.style === 'scalping' ? costEdgePassed && finite(evidence.bookAgeMs) && Number(evidence.bookAgeMs) <= maxAge : sessionAllowed;
    const veto = [];
    if (stale) veto.push('stale-or-missing-event-time');
    if (!styleSpecific) veto.push(squad.style === 'scalping' ? 'scalping-execution-cost-or-book-freshness-gate' : 'day-trading-venue-session-gate');
    if (!eventAllowed) veto.push('event-risk-buffer');
    if (!riskAllowed) veto.push('portfolio-risk-or-stop-distance-gate');
    if (!sampleAllowed) veto.push('strategy-not-forward-qualified');
    if (conflicts) veto.push('specialist-vote-conflict');
    if (votes.length < Number(options.minimumVotes ?? 2)) veto.push('insufficient-independent-specialist-votes');
    if (direction === 'flat') veto.push('no-directional-edge');
    const stopDistancePct = Number(evidence.stopDistancePct);
    const riskUsd = riskAllowed ? Number(evidence.equityUsd) * Number(evidence.riskPct) / 100 : 0;
    const notionalCapUsd = riskAllowed ? riskUsd / (stopDistancePct / 100) : 0;
    return { squadId: squad.id, name: squad.name, style: squad.style, horizon: squad.horizon, direction, score: Number(score.toFixed(4)), confidence: Number(Math.abs(score).toFixed(4)), evaluatedAgents: members.filter(x => x.status === 'evaluated').length, votes: votes.length, longVotes, shortVotes, conflicts, estimatedRoundTripCostBps: costBps, expectedMoveBps: finite(expectedMove) ? expectedMove : null, riskUsd: Number(riskUsd.toFixed(2)), notionalCapUsd: Number(notionalCapUsd.toFixed(2)), eligibleForPaper: veto.length === 0, veto, executionPermission: 'none' };
  });
  return { generatedAt: new Date(now).toISOString(), eventTimestamp: evidence.timestamp || null, evidenceAgeMs: eventAgeMs, stale, squads: results, agents, paperOnly: true, liveExecutionAuthorized: false };
}

export function evaluateShortTermRisk(input = {}, policy = {}) {
  const equity = Number(input.equityUsd), drawdown = Number(input.drawdownPct), dailyLoss = Number(input.dailyLossPct), lossStreak = Number(input.lossStreak);
  const violations = [];
  if (!finite(equity) || equity <= 0) violations.push('invalid-equity');
  if (!finite(drawdown) || drawdown >= Number(policy.maxDrawdownPct ?? 8)) violations.push('drawdown-limit');
  if (!finite(dailyLoss) || dailyLoss >= Number(policy.maxDailyLossPct ?? 2)) violations.push('daily-loss-limit');
  if (!finite(lossStreak) || lossStreak >= Number(policy.maxLossStreak ?? 5)) violations.push('loss-streak-limit');
  if (input.dataFresh !== true) violations.push('market-data-not-fresh');
  if (input.venueCalendarVerified !== true) violations.push('venue-calendar-not-verified');
  return { allowed: violations.length === 0, violations, liveExecutionAuthorized: false };
}

export function scoreShortTermStrategy(metrics = {}, policy = {}) {
  const closed = Number(metrics.closedTrades) || 0, expectancy = Number(metrics.expectancyR), profitFactor = Number(metrics.profitFactor), drawdown = Number(metrics.maxDrawdownPct);
  const reasons = [];
  if (closed < Number(policy.minimumTrades ?? 50)) reasons.push('insufficient-out-of-sample-trades');
  if (!finite(expectancy) || expectancy <= 0) reasons.push('non-positive-net-expectancy');
  if (!finite(profitFactor) || profitFactor < Number(policy.minimumProfitFactor ?? 1.15)) reasons.push('profit-factor-below-floor');
  if (!finite(drawdown) || drawdown > Number(policy.maximumDrawdownPct ?? 8)) reasons.push('drawdown-limit-exceeded');
  if (metrics.feesAndSlippageIncluded !== true) reasons.push('execution-costs-not-modelled');
  if (metrics.walkForwardPassed !== true) reasons.push('walk-forward-validation-failed');
  if (metrics.paperForwardPassed !== true) reasons.push('paper-forward-validation-failed');
  if (metrics.dataIntegrity !== 'verified') reasons.push('data-integrity-unverified');
  return { qualified: reasons.length === 0, status: reasons.length ? 'quarantined-or-observation' : 'eligible-for-controlled-paper-allocation', reasons, requiresHumanReview: true, liveExecutionAuthorized: false };
}
