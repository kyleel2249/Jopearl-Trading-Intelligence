// Shared, runtime-safe research council engine (Node, Cloudflare Pages Functions, tests).
// Deterministic specialists only: no language-model deliberation and no order creation.
import { parseEvidenceTimestamp } from './agent-fleet-engine.js';

const finite = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
export const COUNCIL_RISK_VETO_SCORE = -.48;

export function evaluateResearchCouncil(input = {}, now = Date.now(), options = {}) {
  const e = input.evidence && typeof input.evidence === 'object' ? input.evidence : input;
  const maxAgeMs = clamp(Number(options.maxAgeMs) || 60000, 5000, 300000);
  const stamp = parseEvidenceTimestamp(e.timestamp);
  const ageMs = Number.isFinite(stamp) ? now - stamp : null;
  const stale = ageMs === null || ageMs < -5000 || ageMs > maxAgeMs;
  const symbol = String(input.symbol || e.symbol || '').trim().toUpperCase().slice(0, 40);
  const assetClass = String(input.assetClass || e.assetClass || 'unknown').trim().toLowerCase().slice(0, 40);
  const sources = Array.isArray(e.sources) ? e.sources.slice(0, 20) : [];
  const agents = [];
  const add = (id, specialty, score, confidence, required, reason) => {
    const missing = required.filter(key => finite(e[key]) === null);
    agents.push({ id, specialty, status: stale ? 'blocked_stale_evidence' : missing.length ? 'insufficient_evidence' : 'evaluated',
      score: stale || missing.length ? null : clamp(score, -1, 1), confidence: stale || missing.length ? 0 : clamp(confidence, 0, 1),
      missingEvidence: missing, reason: stale ? 'Evidence timestamp is missing, future-dated or outside the freshness policy.' : reason });
  };
  const momentum = finite(e.momentumPct), alignment = finite(e.timeframeAlignment), relativeVolume = finite(e.relativeVolume), volumeChange = finite(e.volumeChangePct);
  const imbalance = finite(e.depthImbalance), funding = finite(e.fundingRate), oi = finite(e.openInterestChangePct);
  const liquidity = finite(e.liquidityUsd), volatility = finite(e.volatilityPct);

  add('trend', 'Trend and multi-timeframe structure', momentum === null || alignment === null ? 0 : clamp(momentum / 5 * .55 + alignment * .45, -1, 1), .75, ['momentumPct', 'timeframeAlignment'], 'Combines normalized momentum and multi-timeframe alignment.');
  // Volume confirms the direction of momentum; a rising/falling volume trend nudges that confirmation (optional evidence).
  const participationBase = momentum === null || relativeVolume === null ? 0 : clamp((relativeVolume - 0.7) / 2, 0, 1);
  const volumeTrendNudge = volumeChange === null ? 0 : clamp(volumeChange / 200, -.15, .15);
  add('participation', 'Volume and participation', momentum === null || relativeVolume === null ? 0 : sign(momentum) * clamp(participationBase + volumeTrendNudge, 0, 1), .65, ['momentumPct', 'relativeVolume'],
    volumeChange === null ? 'Volume is treated as confirmation, not direction by itself.' : 'Volume is treated as confirmation; the supplied volume-change trend strengthens or weakens it.');
  add('microstructure', 'Order-book pressure', imbalance === null ? 0 : imbalance, .6, ['depthImbalance'], 'Uses normalized visible bid/ask depth imbalance; snapshots cannot identify spoofing.');
  // Open-interest change is context: rising OI with momentum suggests new positioning; falling OI suggests unwinding.
  const oiContext = oi === null || momentum === null ? 0 : sign(momentum) * sign(oi) * Math.min(.25, Math.abs(oi) / 40);
  add('derivatives', 'Funding and open-interest positioning', clamp((funding === null ? 0 : -sign(funding) * clamp(Math.abs(funding) * 500, 0, 1)) + oiContext, -1, 1), .55, ['fundingRate'],
    'Extreme positive funding is treated as crowded-long risk and negative funding as crowded-short risk; supplied open-interest change adds positioning context.');
  add('macro', 'Macro and cross-asset regime', e.macroBias === 'risk-on' ? .65 : e.macroBias === 'risk-off' ? -.65 : 0, .5, [], e.macroBias === 'risk-on' || e.macroBias === 'risk-off' ? 'Uses the supplied macro regime label.' : 'No directional macro regime supplied.');
  const liquidityRisk = liquidity === null ? null : (liquidity < 10000 ? -.65 : liquidity < 50000 ? -.25 : .1);
  const volatilityRisk = volatility === null ? 0 : volatility > 12 ? -.5 : volatility > 6 ? -.2 : 0;
  add('risk', 'Liquidity and volatility risk', liquidityRisk === null ? 0 : liquidityRisk + volatilityRisk, .8, ['liquidityUsd'], 'Penalizes thin liquidity and unusually high realized volatility; it is a risk vote, not a directional prediction.');

  const usable = agents.filter(a => a.status === 'evaluated' && a.score !== null);
  const directional = usable.filter(a => a.id !== 'risk');
  const totalWeight = directional.reduce((s, a) => s + a.confidence, 0);
  const weighted = totalWeight ? directional.reduce((s, a) => s + a.score * a.confidence, 0) / totalWeight : 0;
  const positive = directional.filter(a => a.score > .15).length, negative = directional.filter(a => a.score < -.15).length;
  const agreement = directional.length ? Math.max(positive, negative) / directional.length : 0;
  const evidenceCoverage = agents.filter(a => a.status === 'evaluated').length / agents.length;
  const failedSources = sources.filter(s => s?.status === 'error' || s?.stale === true).length;
  const qualityPenalty = stale ? 0 : Math.max(0, 1 - (failedSources / Math.max(1, sources.length)) * .5);
  const riskScore = usable.find(a => a.id === 'risk')?.score ?? null;
  const requiredSourceFailure = sources.some(s => s?.required === true && (s.status === 'error' || s.stale === true));
  const riskVeto = riskScore !== null && riskScore < COUNCIL_RISK_VETO_SCORE;
  const insufficient = stale || directional.length < 3 || requiredSourceFailure;
  const blocked = insufficient || riskVeto;
  const confidence = blocked ? 0 : clamp(agreement * .45 + Math.abs(weighted) * .35 + evidenceCoverage * .2, 0, 1) * qualityPenalty;
  const stance = insufficient ? 'insufficient_evidence' : riskVeto ? 'risk_blocked' : weighted > .2 ? 'research_bullish_lean' : weighted < -.2 ? 'research_bearish_lean' : 'neutral';
  return {
    id: globalThis.crypto.randomUUID(), generatedAt: new Date(now).toISOString(), symbol: symbol || null, assetClass,
    evidence: { timestamp: Number.isFinite(stamp) ? new Date(stamp).toISOString() : null, ageMs, maxAgeMs, sourceCount: sources.length, sourceIds: sources.map(s => String(s?.id || s?.provider || 'unknown').slice(0, 64)) },
    agents, consensus: { stance, weightedScore: blocked ? null : Number(weighted.toFixed(4)), agreementRatio: Number(agreement.toFixed(4)), confidence: Number(confidence.toFixed(4)), directionalAgentCount: directional.length, positiveVotes: positive, negativeVotes: negative, dissent: positive > 0 && negative > 0 },
    risk: { riskScore, staleEvidence: stale, blocked, riskVeto, vetoThreshold: COUNCIL_RISK_VETO_SCORE,
      reasons: [stale && 'Evidence freshness failed', directional.length < 3 && !stale && 'Fewer than three directional specialists have sufficient evidence', requiredSourceFailure && 'A required data source failed', riskVeto && 'Risk specialist vetoed on liquidity/volatility'].filter(Boolean),
      missingEvidence: agents.flatMap(a => a.missingEvidence.map(field => a.id + ':' + field)) },
    permissions: { paperEntryEligible: false, liveExecutionAuthorized: false, ordersCreated: 0 },
    interpretation: 'Explainable deterministic specialist ensemble. It is not a language-model deliberation, a calibrated probability, a personalized investment recommendation or an order instruction.'
  };
}
