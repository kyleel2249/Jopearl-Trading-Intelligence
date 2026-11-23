import express from 'express';
import { acknowledgeOutboxMessage, appendStoredEvent, appendUniqueLedgerEvent, claimOutboxMessages, commitLedgerBatchAndCursor, getOutboxStatus, getSyncCursor, getStorageStatus, readStoredEvents, retryOutboxMessage, setSyncCursor } from './storage.js';
import { acquireSchedulerLease, getSchedulerLeaseStatus, releaseSchedulerLease, schedulerLeaseConfig } from './scheduler-lease.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withExchange, listExchangeCatalog } from './exchanges.js';
import { calculateBalanceReconciliation } from './reconciliation.js';
import { getOperationalIntervals, providerDirectory } from './providers.js';
import { requirePrivateApiAuth } from './policy.js';
import { fetchPaginatedTrades, fillSyncConfig, normalizeExchangeTrade, parseFillWatchlist } from './fill-sync.js';

export const operationsRouter = express.Router();
const jobState = new Map();
let schedulerStarted = false;
let schedulerLeader = false;
let schedulerHeartbeat = null;
const schedulerTimers = new Map();
let lastMonitorPersistAt = 0;
const startedAt = new Date().toISOString();

export const eventSchema = z.object({
  source: z.string().min(2).max(48),
  eventType: z.enum(['fill', 'deposit', 'withdrawal', 'fee', 'transfer', 'adjustment', 'funding', 'interest', 'borrow', 'rebate', 'bot_signal', 'bot_decision', 'bot_trade', 'bot_filter', 'bot_session']),
  externalId: z.string().min(3).max(128),
  accountId: z.string().min(2).max(96),
  symbol: z.string().max(48).optional(),
  side: z.enum(['buy', 'sell']).optional(),
  quantity: z.number().finite().nonnegative().optional(),
  price: z.number().finite().nonnegative().optional(),
  fee: z.number().finite().nonnegative().optional(),
  feeCurrency: z.string().max(16).optional(),
  currency: z.string().max(16).optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
});

async function readEvents(limit = 20000, kind = null) {
  return readStoredEvents(limit, kind);
}

async function persistEvent(event) {
  return appendStoredEvent(event);
}


export async function ingestLedgerEvent(input) {
  const parsed = eventSchema.parse(input);
  return persistLedgerTransaction(parsed);
}

export async function getLedgerTransactions() {
  return readStoredEvents(Number.MAX_SAFE_INTEGER, 'ledger-transaction');
}

async function persistLedgerTransaction(parsed) {
  const event = { id: randomUUID(), kind: 'ledger-transaction', ...parsed, occurredAt: parsed.occurredAt || new Date().toISOString(), ingestedAt: new Date().toISOString() };
  return appendUniqueLedgerEvent(event);
}


function job(id, intervalSeconds, status, detail, extra = {}) {
  const previous = jobState.get(id) || {};
  return {
    id, intervalSeconds, status, detail,
    lastRunAt: previous.lastRunAt || null,
    lastSuccessAt: previous.lastSuccessAt || null,
    lastError: previous.lastError || null,
    runCount: previous.runCount || 0,
    ...extra
  };
}

function setJob(id, patch) {
  jobState.set(id, { ...(jobState.get(id) || {}), ...patch });
}

async function marketMonitor() {
  const watchlist = String(process.env.JPTI_MONITOR_MARKETS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!watchlist.length) {
    setJob('market-monitor', { lastRunAt: new Date().toISOString(), runCount: (jobState.get('market-monitor')?.runCount || 0) + 1, status: 'waiting-for-watchlist', detail: 'Set JPTI_MONITOR_MARKETS=binance:BTC/USDT,bitget:ETH/USDT to enable real ticker monitoring.' });
    return;
  }
  const snapshots = await Promise.allSettled(watchlist.slice(0, 30).map(async (entry) => {
    const split = entry.indexOf(':');
    if (split < 1) throw new Error('Invalid watchlist item: ' + entry);
    const exchangeId = entry.slice(0, split).toLowerCase();
    const symbol = entry.slice(split + 1).toUpperCase();
    const ticker = await withExchange(exchangeId, { privateAccess: false }, async (exchange) => {
      if (!exchange.markets[symbol]) throw new Error('Unknown market ' + symbol + ' on ' + exchangeId);
      if (!exchange.has?.fetchTicker) throw new Error('Ticker unavailable on ' + exchangeId);
      return exchange.fetchTicker(symbol);
    });
    return { exchange: exchangeId, symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask, percentage: ticker.percentage, quoteVolume: ticker.quoteVolume, timestamp: ticker.timestamp };
  }));
  const successes = snapshots.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const failures = snapshots.filter((x) => x.status === 'rejected').map((x) => x.reason?.message || 'Market monitor error');
  const persistEveryMs = Math.max(10, Number(process.env.JPTI_MONITOR_PERSIST_INTERVAL_SECONDS || 60)) * 1000;
  if (successes.length && Date.now() - lastMonitorPersistAt >= persistEveryMs) {
    await persistEvent({ id: randomUUID(), kind: 'market-monitor-snapshot', occurredAt: new Date().toISOString(), markets: successes });
    lastMonitorPersistAt = Date.now();
  }
  setJob('market-monitor', {
    lastRunAt: new Date().toISOString(), lastSuccessAt: successes.length ? new Date().toISOString() : (jobState.get('market-monitor')?.lastSuccessAt || null),
    runCount: (jobState.get('market-monitor')?.runCount || 0) + 1,
    status: failures.length ? (successes.length ? 'partial' : 'degraded') : 'live',
    detail: successes.length + ' live ticker(s) sampled; ' + failures.length + ' failed.',
    lastError: failures.length ? failures.join('; ').slice(0, 500) : null,
    lastSnapshot: successes
  });
}

async function syncFillMarket({ exchangeId, symbol, since, until = Date.now(), cursorKey, pageSize, maxPages, overlapMs = 0 }) {
  const startAt = Math.max(0, Number(since) - overlapMs);
  const result = await withExchange(exchangeId, { privateAccess: true }, async ex => {
    if (!ex.has?.fetchMyTrades) throw new Error('fetchMyTrades unavailable on ' + exchangeId);
    if (!ex.markets[symbol]) throw new Error('Unknown fill-watchlist market ' + symbol);
    return fetchPaginatedTrades({ since: startAt, until, pageSize, maxPages,
      fetchPage: (pageSince, limit) => ex.fetchMyTrades(symbol, pageSince, limit),
      onProgress: progress => setJob('fill-ingestion', { status:'syncing', detail:exchangeId+' '+symbol+': page '+progress.pages+'/'+maxPages+', '+progress.uniqueTrades+' unique trade(s) fetched.', progress:{exchange:exchangeId,symbol,...progress} })
    });
  });
  const ledgerEvents = result.trades.map(trade => normalizeExchangeTrade(exchangeId, trade, eventSchema, randomUUID)).filter(Boolean);
  const nextCursor = Math.max(startAt, result.newestTimestamp) + 1;
  const commit = await commitLedgerBatchAndCursor(ledgerEvents, cursorKey, nextCursor);
  return { exchange:exchangeId, symbol, requestedSince:startAt, requestedUntil:until, pages:result.pages, fetched:result.rawFetched, uniqueTrades:result.uniqueTrades, normalized:ledgerEvents.length, ingested:commit.inserted, duplicates:commit.duplicates, invalidOrUnsupported:result.uniqueTrades-ledgerEvents.length, pageLimitReached:result.pageLimitReached, exhausted:result.exhausted, nextCursor, outboxEnqueued:commit.outboxEnqueued, transactional:commit.transactional };
}

async function exchangeFillMonitor() {
  const config = fillSyncConfig();
  let watchlist;
  try { watchlist = parseFillWatchlist(process.env.JPTI_FILL_SYNC_MARKETS || ''); }
  catch (error) { setJob('fill-ingestion',{lastRunAt:new Date().toISOString(),runCount:(jobState.get('fill-ingestion')?.runCount||0)+1,status:'configuration-error',detail:error.message,lastError:error.message}); return; }
  if (!watchlist.length) { setJob('fill-ingestion',{lastRunAt:new Date().toISOString(),runCount:(jobState.get('fill-ingestion')?.runCount||0)+1,status:'waiting-for-watchlist',detail:'Set JPTI_FILL_SYNC_MARKETS=binance:BTC/USDT,bitget:ETH/USDT to enable private fill-history polling.'}); return; }
  const outcomes = await Promise.allSettled(watchlist.map(async ({exchange,symbol}) => {
    const cursorKey=exchange+':'+symbol;
    const since=await getSyncCursor(cursorKey,Date.now()-config.lookbackDays*86_400_000);
    return syncFillMarket({exchangeId:exchange,symbol,since,cursorKey,until:Date.now(),pageSize:config.pageSize,maxPages:config.maxPages,overlapMs:config.overlapMs});
  }));
  const success=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value);
  const errors=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason?.message||'Fill sync failed');
  const fetched=success.reduce((n,x)=>n+x.fetched,0), ingested=success.reduce((n,x)=>n+x.ingested,0), capped=success.filter(x=>x.pageLimitReached).length;
  const snapshot={generatedAt:new Date().toISOString(),markets:success,errors,fetched,ingested,cappedMarkets:capped};
  await persistEvent({id:randomUUID(),kind:'fill-sync-run',...snapshot});
  setJob('fill-ingestion',{lastRunAt:new Date().toISOString(),lastSuccessAt:success.length?new Date().toISOString():(jobState.get('fill-ingestion')?.lastSuccessAt||null),runCount:(jobState.get('fill-ingestion')?.runCount||0)+1,status:errors.length?(success.length?'partial':'degraded'):capped?'backfill-incomplete':'live',detail:ingested+' new fill(s) ingested from '+fetched+' fetched trade(s) across '+success.length+' market(s); '+capped+' market(s) reached the page cap; '+errors.length+' errors.',lastError:errors.length?errors.join('; ').slice(0,500):null,lastSnapshot:snapshot,progress:null});
}
function configuredOpeningBalances(exchangeId) {
  try {
    const parsed = JSON.parse(process.env.JPTI_RECONCILE_OPENING_BALANCES_JSON || '{}');
    return parsed?.[exchangeId] && typeof parsed[exchangeId] === 'object' ? parsed[exchangeId] : {};
  } catch { return {}; }
}

async function performBalanceReconciliation() {
  const requested = String(process.env.JPTI_RECONCILE_EXCHANGES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const configured = listExchangeCatalog().filter(item => item.configured).map(item => item.id);
  const exchangeIds = (requested.length ? requested : configured).filter((id, index, all) => all.indexOf(id) === index).slice(0, 10);
  if (!exchangeIds.length) {
    setJob('reconciliation', { lastRunAt:new Date().toISOString(), runCount:(jobState.get('reconciliation')?.runCount || 0) + 1,
      status:'waiting-for-credentials', detail:'Configure read-only exchange credentials and JPTI_RECONCILE_OPENING_BALANCES_JSON to run account balance reconciliation.' });
    return { generatedAt:new Date().toISOString(), accountsChecked:0, status:'waiting-for-credentials', snapshots:[], errors:['No configured exchange credentials or reconciliation exchanges.'] };
  }
  const events = await getLedgerTransactions();
  const outcomes = await Promise.allSettled(exchangeIds.map(async exchangeId => {
    const balance = await withExchange(exchangeId, {privateAccess:true}, async ex => {
      if (!ex.has?.fetchBalance) throw new Error('Balance endpoint unavailable on ' + exchangeId);
      return ex.fetchBalance();
    });
    const reconciliation = calculateBalanceReconciliation({ events:events.filter(e => e.source === exchangeId || e.accountId === exchangeId), balances:balance, openingBalances:configuredOpeningBalances(exchangeId) });
    const snapshot = { kind:'balance-reconciliation-snapshot', id:randomUUID(), exchange:exchangeId, occurredAt:new Date().toISOString(), ...reconciliation };
    await persistEvent(snapshot);
    return snapshot;
  }));
  const success = outcomes.filter(x => x.status === 'fulfilled').map(x => x.value);
  const errors = outcomes.filter(x => x.status === 'rejected').map(x => x.reason?.message || 'Balance reconciliation failed');
  const mismatch = success.filter(x => x.status === 'mismatch').length;
  const baseline = success.filter(x => x.status === 'baseline_required').length;
  const status = errors.length ? (success.length ? 'partial' : 'degraded') : mismatch ? 'mismatch' : baseline ? 'baseline-required' : 'matched';
  setJob('reconciliation', { lastRunAt:new Date().toISOString(), lastSuccessAt:success.length ? new Date().toISOString() : (jobState.get('reconciliation')?.lastSuccessAt || null),
    runCount:(jobState.get('reconciliation')?.runCount || 0) + 1, status,
    detail:success.length + ' account(s) checked; ' + mismatch + ' mismatch(es); ' + baseline + ' require opening baselines; ' + errors.length + ' failed.',
    lastError:errors.length ? errors.join('; ').slice(0,500) : null, lastSnapshot:success });
  return { generatedAt:new Date().toISOString(), accountsChecked:success.length, status, snapshots:success, errors };
}

let reconciliationInFlight = null;
async function balanceReconciliationMonitor() {
  if (reconciliationInFlight) return reconciliationInFlight;
  reconciliationInFlight = performBalanceReconciliation();
  try { return await reconciliationInFlight; }
  finally { reconciliationInFlight = null; }
}

async function providerMonitor() {
  const providers = providerDirectory();
  const configured = providers.filter((p) => p.configured).length;
  setJob('provider-health', { lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), runCount: (jobState.get('provider-health')?.runCount || 0) + 1, status: 'registry-checked', detail: configured + '/' + providers.length + ' providers have credentials or public access configured. This is not an authenticated connectivity test.' });
}

async function blockedTask(id, message) {
  setJob(id, { lastRunAt: new Date().toISOString(), runCount: (jobState.get(id)?.runCount || 0) + 1, status: 'waiting-for-prerequisites', detail: message });
}

function runSafely(id, task) {
  const current = jobState.get(id) || {};
  if (current.running) return;
  setJob(id, { running: true });
  Promise.resolve().then(task).catch((error) => {
    setJob(id, { lastRunAt: new Date().toISOString(), status: 'error', lastError: error.message, detail: error.message });
  }).finally(() => setJob(id, { running: false }));
}

function stopScheduledJobs() {
  for (const timer of schedulerTimers.values()) clearInterval(timer);
  schedulerTimers.clear();
  schedulerStarted = false;
  schedulerLeader = false;
}

function startScheduledJobs() {
  if (schedulerStarted || process.env.JPTI_SCHEDULER_ENABLED === 'false') return;
  schedulerStarted = true;
  const intervals = getOperationalIntervals();
  const jobs = [
    ['market-monitor', intervals.marketMonitorSeconds, marketMonitor],
    ['fill-ingestion', intervals.reconcileSeconds, exchangeFillMonitor],
    ['provider-health', intervals.providerHealthSeconds, providerMonitor],
    ['reconciliation', intervals.reconcileSeconds, balanceReconciliationMonitor],
    ['investor-monitor', intervals.investorMonitorSeconds, () => blockedTask('investor-monitor', 'Waiting for configured investor/watchlists and licensed holdings or disclosure feeds.')],
    ['market-maker', intervals.marketMakerIntervalSeconds, () => blockedTask('market-maker', 'Market-making is intentionally disabled. No quoting or order-placement worker is active.')],
    ['news-monitor', intervals.newsRefreshSeconds, () => blockedTask('news-monitor', 'News polling is not yet scheduled as a durable ingestion worker; provider search endpoints remain available.')],
    ['onchain-monitor', intervals.onchainRefreshSeconds, () => blockedTask('onchain-monitor', 'On-chain polling requires configured wallet watchlists and indexed event subscriptions. Address lookups remain on-demand.')]
  ];
  for (const [id, seconds, task] of jobs) {
    setJob(id, { intervalSeconds: seconds, status: 'starting', detail: 'Scheduler leader registered this worker.' });
    runSafely(id, task);
    const timer = setInterval(() => runSafely(id, task), seconds * 1000);
    timer.unref?.();
    schedulerTimers.set(id, timer);
  }
}

async function refreshSchedulerLeadership() {
  try {
    const acquired = await acquireSchedulerLease();
    if (acquired && !schedulerLeader) { schedulerLeader = true; startScheduledJobs(); }
    else if (!acquired && schedulerLeader) stopScheduledJobs();
    if (!acquired) {
      for (const id of ['market-monitor','fill-ingestion','provider-health','reconciliation','investor-monitor','market-maker','news-monitor','onchain-monitor']) {
        if (!jobState.get(id)?.running) setJob(id, { status: 'standby', detail: 'Another JPTI instance currently owns the scheduler lease.' });
      }
    }
  } catch (error) {
    stopScheduledJobs();
    for (const id of ['market-monitor','fill-ingestion','provider-health','reconciliation','investor-monitor','market-maker','news-monitor','onchain-monitor']) {
      setJob(id, { status: 'coordination-error', lastError: error.message, detail: 'Scheduler paused because its leadership lease could not be verified.' });
    }
  }
}

export async function startOperationsScheduler() {
  if (schedulerHeartbeat || process.env.JPTI_SCHEDULER_ENABLED === 'false') return;
  const { heartbeatMs } = schedulerLeaseConfig();
  await refreshSchedulerLeadership();
  schedulerHeartbeat = setInterval(refreshSchedulerLeadership, heartbeatMs);
  schedulerHeartbeat.unref?.();
}

export async function stopOperationsScheduler() {
  if (schedulerHeartbeat) clearInterval(schedulerHeartbeat);
  schedulerHeartbeat = null;
  stopScheduledJobs();
  try { await releaseSchedulerLease(); } catch (error) { console.error('JPTI scheduler lease release failed:', error.message); }
}
export function getOperationsSnapshot() {
  const intervals = getOperationalIntervals();
  const definitions = [
    ['market-monitor', intervals.marketMonitorSeconds, 'Market monitoring'],
    ['fill-ingestion', intervals.reconcileSeconds, 'Exchange fill ingestion'],
    ['provider-health', intervals.providerHealthSeconds, 'Provider registry health'],
    ['reconciliation', intervals.reconcileSeconds, 'Portfolio reconciliation'],
    ['investor-monitor', intervals.investorMonitorSeconds, 'Investor monitoring'],
    ['market-maker', intervals.marketMakerIntervalSeconds, 'Market-making'],
    ['news-monitor', intervals.newsRefreshSeconds, 'News ingestion'],
    ['onchain-monitor', intervals.onchainRefreshSeconds, 'On-chain monitoring']
  ];
  return {
    generatedAt: new Date().toISOString(),
    storage: getStorageStatus(),
    scheduler: { ...getSchedulerLeaseStatus(), leader: schedulerLeader, running: schedulerStarted },
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    schedulerEnabled: intervals.schedulerEnabled,
    jobs: definitions.map(([id, seconds, label]) => job(id, seconds, jobState.get(id)?.status || 'not-started', jobState.get(id)?.detail || 'Scheduler has not started.', { label, ...(jobState.get(id) || {}) }))
  };
}

operationsRouter.get('/operations/outbox/status', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  try { res.json(await getOutboxStatus()); } catch (error) { res.status(503).json({ error: error.message }); }
});

operationsRouter.post('/operations/outbox/claim', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  try {
    const workerId = String(req.body?.workerId || '').trim();
    const messages = await claimOutboxMessages({ workerId, limit: req.body?.limit, leaseMs: req.body?.leaseMs });
    res.json({ count: messages.length, messages });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

operationsRouter.post('/operations/outbox/:id/ack', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  try {
    const acknowledged = await acknowledgeOutboxMessage({ id: req.params.id, workerId: String(req.body?.workerId || '') });
    res.status(acknowledged ? 200 : 409).json({ acknowledged });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

operationsRouter.post('/operations/outbox/:id/retry', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  try {
    const retried = await retryOutboxMessage({ id: req.params.id, workerId: String(req.body?.workerId || ''),
      error: req.body?.error, delayMs: req.body?.delayMs });
    res.status(retried ? 200 : 409).json({ retried });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

operationsRouter.get('/operations/overview', (_req, res) => res.json(getOperationsSnapshot()));
operationsRouter.get('/operations/events', async (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit || '100', 10) || 100));
    const events = (await readEvents(limit * 2)).filter((event) => event.kind !== 'ledger-transaction' && event.kind !== 'balance-reconciliation-snapshot').slice(-limit);
    res.json({ count: events.length, events: events.reverse() });
  } catch (error) { next(error); }
});
operationsRouter.get('/operations/ledger/summary', async (_req, res, next) => {
  try {
    const transactions = await readEvents(Number.MAX_SAFE_INTEGER, 'ledger-transaction');
    const byType = Object.fromEntries(['fill','deposit','withdrawal','fee','transfer','adjustment','funding','interest','borrow','rebate'].map((type) => [type, transactions.filter((e) => e.eventType === type).length]));
    res.json({ eventCount: transactions.length, byType, lastEventAt: transactions.at(-1)?.occurredAt || null, note: 'This is an append-only transaction event count, not a reconciled balance or realized PnL statement.' });
  } catch (error) { next(error); }
});


const fillBackfillSchema = z.object({
  since: z.union([z.string().datetime(), z.number().finite()]),
  until: z.union([z.string().datetime(), z.number().finite()]).optional(),
  markets: z.array(z.string().min(3).max(96)).max(20).optional(),
  pageSize: z.number().int().min(10).max(1000).optional(),
  maxPages: z.number().int().min(1).max(100).optional()
});

operationsRouter.post('/operations/fills/backfill', async (req,res) => {
  try { requirePrivateApiAuth(req); } catch(error) { return res.status(error.status||401).json({error:error.message}); }
  const parsed=fillBackfillSchema.safeParse(req.body||{});
  if(!parsed.success) return res.status(400).json({error:'Invalid backfill request.',details:parsed.error.flatten()});
  try {
    const config=fillSyncConfig();
    const since=typeof parsed.data.since==='number'?parsed.data.since:Date.parse(parsed.data.since);
    const until=parsed.data.until==null?Date.now():(typeof parsed.data.until==='number'?parsed.data.until:Date.parse(parsed.data.until));
    if(!Number.isFinite(since)||!Number.isFinite(until)||until<=since) return res.status(400).json({error:'Backfill until must be later than since.'});
    if(until-since>3650*86_400_000) return res.status(400).json({error:'A single backfill request cannot exceed 10 years.'});
    const configured=parseFillWatchlist(process.env.JPTI_FILL_SYNC_MARKETS||'');
    const selected=parsed.data.markets?.length?parsed.data.markets.map(value=>{const split=value.indexOf(':');if(split<1||split===value.length-1)throw new Error('Invalid market: '+value);return {exchange:value.slice(0,split).toLowerCase(),symbol:value.slice(split+1).toUpperCase()};}):configured;
    if(!selected.length) return res.status(409).json({error:'Configure JPTI_FILL_SYNC_MARKETS or supply markets in the request.'});
    const outcomes=await Promise.allSettled(selected.map(({exchange,symbol})=>syncFillMarket({exchangeId:exchange,symbol,since,until,cursorKey:'backfill:'+exchange+':'+symbol+':'+since,pageSize:parsed.data.pageSize||config.pageSize,maxPages:parsed.data.maxPages||config.maxPages,overlapMs:config.overlapMs})));
    const markets=outcomes.filter(x=>x.status==='fulfilled').map(x=>x.value), errors=outcomes.filter(x=>x.status==='rejected').map(x=>x.reason?.message||'Backfill failed');
    const summary={generatedAt:new Date().toISOString(),requestedSince:new Date(since).toISOString(),requestedUntil:new Date(until).toISOString(),markets,errors,fetched:markets.reduce((n,x)=>n+x.fetched,0),ingested:markets.reduce((n,x)=>n+x.ingested,0),duplicates:markets.reduce((n,x)=>n+x.duplicates,0),cappedMarkets:markets.filter(x=>x.pageLimitReached).length};
    await persistEvent({id:randomUUID(),kind:'fill-backfill-run',...summary});
    res.status(errors.length?207:200).set('Cache-Control','no-store').json(summary);
  } catch(error) { res.status(400).json({error:error.message||'Historical fill backfill failed.'}); }
});
operationsRouter.post('/operations/reconciliation/run', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  try {
    const result = await balanceReconciliationMonitor();
    res.status(result.accountsChecked ? 200 : 409).set('Cache-Control', 'no-store').json(result);
  } catch (error) { res.status(502).json({ error: error.message || 'Portfolio reconciliation failed.' }); }
});

operationsRouter.get('/operations/reconciliation', async (req, res, next) => {
  try {
    requirePrivateApiAuth(req);
    const snapshots = (await readEvents()).filter(event => event.kind === 'balance-reconciliation-snapshot').slice(-50).reverse();
    res.json({ count:snapshots.length, snapshots, note:'Snapshots compare exchange-reported totals with configured opening balances and supported ledger movements. baseline_missing is not a zero balance.' });
  } catch (error) { next(error); }
});
operationsRouter.get('/operations/ledger/events', async (req, res, next) => {
  try {
    requirePrivateApiAuth(req);
    const limit = Math.min(500, Math.max(1, Number.parseInt(req.query.limit || '100', 10) || 100));
    const events = (await readEvents(limit, 'ledger-transaction')).reverse();
    res.json({ count: events.length, events });
  } catch (error) { next(error); }
});

operationsRouter.post('/operations/ledger/events', async (req, res, next) => {
  try {
    requirePrivateApiAuth(req);
    const parsed = eventSchema.parse(req.body);
    const result = await persistLedgerTransaction(parsed);
    res.status(result.duplicate ? 200 : 201).json({ accepted: true, ...result });
  } catch (error) { next(error); }
});
