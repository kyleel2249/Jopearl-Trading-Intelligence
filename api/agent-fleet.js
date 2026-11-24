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
export { runAgentFleet } from '../src/agent-fleet-engine.js';
import { runAgentFleet } from '../src/agent-fleet-engine.js';


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
