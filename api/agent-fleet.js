import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';

export const agentFleetRouter = express.Router();
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, value));
const sign = value => value > 0 ? 1 : value < 0 ? -1 : 0;

/**
 * Deterministic, explainable specialist agents. The fleet never fabricates missing
 * evidence and never places orders. Its output is a research decision packet.
 */
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
  const blocked = stale || directional.length < 4 || sourceFailure || riskScore !== null && riskScore < -.62;
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

agentFleetRouter.get('/agents/catalog', (_req, res) => {
  res.json({ version: '1.0.0', mode: 'research-and-paper-review', agents: [
    ['trend','Trend & multi-timeframe analyst'],['participation','Volume participation analyst'],['microstructure','Order-book pressure analyst'],
    ['derivatives','Funding & open-interest analyst'],['macro','Macro regime analyst'],['risk','Liquidity & volatility risk analyst'],
    ['liquidity','Liquidity conditions analyst'],['momentum','Momentum & reversal analyst'],['correlation','Cross-asset context analyst'],
    ['event','Event risk analyst']
  ].map(([id,name]) => ({ id, name, executionPermission: 'none' })),
  capabilities: ['specialist-voting','dissent-detection','explainable-rationales','freshness-gates','risk-veto','append-only-memory','outcome-feedback','strategy-review-gates'] });
});

agentFleetRouter.post('/agents/evaluate', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const result = runAgentFleet(req.body || {});
    await appendStoredEvent({ kind: 'agent-fleet-evaluation', source: 'jpti-agent-fleet', eventType: 'agent_evaluation',
      externalId: result.id, symbol: result.symbol, occurredAt: result.generatedAt, payload: result });
    res.set('Cache-Control', 'no-store');
    res.json({ ...result, persisted: true });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Agent evaluation failed.' }); }
});

agentFleetRouter.get('/agents/history', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '25', 10) || 25));
    const rows = await readStoredEvents(10000, 'agent-fleet-evaluation');
    res.set('Cache-Control', 'no-store');
    res.json({ count: rows.length, evaluations: rows.slice(-limit).reverse().map(row => row.payload) });
  } catch (error) { res.status(error.status || 401).json({ error: error.message || 'Agent history unavailable.' }); }
});

agentFleetRouter.post('/agents/feedback', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const evaluationId = String(req.body?.evaluationId || '').trim();
    const outcome = String(req.body?.outcome || '').trim().toLowerCase();
    if (!evaluationId || !['win','loss','breakeven','invalidated','not_taken'].includes(outcome))
      return res.status(400).json({ error: 'Provide an evaluationId and a supported outcome.' });
    const rows = await readStoredEvents(10000, 'agent-fleet-evaluation');
    const evaluation = rows.map(row => row.payload).find(row => row.id === evaluationId);
    if (!evaluation) return res.status(404).json({ error: 'Evaluation not found.' });
    const feedback = { id: randomUUID(), evaluationId, symbol: evaluation.symbol, outcome,
      realizedR: finite(req.body?.realizedR), notes: String(req.body?.notes || '').slice(0, 1000),
      recordedAt: new Date().toISOString(), learningMode: 'observational_only',
      permission: 'Feedback informs reporting; it does not mutate strategies or authorize execution.' };
    await appendStoredEvent({ kind: 'agent-fleet-feedback', source: 'jpti-agent-fleet', eventType: 'outcome_feedback',
      externalId: feedback.id, symbol: feedback.symbol, occurredAt: feedback.recordedAt, payload: feedback });
    res.status(201).json({ ...feedback, persisted: true });
  } catch (error) { res.status(error.status || 400).json({ error: error.message || 'Agent feedback could not be saved.' }); }
});
