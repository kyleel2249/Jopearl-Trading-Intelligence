import express from 'express';
import { withExchange } from './exchanges.js';
import { requirePrivateApiAuth } from './policy.js';
import { getLedgerTransactions, ingestLedgerEvent } from './operations.js';
import { normalizeDexPair, scoreAssetEvidence, summarizeBotMemory } from './multi-asset-intelligence.js';

export const tbotsRouter = express.Router();
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function scoreSharedMarketContext({ momentumPct = null, imbalance = null, fundingRate = null } = {}) {
  let riskScore = 50;
  if (finite(momentumPct) !== null) riskScore += Math.max(-25, Math.min(25, Number(momentumPct) * 3));
  if (finite(imbalance) !== null) riskScore += Number(imbalance) * 15;
  if (finite(fundingRate) !== null) riskScore -= Math.max(-10, Math.min(10, Number(fundingRate) * 10000));
  riskScore = Math.max(0, Math.min(100, riskScore));
  return { riskScore, regime: riskScore < 35 ? 'risk_off' : riskScore > 65 ? 'risk_on' : 'neutral' };
}

tbotsRouter.get('/integrations/tbots/status', (_req, res) => res.json({
  integration: 'T-Bots',
  sourceRepository: 'https://github.com/kyleel2249/T-Bots',
  runtime: 'embedded-paper-engine',
  executionMode: 'paper-only',
  sharedMemory: 'JPTI append-only transaction/event ledger',
  liveWalletExecution: false,
  note: 'Live discovery spans DexScreener-supported chains; chain-specific security coverage is provider-dependent and the executor remains simulated.'
}));

tbotsRouter.get('/integrations/tbots/memory', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const events = (await getLedgerTransactions())
      .filter(event => event.source === 'tbots' && String(event.eventType).startsWith('bot_'))
      .slice(-limit).reverse();
    res.set('Cache-Control', 'no-store');
    res.json({ count: events.length, events });
  } catch (error) { res.status(error.status || 401).json({ error: error.message }); }
});

tbotsRouter.post('/integrations/tbots/events', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const body = req.body || {};
    const allowed = new Set(['bot_signal', 'bot_decision', 'bot_trade', 'bot_filter', 'bot_session']);
    if (!allowed.has(body.eventType)) return res.status(400).json({ error: 'Unsupported T-Bots event type.' });
    const externalId = String(body.externalId || '').trim();
    if (externalId.length < 3 || externalId.length > 128) return res.status(400).json({ error: 'A stable externalId (3-128 chars) is required.' });
    const metadata = {};
    for (const [key, value] of Object.entries(body.metadata || {}).slice(0, 24)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) metadata[String(key).slice(0, 48)] = value;
    }
    const result = await ingestLedgerEvent({
      source: 'tbots', eventType: body.eventType, externalId, accountId: 'tbots-paper',
      symbol: String(body.symbol || 'SOLANA-DEX').slice(0, 48),
      quantity: Math.max(0, finite(body.quantity) || 0),
      currency: 'USD',
      occurredAt: body.occurredAt && !Number.isNaN(Date.parse(body.occurredAt)) ? new Date(body.occurredAt).toISOString() : new Date().toISOString(),
      metadata: { ...metadata, runId: String(body.runId || '').slice(0, 96), executionMode: 'paper' }
    });
    res.status(result.duplicate ? 200 : 201).json({ stored: true, duplicate: result.duplicate, id: result.event.id });
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});

tbotsRouter.get('/integrations/tbots/context', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const exchangeId = String(req.query.exchange || 'binance').toLowerCase();
    const symbol = String(req.query.symbol || 'BTC/USDT').toUpperCase();
    if (!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(symbol)) return res.status(400).json({ error: 'Use BASE/QUOTE symbol format.' });
    const context = await withExchange(exchangeId, { privateAccess: false }, async exchange => {
      if (!exchange.markets[symbol]) throw Object.assign(new Error('Market unavailable on selected JPTI venue.'), { status: 404 });
      const [ticker, candles, book, funding] = await Promise.all([
        exchange.has?.fetchTicker ? exchange.fetchTicker(symbol).catch(() => null) : null,
        exchange.has?.fetchOHLCV ? exchange.fetchOHLCV(symbol, '1h', undefined, 30).catch(() => null) : null,
        exchange.has?.fetchOrderBook ? exchange.fetchOrderBook(symbol, 20).catch(() => null) : null,
        exchange.has?.fetchFundingRate ? exchange.fetchFundingRate(symbol).catch(() => null) : null
      ]);
      const closes = (candles || []).map(c => finite(c[4])).filter(v => v > 0);
      const momentumPct = closes.length >= 2 ? (closes.at(-1) / closes[0] - 1) * 100 : null;
      const bidDepth = (book?.bids || []).slice(0, 10).reduce((sum, row) => sum + Number(row[0]) * Number(row[1]), 0);
      const askDepth = (book?.asks || []).slice(0, 10).reduce((sum, row) => sum + Number(row[0]) * Number(row[1]), 0);
      const imbalance = bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null;
      const fundingRate = finite(funding?.fundingRate);
      const { riskScore, regime } = scoreSharedMarketContext({ momentumPct, imbalance, fundingRate });
      return { exchange: exchangeId, symbol, fetchedAt: new Date().toISOString(),
        ticker: ticker ? { last: ticker.last, bid: ticker.bid, ask: ticker.ask, timestamp: ticker.timestamp } : null,
        momentum1hWindowPercent: momentumPct, orderBookImbalance: imbalance, fundingRate,
        riskScore, regime, observations: { candles: closes.length, orderBook: Boolean(book), funding: Boolean(funding) },
        caveat: 'A coarse BTC/selected-market regime proxy, not a token-specific valuation or trade signal. Use as an optional risk gate only.' };
    });
    res.set('Cache-Control', 'no-store');
    res.json(context);
  } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
});


const universeCache = new Map();
tbotsRouter.get('/integrations/tbots/universe', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const query = String(req.query.q || '').trim().slice(0, 80);
    if (query.length < 2) return res.status(400).json({ error: 'Provide a token, pair, or project search term (at least 2 characters).' });
    const key = query.toLowerCase();
    const cached = universeCache.get(key);
    if (cached && Date.now() - cached.at < 30000) return res.json({ ...cached.payload, cache: 'hit' });
    const response = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(query), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('DEX Screener returned HTTP ' + response.status);
    const body = await response.json();
    const pairs = (Array.isArray(body.pairs) ? body.pairs : []).slice(0, 80).map(normalizeDexPair)
      .map(asset => ({ ...asset, evidence: scoreAssetEvidence(asset) }))
      .sort((a, b) => b.evidence.score - a.evidence.score);
    const chains = [...new Set(pairs.map(pair => pair.chain))];
    const payload = { query, source: 'DexScreener public search API', fetchedAt: new Date().toISOString(),
      count: pairs.length, chains, pairs,
      coverage: 'Search-based multi-chain DEX pairs. Not a complete global token registry or exhaustive chain index.',
      safety: 'Discovery only: verify token contract, mint/freeze authorities, holder concentration, LP lock, honeypot/sell simulation and executable liquidity independently before any trade.' };
    universeCache.set(key, { at: Date.now(), payload });
    res.set('Cache-Control', 'no-store');
    res.json({ ...payload, cache: 'miss' });
  } catch (error) { res.status(502).json({ error: error.message || 'Multi-chain universe query failed.' }); }
});

tbotsRouter.get('/integrations/tbots/risk', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const events = (await getLedgerTransactions())
      .filter(event => event.source === 'tbots' && String(event.eventType).startsWith('bot_'));
    const memory = summarizeBotMemory(events);
    const recent = events.slice(-200);
    const dailyLossLimitPct = Math.max(1, Math.min(30, Number(process.env.JPTI_TBOTS_DAILY_LOSS_LIMIT_PCT || 10)));
    const peakEquity = Math.max(0, ...recent.map(e => finite(e.metadata?.equityPeak)).filter(v => v !== null));
    const latestEquity = [...recent].reverse().map(e => finite(e.metadata?.equity)).find(v => v !== null);
    const drawdownPct = peakEquity > 0 && latestEquity !== undefined ? Math.max(0, (peakEquity - latestEquity) / peakEquity * 100) : null;
    const pauseReasons = [];
    if (memory.guard === 'pause_new_entries') pauseReasons.push('three or more consecutive losing closed paper trades');
    if (drawdownPct !== null && drawdownPct >= dailyLossLimitPct) pauseReasons.push('shared equity drawdown limit exceeded');
    res.set('Cache-Control', 'no-store');
    res.json({ mode: 'paper-only', newEntriesAllowed: pauseReasons.length === 0, pauseReasons,
      memory, drawdownPct, dailyLossLimitPct,
      scope: 'T-Bots published paper events only; JPTI exchange portfolio risk is exposed separately and is not yet a fully consolidated cross-account equity figure.',
      exitsRemainEnabled: true });
  } catch (error) { res.status(error.status || 401).json({ error: error.message }); }
});
