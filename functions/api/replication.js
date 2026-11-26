import { createDirectProvider, DIRECT_EXCHANGES } from '../../src/lib/browser-direct.js';
import {
  normalizeReplicationPlan, marketTypesForExchange, selectReplicationMarkets,
  normalizeTickerObservation, normalizeCandleObservations, replicationObservationKey,
  detectCandleGaps, buildCrossExchangeConsensus, buildReplicationSummary
} from '../../src/market-replication-engine.js';
import { verifyPrivateToken } from '../private-auth.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PARALLEL = 6;

async function readJson(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error: 'Replication request exceeds 32 KB.', status: 413 };
  try { return { value: raw.trim() ? JSON.parse(raw) : {} }; }
  catch { return { error: 'A valid JSON request body is required.', status: 400 }; }
}

async function safeProviderRequest(provider, path) {
  try { return await provider.request(path, { method: 'GET' }); }
  catch (error) { return { status: 502, body: { error: String(error?.message || error).slice(0, 220) } }; }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: String(error?.message || error).slice(0, 220) }; }
    }
  });
  await Promise.all(runners);
  return results;
}

async function saveObservations(db, observations) {
  if (!observations.length) return 0;
  let inserted = 0;
  for (let offset = 0; offset < observations.length; offset += 40) {
    const chunk = observations.slice(offset, offset + 40);
    const statements = chunk.map(observation => db.prepare(
      'INSERT OR IGNORE INTO jpti_market_observations (observation_key,exchange,market_type,symbol,observation_kind,timeframe,observed_at,received_at,payload,quality) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      replicationObservationKey(observation), observation.exchange, observation.marketType, observation.symbol,
      observation.kind, observation.timeframe || '', observation.observedAt, observation.receivedAt,
      JSON.stringify(observation), observation.quality?.stale ? 'stale' : 'valid'
    ));
    const results = await db.batch(statements);
    inserted += (results || []).reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  }
  return inserted;
}

async function getStatus(db) {
  const [latest, totals, exchanges] = await Promise.all([
    db.prepare('SELECT run_id,status,started_at,finished_at,duration_ms,counts_json,errors_json FROM jpti_market_replication_runs ORDER BY started_at DESC LIMIT 5').all(),
    db.prepare('SELECT COUNT(*) AS observations, COUNT(DISTINCT exchange) AS exchanges, COUNT(DISTINCT symbol) AS symbols, MAX(received_at) AS last_received_at FROM jpti_market_observations').first(),
    db.prepare('SELECT exchange,market_type,COUNT(*) AS observations,COUNT(DISTINCT symbol) AS symbols,MAX(received_at) AS last_received_at FROM jpti_market_observations GROUP BY exchange,market_type ORDER BY exchange,market_type').all()
  ]);
  return {
    service: 'JPTI continuous market-data replication', storage: 'Cloudflare D1',
    status: 'available', totals: totals || { observations: 0, exchanges: 0, symbols: 0 },
    coverage: exchanges?.results || [],
    recentRuns: (latest?.results || []).map(row => ({
      runId: row.run_id, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
      durationMs: row.duration_ms, counts: safeJson(row.counts_json, {}), errors: safeJson(row.errors_json, [])
    }))
  };
}

function safeJson(value, fallback) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
}

async function readHistory(db, url) {
  const exchange = String(url.searchParams.get('exchange') || '').trim().toLowerCase();
  const symbol = String(url.searchParams.get('symbol') || '').trim().toUpperCase();
  const kind = String(url.searchParams.get('kind') || 'ohlcv').trim().toLowerCase();
  const timeframe = String(url.searchParams.get('timeframe') || '1m').trim();
  const marketType = String(url.searchParams.get('marketType') || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('limit') || '200', 10) || 200));
  if (exchange && !DIRECT_EXCHANGES.includes(exchange)) return { status: 400, body: { error: 'Unsupported exchange.' } };
  if (kind !== 'ticker' && kind !== 'ohlcv') return { status: 400, body: { error: 'kind must be ticker or ohlcv.' } };
  if (symbol && !/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}(?::[A-Z0-9._-]{2,20})?$/.test(symbol)) return { status: 400, body: { error: 'Invalid market symbol.' } };
  const clauses = ['observation_kind = ?'];
  const args = [kind];
  if (exchange) { clauses.push('exchange = ?'); args.push(exchange); }
  if (symbol) { clauses.push('symbol = ?'); args.push(symbol); }
  if (timeframe && kind === 'ohlcv') { clauses.push('timeframe = ?'); args.push(timeframe); }
  if (marketType) { clauses.push('market_type = ?'); args.push(marketType); }
  args.push(limit);
  const result = await db.prepare(
    'SELECT payload FROM jpti_market_observations WHERE ' + clauses.join(' AND ') + ' ORDER BY observed_at DESC LIMIT ?'
  ).bind(...args).all();
  return { status: 200, body: { kind, exchange: exchange || null, symbol: symbol || null, timeframe: kind === 'ohlcv' ? timeframe : null, count: result?.results?.length || 0, observations: (result?.results || []).map(row => safeJson(row.payload, null)).filter(Boolean), source: 'jpti-cloudflare-d1-replication' } };
}

export function createMarketReplicationHandler({ provider = createDirectProvider(), now = () => new Date(), verifyToken = verifyPrivateToken } = {}) {
  return async function onRequest({ request, env = {} }) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-jpti-api-token, authorization' } });
    if (!env.JPTI_DB) return reply(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.', code: 'REPLICATION_STORAGE_UNAVAILABLE' });

    if (request.method === 'GET') {
      try {
        if (url.searchParams.has('kind') || url.searchParams.has('symbol') || url.searchParams.has('exchange')) {
          const result = await readHistory(env.JPTI_DB, url);
          return reply(result.status, result.body);
        }
        return reply(200, await getStatus(env.JPTI_DB));
      } catch (error) {
        return reply(503, { error: 'Replication status/history query failed.', detail: String(error?.message || error).slice(0, 180) });
      }
    }
    if (request.method !== 'POST') return reply(405, { error: 'Replication endpoint supports GET and POST.' });

    const auth = await verifyToken(request, env, { unconfigured: 'Set JPTI_API_TOKEN or JPTI_JOURNAL_TOKEN to protect replication writes.', rejected: 'Replication authorization failed.' });
    if (!auth.ok) return reply(auth.status, { error: auth.error });
    const parsed = await readJson(request);
    if (parsed.error) return reply(parsed.status, { error: parsed.error });

    let plan;
    try { plan = normalizeReplicationPlan(parsed.value, env); }
    catch (error) { return reply(error.status || 400, { error: error.message }); }

    const startedAt = now().toISOString();
    const runId = crypto.randomUUID();
    const counts = { attempted: 0, succeeded: 0, valid: 0, inserted: 0, tickers: 0, candles: 0, markets: 0 };
    const errors = [], skipped = [], observations = [];
    await env.JPTI_DB.prepare(
      'INSERT INTO jpti_market_replication_runs (run_id,status,started_at,plan_json,counts_json,errors_json) VALUES (?,\'running\',?,?,?,?)'
    ).bind(runId, startedAt, JSON.stringify(plan), JSON.stringify(counts), '[]').run();

    const tasks = [];
    for (const exchange of plan.exchanges) {
      for (const marketType of marketTypesForExchange(exchange, plan.marketTypes)) tasks.push({ exchange, marketType });
    }

    await mapLimit(tasks, 3, async ({ exchange, marketType }) => {
      counts.attempted++;
      const marketPath = '/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(marketType);
      const marketResult = await safeProviderRequest(provider, marketPath);
      if (!marketResult || marketResult.status !== 200) {
        errors.push({ exchange, marketType, stage: 'markets', error: marketResult?.body?.error || 'Market catalogue unavailable.' });
        return;
      }
      counts.succeeded++;
      const markets = selectReplicationMarkets(marketResult.body?.markets, plan.symbols, plan.limit);
      counts.markets += markets.length;
      if (!markets.length) skipped.push({ exchange, marketType, reason: 'No configured symbols are listed in this market category.' });

      await mapLimit(markets, 3, async market => {
        const symbol = String(market.symbol);
        const query = '?type=' + encodeURIComponent(marketType) + (exchange === 'bitget' && market.id ? '&instrumentId=' + encodeURIComponent(market.id) : '');
        counts.attempted++;
        const tickerResult = await safeProviderRequest(provider, '/api/exchanges/' + exchange + '/ticker/' + encodeURIComponent(symbol) + query);
        if (tickerResult?.status === 200) {
          const ticker = normalizeTickerObservation({ exchange, marketType, symbol, ticker: tickerResult.body, receivedAt: now().getTime() });
          if (ticker) { observations.push(ticker); counts.valid++; counts.tickers++; counts.succeeded++; }
          else errors.push({ exchange, marketType, symbol, stage: 'ticker-normalization', error: 'Ticker failed timestamp or positive-price validation.' });
        } else errors.push({ exchange, marketType, symbol, stage: 'ticker', error: tickerResult?.body?.error || 'Ticker unavailable.' });

        if (!plan.includeCandles) return;
        await mapLimit(plan.timeframes, 2, async timeframe => {
          counts.attempted++;
          const candlePath = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol) + '?type=' + encodeURIComponent(marketType) + '&timeframe=' + encodeURIComponent(timeframe) + '&limit=' + plan.candleLimit;
          const candleResult = await safeProviderRequest(provider, candlePath);
          if (candleResult?.status !== 200) {
            errors.push({ exchange, marketType, symbol, timeframe, stage: 'ohlcv', error: candleResult?.body?.error || 'OHLCV unavailable.' });
            return;
          }
          const rows = normalizeCandleObservations({ exchange, marketType, symbol, timeframe, candles: candleResult.body?.candles, receivedAt: now().getTime() });
          observations.push(...rows); counts.valid += rows.length; counts.candles += rows.length; counts.succeeded++;
          if (!rows.length) errors.push({ exchange, marketType, symbol, timeframe, stage: 'ohlcv-validation', error: 'No candles passed OHLCV integrity validation.' });
        });
      });
    });

    try {
      counts.inserted = await saveObservations(env.JPTI_DB, observations);
    } catch (error) {
      errors.push({ stage: 'd1-write', error: String(error?.message || error).slice(0, 220) });
    }
    const finishedAt = now().toISOString();
    const summary = buildReplicationSummary({ startedAt, finishedAt, plan, counts, errors, skipped, runId });
    summary.dataQuality = { candleGaps: detectCandleGaps(observations), crossExchangeConsensus: buildCrossExchangeConsensus(observations), staleObservations: observations.filter(row => row.quality?.stale).length };
    try {
      await env.JPTI_DB.prepare(
        'UPDATE jpti_market_replication_runs SET status=?,finished_at=?,duration_ms=?,counts_json=?,errors_json=? WHERE run_id=?'
      ).bind(summary.status, finishedAt, summary.durationMs, JSON.stringify(summary.counts), JSON.stringify(summary.errors), runId).run();
      await env.JPTI_DB.prepare(
        'INSERT INTO jpti_market_replication_cursors (cursor_key,cursor_value,updated_at) VALUES (?,?,?) ON CONFLICT(cursor_key) DO UPDATE SET cursor_value=excluded.cursor_value,updated_at=excluded.updated_at'
      ).bind('last-successful-run', runId, finishedAt).run();
    } catch (error) {
      return reply(503, { error: 'Market observations were collected but replication run metadata could not be finalized.', runId, detail: String(error?.message || error).slice(0, 180), summary });
    }
    return reply(summary.status === 'failed' ? 502 : 200, { ...summary, storage: 'cloudflare-d1', immutableObservations: true, liveExecutionAuthorized: false });
  };
}

const handler = createMarketReplicationHandler();
export async function onRequest(context) { return handler(context); }
