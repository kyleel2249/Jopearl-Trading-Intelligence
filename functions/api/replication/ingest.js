import {
  REPLICATION_EXCHANGES, normalizeTickerObservation, normalizeCandleObservations, replicationObservationKey
} from '../../../src/market-replication-engine.js';
import { verifyPrivateToken } from '../../private-auth.js';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const MAX_BODY_BYTES = 128 * 1024;
const MAX_ITEMS = 80;
const MAX_CANDLES_PER_ITEM = 200;
const MARKET_TYPES = new Set(['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m']);
const SYMBOL_PATTERN = /^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}(?::[A-Z0-9._-]{2,20})?$/;
const TIMEFRAME_PATTERN = /^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|1w|1M)$/;

async function readJson(request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return { error: 'Runner replication payload exceeds 128 KB.', status: 413 };
  try { return { value: raw.trim() ? JSON.parse(raw) : {} }; }
  catch { return { error: 'A valid JSON replication payload is required.', status: 400 }; }
}

async function saveObservations(db, observations) {
  let inserted = 0;
  for (let offset = 0; offset < observations.length; offset += 40) {
    const chunk = observations.slice(offset, offset + 40);
    const statements = chunk.map(row => db.prepare(
      'INSERT OR IGNORE INTO jpti_market_observations (observation_key,exchange,market_type,symbol,observation_kind,timeframe,observed_at,received_at,payload,quality) VALUES (?,?,?,?,?,?,?,?,?,?)'
    ).bind(
      replicationObservationKey(row), row.exchange, row.marketType, row.symbol, row.kind, row.timeframe || '',
      row.observedAt, row.receivedAt, JSON.stringify(row), row.quality?.stale ? 'stale' : 'valid'
    ));
    const results = await db.batch(statements);
    inserted += (results || []).reduce((sum, result) => sum + Number(result?.meta?.changes || 0), 0);
  }
  return inserted;
}

function cleanErrors(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).map(item => ({
    exchange: String(item?.exchange || '').toLowerCase().slice(0, 24),
    marketType: String(item?.marketType || '').toLowerCase().slice(0, 24),
    symbol: String(item?.symbol || '').toUpperCase().slice(0, 48),
    timeframe: String(item?.timeframe || '').slice(0, 12),
    stage: String(item?.stage || 'runner-acquisition').slice(0, 40),
    error: String(item?.error || 'Acquisition failed.').slice(0, 220)
  }));
}

export function createRunnerReplicationIngestHandler({ now = () => new Date(), verifyToken = verifyPrivateToken } = {}) {
  return async function onRequest({ request, env = {} }) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'POST, OPTIONS', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-jpti-api-token, authorization' } });
    if (request.method !== 'POST') return reply(405, { error: 'Runner ingest supports POST only.' });
    if (!env.JPTI_DB) return reply(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.', code: 'REPLICATION_STORAGE_UNAVAILABLE' });

    const auth = await verifyToken(request, env, { unconfigured: 'Set JPTI_API_TOKEN or JPTI_JOURNAL_TOKEN to protect replication writes.', rejected: 'Replication authorization failed.' });
    if (!auth.ok) return reply(auth.status, { error: auth.error });

    const parsed = await readJson(request);
    if (parsed.error) return reply(parsed.status, { error: parsed.error });
    const input = parsed.value || {};
    if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > MAX_ITEMS) {
      return reply(400, { error: 'observations must contain between 1 and ' + MAX_ITEMS + ' bounded ticker/candle items.' });
    }

    const startedAt = now().toISOString();
    const runId = crypto.randomUUID();
    const errors = cleanErrors(input.errors);
    const observations = [];
    const counts = {
      attempted: Math.max(input.observations.length, Math.min(1000, Number(input.attempted) || input.observations.length)),
      succeeded: 0, valid: 0, inserted: 0, duplicates: 0, tickers: 0, candles: 0, markets: 0
    };
    const plan = {
      source: 'github-actions-runner',
      exchanges: [...new Set(input.observations.map(row => String(row?.exchange || '').toLowerCase()).filter(Boolean))],
      marketTypes: [...new Set(input.observations.map(row => String(row?.marketType || '').toLowerCase()).filter(Boolean))],
      symbols: [...new Set(input.observations.map(row => String(row?.symbol || '').toUpperCase()).filter(Boolean))],
      timeframes: [...new Set(input.observations.filter(row => row?.kind === 'ohlcv').map(row => String(row?.timeframe || '')))],
      includeCandles: true
    };

    try {
      await env.JPTI_DB.prepare(
        'INSERT INTO jpti_market_replication_runs (run_id,status,started_at,plan_json,counts_json,errors_json) VALUES (?,\'running\',?,?,?,?)'
      ).bind(runId, startedAt, JSON.stringify(plan), JSON.stringify(counts), JSON.stringify(errors)).run();
    } catch (error) {
      return reply(503, { error: 'Could not create runner replication run metadata.', detail: String(error?.message || error).slice(0, 180) });
    }

    for (let index = 0; index < input.observations.length; index++) {
      const item = input.observations[index] || {};
      const exchange = String(item.exchange || '').trim().toLowerCase();
      const marketType = String(item.marketType || '').trim().toLowerCase();
      const symbol = String(item.symbol || '').trim().toUpperCase();
      const sourceExchange = String(item.sourceExchange || '').trim().toLowerCase();
      const requestedExchange = String(item.requestedExchange || '').trim().toLowerCase();
      if (!REPLICATION_EXCHANGES.includes(exchange) || !MARKET_TYPES.has(marketType) || !SYMBOL_PATTERN.test(symbol)) {
        errors.push({ stage: 'ingest-validation', error: 'Unsupported exchange, market type or symbol at item ' + index + '.', exchange, marketType, symbol });
        continue;
      }
      const nestedExchange = item.kind === 'ticker' ? String(item.ticker?.exchange || '').toLowerCase() : sourceExchange;
      const nestedRequested = item.kind === 'ticker' ? String(item.ticker?.requestedExchange || '').toLowerCase() : requestedExchange;
      const nestedFailedOver = item.kind === 'ticker' && item.ticker?.failedOver === true;
      if (item.failedOver !== false || nestedFailedOver || sourceExchange !== exchange || requestedExchange !== exchange || nestedExchange !== exchange || nestedRequested !== exchange) {
        errors.push({ stage: 'source-integrity', error: 'Cross-exchange failover data cannot be stored under the requested venue.', exchange, marketType, symbol });
        continue;
      }

      if (item.kind === 'markets') {
        const market = item.market && typeof item.market === 'object' && !Array.isArray(item.market) ? item.market : {};
        const id = String(market.id || market.instrumentId || '').trim();
        const productCategory = String(market.productCategory || ({
          spot: 'SPOT', margin: 'MARGIN', 'usdt-m': 'USDT-FUTURES',
          'coin-m': 'COIN-FUTURES', 'usdc-m': 'USDC-FUTURES'
        })[marketType] || '').toUpperCase();
        const expectedCategory = ({
          spot: 'SPOT', margin: 'MARGIN', 'usdt-m': 'USDT-FUTURES',
          'coin-m': 'COIN-FUTURES', 'usdc-m': 'USDC-FUTURES'
        })[marketType];
        const observedMs = Date.parse(item.observedAt || '');
        if (!id || id.length > 100 || productCategory !== expectedCategory || market.active === false
          || !Number.isFinite(observedMs) || observedMs <= 0 || observedMs > now().getTime() + 5000
          || String(market.symbol || symbol).toUpperCase() !== symbol) {
          errors.push({ stage: 'market-validation', error: 'Instrument metadata failed identity, category, status or timestamp validation.', exchange, marketType, symbol });
          continue;
        }
        observations.push({
          exchange, marketType, symbol, kind: 'markets',
          observedAt: new Date(observedMs).toISOString(), receivedAt: now().toISOString(),
          id, base: String(market.base || symbol.split('/')[0]).slice(0, 30),
          quote: String(market.quote || symbol.split('/')[1]?.split(':')[0] || '').slice(0, 30),
          settle: market.settle == null ? null : String(market.settle).slice(0, 30),
          active: true, type: String(market.type || '').slice(0, 24),
          categories: Array.isArray(market.categories) ? market.categories.map(x => String(x).slice(0, 24)).slice(0, 8) : [marketType],
          spot: market.spot === true, margin: market.margin === true, swap: market.swap === true,
          future: market.future === true, contract: market.contract === true,
          linear: typeof market.linear === 'boolean' ? market.linear : null,
          inverse: typeof market.inverse === 'boolean' ? market.inverse : null,
          productCategory, contractType: market.contractType == null ? null : String(market.contractType).slice(0, 40),
          instrumentType: String(market.instrumentType || 'crypto').slice(0, 30),
          precision: market.precision && typeof market.precision === 'object' ? market.precision : null,
          limits: market.limits && typeof market.limits === 'object' ? market.limits : null,
          quality: { timestamped: true, exactVenue: true, activeInstrument: true, stale: false }
        });
        counts.succeeded++;
        counts.markets++;
        counts.valid++;
        continue;
      }

      if (item.kind === 'ticker') {
        const row = normalizeTickerObservation({ exchange, marketType, symbol, ticker: item.ticker, receivedAt: now().getTime() });
        if (!row) {
          errors.push({ stage: 'ticker-validation', error: 'Ticker failed timestamp or positive-price validation.', exchange, marketType, symbol });
          continue;
        }
        observations.push(row);
        counts.succeeded++;
        counts.tickers++;
        counts.valid++;
        continue;
      }

      if (item.kind === 'ohlcv') {
        const timeframe = String(item.timeframe || '').trim();
        if (!TIMEFRAME_PATTERN.test(timeframe) || !Array.isArray(item.candles) || item.candles.length > MAX_CANDLES_PER_ITEM) {
          errors.push({ stage: 'ohlcv-validation', error: 'Invalid timeframe or candle batch size.', exchange, marketType, symbol, timeframe });
          continue;
        }
        const rows = normalizeCandleObservations({ exchange, marketType, symbol, timeframe, candles: item.candles, receivedAt: now().getTime() });
        if (!rows.length) {
          errors.push({ stage: 'ohlcv-validation', error: 'No candles passed OHLCV integrity validation.', exchange, marketType, symbol, timeframe });
          continue;
        }
        observations.push(...rows);
        counts.succeeded++;
        counts.candles += rows.length;
        counts.valid += rows.length;
        continue;
      }

      errors.push({ stage: 'ingest-validation', error: 'Unsupported observation kind.', exchange, marketType, symbol });
    }

    try {
      counts.inserted = await saveObservations(env.JPTI_DB, observations);
      counts.duplicates = Math.max(0, counts.valid - counts.inserted);
    } catch (error) {
      errors.push({ stage: 'd1-write', error: String(error?.message || error).slice(0, 220) });
    }

    const finishedAt = now().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    const status = observations.length === 0 ? 'failed' : errors.length || counts.succeeded < counts.attempted ? 'partial' : 'completed';
    const summary = {
      runId, status, startedAt, finishedAt, durationMs, plan, counts, errors: errors.slice(0, MAX_ITEMS),
      source: 'github-actions-runner', storage: 'cloudflare-d1', immutableObservations: true, liveExecutionAuthorized: false
    };

    try {
      await env.JPTI_DB.prepare(
        'UPDATE jpti_market_replication_runs SET status=?,finished_at=?,duration_ms=?,counts_json=?,errors_json=? WHERE run_id=?'
      ).bind(status, finishedAt, durationMs, JSON.stringify(counts), JSON.stringify(summary.errors), runId).run();
      if (counts.inserted > 0) {
        await env.JPTI_DB.prepare(
          'INSERT INTO jpti_market_replication_cursors (cursor_key,cursor_value,updated_at) VALUES (?,?,?) ON CONFLICT(cursor_key) DO UPDATE SET cursor_value=excluded.cursor_value,updated_at=excluded.updated_at'
        ).bind('last-successful-run', runId, finishedAt).run();
      }
    } catch (error) {
      return reply(503, { error: 'Runner observations were collected but replication metadata could not be finalized.', runId, detail: String(error?.message || error).slice(0, 180), summary });
    }

    return reply(status === 'failed' ? 502 : 200, summary);
  };
}

const handler = createRunnerReplicationIngestHandler();
export async function onRequest(context) { return handler(context); }
