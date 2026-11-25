import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { runAgentFleet, buildAgentCatalog } from '../src/agent-fleet-engine.js';
import { summarizeAgentPerformance } from '../src/agent-performance-engine.js';

/**
 * Deterministic, explainable specialist agents. The fleet never fabricates missing
 * evidence and never places orders. Its output is a research decision packet.
 */
export { runAgentFleet };
export const agentFleetRouter = express.Router();

export const FEEDBACK_OUTCOMES = Object.freeze(['win', 'loss', 'breakeven', 'invalidated', 'not_taken']);
const MAX_REALIZED_R = 100;
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const boundedR = value => { const n = finite(value); return n === null ? null : Math.max(-MAX_REALIZED_R, Math.min(MAX_REALIZED_R, n)); };
// Auth failures carry a status from policy.js; anything else is a server-side fault, not a bad request.
const statusOf = (error, fallback) => Number.isInteger(error?.status) ? error.status : fallback;

agentFleetRouter.get('/agents/catalog', (_req, res) => { res.json(buildAgentCatalog()); });

agentFleetRouter.post('/agents/evaluate', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const result = runAgentFleet(req.body || {});
    let persisted = true;
    try {
      await appendStoredEvent({ kind: 'agent-fleet-evaluation', source: 'jpti-agent-fleet', eventType: 'agent_evaluation',
        externalId: result.id, symbol: result.symbol, occurredAt: result.generatedAt, payload: result });
    } catch (storageError) {
      // The evaluation is pure; do not discard it because memory storage is unavailable.
      persisted = false;
      console.error('[JPTI agents] evaluation could not be persisted:', storageError?.message || storageError);
    }
    res.set('Cache-Control', 'no-store');
    res.json({ ...result, persisted, ...(persisted ? {} : { warning: 'Evaluation computed but not saved to agent memory; outcome feedback is unavailable for it.' }) });
  } catch (error) { res.status(statusOf(error, 400)).json({ error: error.message || 'Agent evaluation failed.' }); }
});

agentFleetRouter.get('/agents/history', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '25', 10) || 25));
    const rows = await readStoredEvents(10000, 'agent-fleet-evaluation');
    res.set('Cache-Control', 'no-store');
    res.json({ count: rows.length, evaluations: rows.slice(-limit).reverse().map(row => row.payload) });
  } catch (error) { res.status(statusOf(error, 500)).json({ error: error.message || 'Agent history unavailable.' }); }
});

agentFleetRouter.get('/agents/performance', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const [evaluations, feedback] = await Promise.all([
      readStoredEvents(10000, 'agent-fleet-evaluation'), readStoredEvents(10000, 'agent-fleet-feedback')]);
    res.set('Cache-Control', 'no-store');
    res.json(summarizeAgentPerformance(evaluations.map(row => row.payload), feedback.map(row => row.payload)));
  } catch (error) { res.status(statusOf(error, 500)).json({ error: error.message || 'Agent performance unavailable.' }); }
});

agentFleetRouter.post('/agents/feedback', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const evaluationId = String(req.body?.evaluationId || '').trim();
    const outcome = String(req.body?.outcome || '').trim().toLowerCase();
    if (!evaluationId || !FEEDBACK_OUTCOMES.includes(outcome))
      return res.status(400).json({ error: 'Provide an evaluationId and a supported outcome.' });
    const rows = await readStoredEvents(10000, 'agent-fleet-evaluation');
    const evaluation = rows.map(row => row.payload).find(row => row.id === evaluationId);
    if (!evaluation) return res.status(404).json({ error: 'Evaluation not found.' });
    const feedback = { id: randomUUID(), evaluationId, symbol: evaluation.symbol, outcome,
      realizedR: boundedR(req.body?.realizedR), notes: String(req.body?.notes || '').slice(0, 1000),
      recordedAt: new Date().toISOString(), learningMode: 'observational_only',
      permission: 'Feedback informs reporting; it does not mutate strategies or authorize execution.' };
    await appendStoredEvent({ kind: 'agent-fleet-feedback', source: 'jpti-agent-fleet', eventType: 'outcome_feedback',
      externalId: feedback.id, symbol: feedback.symbol, occurredAt: feedback.recordedAt, payload: feedback });
    res.status(201).json({ ...feedback, persisted: true });
  } catch (error) { res.status(statusOf(error, 500)).json({ error: error.message || 'Agent feedback could not be saved.' }); }
});
