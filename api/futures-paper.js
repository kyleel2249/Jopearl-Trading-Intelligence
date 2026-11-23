import express from 'express';
import { randomUUID } from 'node:crypto';
import { appendStoredEvent, readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { buildSafetySnapshot } from './institutional-governance.js';

export const futuresPaperRouter = express.Router();
const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => { const n = finite(value); return n !== null && n > 0 ? n : null; };
const MAX_EVENTS = Number.MAX_SAFE_INTEGER;

function badRequest(message) { throw Object.assign(new Error(message), { status: 400 }); }

export function normalizePaperPositionInput(input = {}) {
  const symbol = String(input.symbol || '').trim().toUpperCase();
  const quantityBase = positive(input.quantityBase);
  const feeBps = finite(input.feeBps ?? 6);
  if (!/^[A-Z0-9._-]{1,20}\/[A-Z0-9._-]{1,20}$/.test(symbol.split(':')[0])) badRequest('Use a normalized BASE/QUOTE symbol.');
  if (!quantityBase || quantityBase > 1000000) badRequest('quantityBase must be positive and no greater than 1,000,000.');
  if (feeBps === null || feeBps < 0 || feeBps > 100) badRequest('feeBps must be between 0 and 100.');
  const legs = ['buy', 'sell'].map(side => {
    const source = input[side];
    if (!source || typeof source !== 'object') badRequest('Both buy and sell venue legs are required.');
    const exchange = String(source.exchange || '').trim().toLowerCase();
    const venueSymbol = String(source.symbol || symbol).trim().toUpperCase();
    const contract = source.contract || {};
    const entryPrice = positive(source.entryPrice);
    const contractSize = positive(contract.contractSize);
    if (!/^[a-z0-9_-]{2,32}$/.test(exchange)) badRequest('Each leg requires a valid exchange ID.');
    if (!entryPrice) badRequest('Each leg requires a positive entryPrice.');
    if (contract.linear !== true || contract.inverse === true) badRequest('The paper lifecycle currently accepts linear contracts only; inverse contracts are rejected until inverse PnL and margin models are validated.');
    if (!contractSize) badRequest('Each leg requires the exchange-reported positive contractSize.');
    return { side, exchange, symbol: venueSymbol, base: String(contract.base || symbol.split('/')[0]).toUpperCase(),
      quote: String(contract.quote || symbol.split('/')[1].split(':')[0]).toUpperCase(),
      settle: String(contract.settle || '').toUpperCase(), contractSize, linear: true, inverse: false,
      entryPrice, contracts: quantityBase / contractSize, quantityBase, swap: contract.swap === true, future: contract.future === true, expiry: contract.expiry || null,
      entryFeeUsd: quantityBase * entryPrice * feeBps / 10000 };
  });
  const [buy, sell] = legs;
  if (buy.exchange === sell.exchange) badRequest('Buy and sell legs must use different exchanges.');
  if (buy.swap !== sell.swap || buy.future !== sell.future || (buy.swap === buy.future)) badRequest('Both legs must use the same perpetual or dated contract type.');
  if (buy.future && (!buy.expiry || buy.expiry !== sell.expiry)) badRequest('Dated futures legs must have the same verified expiry.');
  for (const field of ['base', 'quote', 'settle']) if (!buy[field] || buy[field] !== sell[field]) badRequest('Both legs must match on base, quote and settlement currency.');
  if (buy.quote !== 'USDT' || buy.settle !== 'USDT') badRequest('The first paper PnL model is restricted to USDT-quoted, USDT-settled linear contracts.');
  if (buy.symbol.split(':')[0] !== sell.symbol.split(':')[0]) badRequest('Both legs must reference the same BASE/QUOTE instrument.');
  const maxNotional = positive(process.env.JPTI_FUTURES_PAPER_MAX_NOTIONAL_USD) || 1000;
  for (const leg of legs) {
    if (leg.quantityBase * leg.entryPrice > maxNotional) badRequest('A paper leg exceeds the configured per-leg notional cap of ' + maxNotional + ' USD.');
  }
  return { symbol, quantityBase, feeBps, legs, maxNotional };
}

export function calculatePaperPosition(position, prices = {}) {
  const legs = position.legs.map(leg => {
    const markPrice = positive(prices[leg.side]) || positive(leg.markPrice) || leg.entryPrice;
    const gross = leg.side === 'buy'
      ? (markPrice - leg.entryPrice) * leg.quantityBase
      : (leg.entryPrice - markPrice) * leg.quantityBase;
    const estimatedExitFeeUsd = markPrice * leg.quantityBase * position.feeBps / 10000;
    return { ...leg, markPrice, grossPnlUsd: gross, estimatedExitFeeUsd,
      netPnlUsd: gross - leg.entryFeeUsd - estimatedExitFeeUsd };
  });
  const grossPnlUsd = legs.reduce((sum, leg) => sum + leg.grossPnlUsd, 0);
  const feesUsd = legs.reduce((sum, leg) => sum + leg.entryFeeUsd + leg.estimatedExitFeeUsd, 0);
  return { legs, grossPnlUsd, estimatedFeesUsd: feesUsd, netPnlUsd: grossPnlUsd - feesUsd,
    fundingPnlUsd: null, fundingIncluded: false,
    note: 'Mark-to-market estimate for linear contracts. Includes estimated entry and exit taker fees; excludes funding, slippage, market impact and liquidation costs.' };
}

export function foldPaperEvents(events = []) {
  const positions = new Map();
  for (const event of events) {
    const payload = event.payload || {};
    if (!event.positionId) continue;
    if (event.eventType === 'position_opened') positions.set(event.positionId, { ...payload, status: 'open', createdAt: event.occurredAt, updatedAt: event.occurredAt });
    else if (event.eventType === 'position_marked' && positions.has(event.positionId) && positions.get(event.positionId).status === 'open') {
      const current = positions.get(event.positionId);
      positions.set(event.positionId, { ...current, marks: payload.marks, lastMark: payload.calculation, updatedAt: event.occurredAt });
    } else if (event.eventType === 'position_closed' && positions.has(event.positionId)) {
      positions.set(event.positionId, { ...positions.get(event.positionId), status: 'closed', close: payload, updatedAt: event.occurredAt });
    }
  }
  return [...positions.values()].sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function allEvents() { return readStoredEvents(MAX_EVENTS); }
async function paperEvents() { return (await allEvents()).filter(event => event.kind === 'futures-paper-event'); }
function authorize(req) { requirePrivateApiAuth(req); }
function sendError(res, error) { return res.status(error.status || 500).json({ error: error.message || 'Futures paper operation failed.' }); }

futuresPaperRouter.get('/paper/positions', async (req, res) => {
  try {
    authorize(req);
    const positions = foldPaperEvents(await paperEvents());
    res.json({ generatedAt: new Date().toISOString(), mode: 'paper-only', count: positions.length,
      openCount: positions.filter(p => p.status === 'open').length, positions });
  } catch (error) { sendError(res, error); }
});

futuresPaperRouter.post('/paper/positions', async (req, res) => {
  try {
    authorize(req);
    const all = await allEvents();
    const safety = buildSafetySnapshot(all);
    if (!safety.newEntriesAllowed) return res.status(423).json({ error: 'The JPTI paper-entry kill switch is engaged.', safety });
    const normalized = normalizePaperPositionInput(req.body);
    const current = foldPaperEvents(all.filter(event => event.kind === 'futures-paper-event'));
    const clientRequestId = String(req.body?.clientRequestId || '').trim();
    if (clientRequestId) {
      const existing = current.find(p => p.clientRequestId === clientRequestId);
      if (existing) return res.status(200).json({ position: existing, duplicate: true, mode: 'paper-only' });
    }
    const positionId = randomUUID(), occurredAt = new Date().toISOString();
    const position = { id: positionId, clientRequestId: clientRequestId || null, symbol: normalized.symbol,
      quantityBase: normalized.quantityBase, feeBps: normalized.feeBps, kind: normalized.legs[0].swap ? 'perpetual' : 'dated', expiry: normalized.legs[0].expiry, legs: normalized.legs,
      maxNotionalPerLegUsd: normalized.maxNotional, fundingIncluded: false };
    await appendStoredEvent({ kind: 'futures-paper-event', source: 'jpti-futures-paper', eventType: 'position_opened',
      positionId, occurredAt, payload: position });
    res.status(201).json({ position: { ...position, status: 'open', createdAt: occurredAt }, duplicate: false, mode: 'paper-only',
      note: 'Simulated paired entry only. No exchange credentials or order endpoints were used.' });
  } catch (error) { sendError(res, error); }
});

futuresPaperRouter.post('/paper/positions/:id/mark', async (req, res) => {
  try {
    authorize(req);
    const positions = foldPaperEvents(await paperEvents());
    const position = positions.find(p => p.id === req.params.id);
    if (!position) return res.status(404).json({ error: 'Paper position not found.' });
    if (position.status !== 'open') return res.status(409).json({ error: 'Only open paper positions can be marked.' });
    const buy = positive(req.body?.buyPrice), sell = positive(req.body?.sellPrice);
    if (!buy || !sell) return res.status(400).json({ error: 'Positive buyPrice and sellPrice marks are required.' });
    const calculation = calculatePaperPosition(position, { buy, sell });
    const occurredAt = new Date().toISOString();
    await appendStoredEvent({ kind: 'futures-paper-event', source: 'jpti-futures-paper', eventType: 'position_marked',
      positionId: position.id, occurredAt, payload: { marks: { buy, sell }, calculation } });
    res.json({ positionId: position.id, status: 'open', calculation, mode: 'paper-only' });
  } catch (error) { sendError(res, error); }
});

futuresPaperRouter.post('/paper/positions/:id/close', async (req, res) => {
  try {
    authorize(req);
    const positions = foldPaperEvents(await paperEvents());
    const position = positions.find(p => p.id === req.params.id);
    if (!position) return res.status(404).json({ error: 'Paper position not found.' });
    if (position.status !== 'open') return res.status(409).json({ error: 'Paper position is already closed.' });
    const buy = positive(req.body?.buyPrice), sell = positive(req.body?.sellPrice);
    if (!buy || !sell) return res.status(400).json({ error: 'Positive buyPrice and sellPrice exit prices are required for both legs.' });
    const calculation = calculatePaperPosition(position, { buy, sell });
    const occurredAt = new Date().toISOString();
    const close = { exitPrices: { buy, sell }, calculation, closedAt: occurredAt, reason: String(req.body?.reason || 'manual-paper-close').slice(0, 160) };
    await appendStoredEvent({ kind: 'futures-paper-event', source: 'jpti-futures-paper', eventType: 'position_closed',
      positionId: position.id, occurredAt, payload: close });
    res.json({ positionId: position.id, status: 'closed', close, mode: 'paper-only' });
  } catch (error) { sendError(res, error); }
});
