// Shared runtime-safe agent scoring engine used by Node and Cloudflare Pages.
export function runAgentFleet(input = {}, now = Date.now(), policy = {}) {
  const e = input.evidence && typeof input.evidence === 'object' ? input.evidence : input;
  const maxAgeMs = Math.max(5000, Math.min(300000, Number(policy.maxAgeMs) || 60000));
  const timestamp = Date.parse(String(e.timestamp || ''));
  const ageMs = Number.isFinite(timestamp) ? now - timestamp : null;
  const stale = ageMs === null || ageMs < -5000 || ageMs > maxAgeMs;
  const symbol = String(input.symbol || e.symbol || '').trim().toUpperCase().slice(0, 40) || null;
  const agents = [];
  const add = (id, domain, score, confidence, required, rationale, kind = 'directional') => {
    const missing = required.filter(key => finite(e[key]) === null);
    const status = stale ? 'blocked_stale_evidence' : missing.length ? 'insufficient_evidence' : 'evaluated';
    agents.push({ id, domain, kind, status, score: status === 'evaluated' ? Number(clamp(score).toFixed(4)) : null,
      confidence: status === 'evaluated' ? Number(clamp(confidence, 0, 1).toFixed(4)) : 0,
      missingEvidence: missing, rationale: status === 'evaluated' ? rationale : stale ? 'Evidence is missing, future-dated or outside the freshness window.' : 'Required evidence is unavailable.' });
  };
  const momentum = finite(e.momentumPct), alignment = finite(e.timeframeAlignment);
  const rvol = finite(e.relativeVolume), imbalance = finite(e.depthImbalance);
  const funding = finite(e.fundingRate), oi = finite(e.openInterestChangePct);
  const volatility = finite(e.volatilityPct), liquidity = finite(e.liquidityUsd);
  const trendScore = momentum === null || alignment === null ? 0 : clamp(momentum / 4 * .55 + alignment * .45);
  add('trend', 'Trend & multi-timeframe structure', trendScore, .78, ['momentumPct','timeframeAlignment'], 'Combines normalized momentum with supplied timeframe alignment.');
  add('participation', 'Volume participation', momentum === null || rvol === null ? 0 : sign(momentum) * clamp((rvol - .75) / 1.75), .68, ['momentumPct','relativeVolume'], 'Volume confirms participation; it does not create direction on its own.');
  add('microstructure', 'Visible order-book pressure', imbalance ?? 0, .62, ['depthImbalance'], 'Uses normalized bid/ask depth imbalance. A snapshot cannot prove spoofing.');
  const derivativesScore = (funding === null ? 0 : -sign(funding) * clamp(Math.abs(funding) * 450)) +
    (oi === null || momentum === null ? 0 : sign(momentum) * sign(oi) * Math.min(.25, Math.abs(oi) / 40));
  add('derivatives', 'Funding & open-interest positioning', clamp(derivativesScore), .58, ['fundingRate'], 'Treats crowded funding as a contrarian risk and uses OI change as context.');
  const macroScore = e.macroBias === 'risk-on' ? .55 : e.macroBias === 'risk-off' ? -.55 : 0;
  add('macro', 'Macro & cross-asset regime', macroScore, .45, [], 'Uses only the supplied macro regime label; no external event feed is inferred.');
  const volatilityPenalty = volatility === null ? 0 : volatility > 12 ? .55 : volatility > 7 ? .25 : 0;
  const liquidityPenalty = liquidity === null ? .35 : liquidity < 10000 ? .65 : liquidity < 50000 ? .3 : 0;
  add('risk', 'Liquidity & volatility guard', -(volatilityPenalty + liquidityPenalty) / 1.2, .85, ['liquidityUsd'], 'Penalizes thin liquidity and elevated volatility; this is a risk vote, not direction.', 'risk');
  add('liquidity', 'Liquidity conditions', liquidity === null ? 0 : liquidity < 10000 ? -.7 : liquidity < 50000 ? -.2 : .15, .66, ['liquidityUsd'], 'Classifies supplied quote liquidity; it cannot identify hidden liquidity.');
  add('momentum', 'Momentum & reversal watch', momentum === null ? 0 : clamp(momentum / 3), .6, ['momentumPct'], 'Scores recent momentum and flags extension risk for downstream review.');
  add('correlation', 'Cross-asset / pair context', finite(e.correlationBias) ?? 0, .4, ['correlationBias'], 'Uses supplied normalized correlation bias; missing pair context is not guessed.');
  add('event', 'Event & news risk', e.highImpactEvent === true ? -.8 : e.highImpactEvent === false ? .1 : 0, .75, ['highImpactEvent'], 'Blocks enthusiasm around a supplied high-impact event flag.', 'risk');

  const usable = agents.filter(a => a.status === 'evaluated');
  const directional = usable.filter(a => a.kind === 'directional');
  const weight = directional.reduce((sum, a) => sum + a.confidence, 0);
  const weightedScore = weight ? directional.reduce((sum, a) => sum + a.score * a.confidence, 0) / weight : 0;
  const positive = directional.filter(a => a.score > .15).length;
  const negative = directional.filter(a => a.score < -.15).length;
  const neutral = directional.length - positive - negative;
  const agreement = directional.length ? Math.max(positive, negative, neutral) / directional.length : 0;
  const riskVotes = usable.filter(a => a.kind === 'risk');
  const riskScore = riskVotes.length ? riskVotes.reduce((sum, a) => sum + a.score * a.confidence, 0) / riskVotes.reduce((sum, a) => sum + a.confidence, 0) : null;
  const sources = Array.isArray(e.sources) ? e.sources.slice(0, 20) : [];
  const sourceFailure = sources.some(source => source?.required && (source.status === 'error' || source.stale === true));
  const blocked = stale || directional.length < 4 || sourceFailure || riskScore !== null && riskScore < -.48;
  const stance = blocked ? 'insufficient_evidence_or_risk_block' : weightedScore > .2 ? 'bullish_research_lean' : weightedScore < -.2 ? 'bearish_research_lean' : 'neutral_wait';
  const dissent = positive > 0 && negative > 0;
  const debate = {
    thesis: positive >= negative ? 'Bullish case: trend/participation/microstructure votes support upside.' : 'Bearish case: downside votes outweigh bullish evidence.',
    challenge: dissent ? 'Counter-case: specialist agents disagree. Reduce conviction and wait for confirmation.' : 'No material directional split among currently evaluated agents.',
    unresolved: agents.filter(a => a.status !== 'evaluated').map(a => a.id),
    dissent, positiveVotes: positive, negativeVotes: negative, neutralVotes: neutral
  };
  const confidence = blocked ? 0 : clamp(agreement * .45 + Math.abs(weightedScore) * .35 + usable.length / agents.length * .2, 0, 1);
  return {
    id: randomUUID(), generatedAt: new Date(now).toISOString(), symbol,
    evidence: { timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, ageMs, maxAgeMs,
      freshness: stale ? 'stale_or_missing' : 'fresh', sourceCount: sources.length },
    agents, debate,
    consensus: { stance, weightedScore: blocked ? null : Number(weightedScore.toFixed(4)),
      agreementRatio: Number(agreement.toFixed(4)), confidence: Number(confidence.toFixed(4)),
      evaluatedAgents: usable.length, totalAgents: agents.length },
    risk: { score: riskScore === null ? null : Number(riskScore.toFixed(4)), blocked,
      reasons: [stale && 'Evidence freshness failed', directional.length < 4 && 'Fewer than four directional specialists have sufficient evidence',
        sourceFailure && 'A required data source failed', riskScore !== null && riskScore < -.62 && 'Risk agents vetoed the opportunity'].filter(Boolean) },
    recommendedAction: blocked ? 'NO_TRADE' : stance === 'neutral_wait' || dissent ? 'WAIT_FOR_CONFIRMATION' : 'REVIEW_SETUP',
    permissions: { researchOnly: true, paperExecutionAuthorized: false, liveExecutionAuthorized: false, ordersCreated: 0 },
    audit: { method: 'deterministic-specialist-ensemble-v1', calibratedProbability: false, llmDebate: false,
      disclaimer: 'This is explainable research output, not a probability forecast, order instruction or execution authorization.' }
  };
}
