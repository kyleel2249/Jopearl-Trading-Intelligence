import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { evaluateTradingValidation, agentExecutionGate, VALIDATION_POLICY } from '../src/trading-validation-engine.js';

export const validationRouter = express.Router();
validationRouter.get('/policy', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ policy: VALIDATION_POLICY, liveExecutionAuthorized: false });
});
validationRouter.post('/assess', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const input = req.body || {};
    const assessment = evaluateTradingValidation(input.evidence || input);
    const result = {
      id: randomUUID(), subjectType: String(input.subjectType || 'strategy').slice(0, 40),
      subjectId: String(input.subjectId || 'unassigned').slice(0, 120),
      strategyVersion: String(input.strategyVersion || '').slice(0, 40),
      assessment,
      gates: ['agent', 'autonomous-bot', 'paper-executor'].map(component => ({ component, ...agentExecutionGate(assessment, { requestedMode: 'paper' }) })),
      createdAt: new Date().toISOString()
    };
    await appendStoredEvent({ kind: 'trading-validation-assessment', source: 'jpti-validation-control-plane',
      eventType: 'qualification_assessed', externalId: result.id, symbol: String(input.symbol || '').slice(0, 48),
      occurredAt: result.createdAt, payload: result });
    res.set('Cache-Control', 'no-store');
    res.json({ ...result, persisted: true });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Validation assessment failed.' });
  }
});
validationRouter.get('/history', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit || '25', 10) || 25));
    const rows = await readStoredEvents(10000, 'trading-validation-assessment');
    res.set('Cache-Control', 'no-store');
    res.json({ count: rows.length, assessments: rows.slice(-limit).reverse().map(row => row.payload) });
  } catch (error) { res.status(error.status || 500).json({ error: error.message || 'Validation history unavailable.' }); }
});
