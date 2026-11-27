import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDirectProvider } from '../src/lib/browser-direct.js';
import {
  DEFAULT_REPLICATION_SYMBOLS,
  normalizeReplicationPlan,
  boundReplicationPlanToSubrequestBudget,
  marketTypesForExchange,
  selectReplicationMarkets,
  normalizeTickerObservation,
  normalizeCandleObservations,
  buildReplicationSummary
} from '../src/market-replication-engine.js';

const DEFAULT_ENDPOINT = 'https://jopearl-trading-intelligence.pages.dev/api/replication';
const INGEST_PATH = '/ingest';

function validateEndpoint(value) {
  const parsed = new URL(String(value || DEFAULT_ENDPOINT));
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'jopearl-trading-intelligence.pages.dev'
    || parsed.pathname !== '/api/replication' || parsed.search || parsed.hash) {
    throw new Error('REPLICATION_URL must be the approved JPTI production HTTPS replication endpoint.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function sourceIntegrity(body, exchange, label) {
  const servedExchange = String(body?.exchange || '').toLowerCase();
  const requestedExchange = String(body?.requestedExchange || '').toLowerCase();
  if (servedExchange !== exchange || requestedExchange !== exchange || body?.failedOver === true) {
    throw new Error(label + ' cross-venue failover data was rejected; requested ' + exchange
      + ', served ' + (servedExchange || 'unknown') + '.');
  }
}

export async function runRunnerReplication(options = {}) {
  const endpoint = validateEndpoint(options.endpoint || process.env.REPLICATION_URL || DEFAULT_ENDPOINT);
  const token = String(options.token ?? process.env.JPTI_API_TOKEN ?? '');
  if (!token.trim()) throw new Error('JPTI_API_TOKEN is required. Configure JPTI_JOURNAL_TOKEN or JPTI_API_TOKEN as a GitHub Actions secret.');

  const provider = options.provider || createDirectProvider();
  const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
  const logger = options.logger || console;
  const env = options.env || process.env;
  const planInput = { ...(options.planInput || {}) };
  if (planInput.limit === undefined && planInput.marketLimit !== undefined) planInput.limit = planInput.marketLimit;
  const basePlan = normalizeReplicationPlan(planInput, env);
  const groupCount = basePlan.exchanges.reduce((sum, exchange) => sum + marketTypesForExchange(exchange, basePlan.marketTypes).length, 0);
  const plan = boundReplicationPlanToSubrequestBudget(basePlan, groupCount, options.maxSubrequests || 45);
  const startedAt = new Date().toISOString();
  const observations = [];
  const errors = [];
  const skipped = [];
  const marketsSeen = [];
  const counts = { attempted: 0, succeeded: 0, valid: 0, inserted: 0, duplicates: 0, tickers: 0, candles: 0, markets: 0 };

  async function request(path, exchange, label) {
    counts.attempted += 1;
    const result = await provider.request(path, { method: 'GET' });
    if (!result || result.status !== 200 || result.failed) {
      throw new Error(result?.body?.error || result?.error || label + ' request failed with HTTP ' + (result?.status || 'unknown') + '.');
    }
    const body = result.body || {};
    if (body.failedOver === true || (body.exchange && String(body.exchange).toLowerCase() !== exchange)
      || (body.requestedExchange && String(body.requestedExchange).toLowerCase() !== exchange)) {
      throw new Error(label + ' cross-venue failover data was rejected for requested exchange ' + exchange + '.');
    }
    counts.succeeded += 1;
    return body;
  }

  for (const exchange of plan.exchanges) {
    for (const marketType of marketTypesForExchange(exchange, plan.marketTypes)) {
      try {
        const marketPath = '/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(marketType) + '&failover=false';
        const catalog = await request(marketPath, exchange, 'Market catalog');
        const markets = selectReplicationMarkets(catalog.markets, plan.symbols, plan.limit);
        if (!markets.length) {
          skipped.push({ exchange, marketType, stage: 'markets', reason: 'No configured market was listed.' });
          continue;
        }
        for (const market of markets) {
          const symbol = String(market.symbol).toUpperCase();
          const instrumentId = String(market.id || market.instrumentId || '').trim();
          const instrumentQuery = instrumentId ? '&instrumentId=' + encodeURIComponent(instrumentId) : '';
          marketsSeen.push({ exchange, marketType, symbol });
          counts.markets += 1;

          try {
            const tickerPath = '/api/exchanges/' + exchange + '/ticker/' + encodeURIComponent(symbol)
              + '?type=' + encodeURIComponent(marketType) + instrumentQuery + '&failover=false';
            const ticker = await request(tickerPath, exchange, 'Ticker');
            sourceIntegrity(ticker, exchange, 'Ticker');
            const normalized = normalizeTickerObservation({ exchange, marketType, symbol, ticker, receivedAt: Date.now() });
            if (!normalized) throw new Error('Ticker failed timestamp, positive-price or source validation.');
            observations.push({
              exchange, marketType, symbol, kind: 'ticker', ticker,
              sourceExchange: exchange, requestedExchange: exchange, failedOver: false
            });
            counts.tickers += 1;
            counts.valid += 1;
          } catch (error) {
            errors.push({ exchange, marketType, symbol, stage: 'ticker', error: String(error?.message || error).slice(0, 220) });
          }

          for (const timeframe of plan.timeframes) {
            try {
              const candlePath = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol)
                + '?type=' + encodeURIComponent(marketType) + '&timeframe=' + encodeURIComponent(timeframe)
                + '&limit=' + plan.candleLimit + instrumentQuery + '&failover=false';
              const candleResponse = await request(candlePath, exchange, 'OHLCV');
              sourceIntegrity(candleResponse, exchange, 'OHLCV');
              const rows = normalizeCandleObservations({
                exchange, marketType, symbol, timeframe,
                candles: candleResponse.candles, receivedAt: Date.now()
              });
              if (!rows.length) throw new Error('No candles passed OHLCV integrity validation.');
              observations.push({
                exchange, marketType, symbol, kind: 'ohlcv', timeframe,
                candles: candleResponse.candles,
                sourceExchange: exchange, requestedExchange: exchange, failedOver: false
              });
              counts.candles += rows.length;
              counts.valid += rows.length;
            } catch (error) {
              errors.push({ exchange, marketType, symbol, timeframe, stage: 'ohlcv', error: String(error?.message || error).slice(0, 220) });
            }
          }
        }
      } catch (error) {
        errors.push({ exchange, marketType, stage: 'markets', error: String(error?.message || error).slice(0, 220) });
      }
    }
  }

  if (!observations.length) {
    const finishedAt = new Date().toISOString();
    const summary = buildReplicationSummary({ startedAt, finishedAt, plan, counts, errors, skipped, runId: null });
    logger.error?.(JSON.stringify({ marketsSeen, errors: errors.slice(0, 20) }, null, 2));
    return { ...summary, markets: marketsSeen, observationsCollected: 0, observationsAccepted: 0, observationsInserted: 0 };
  }

  const response = await fetchImpl(endpoint + INGEST_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jpti-api-token': token },
    body: JSON.stringify({ mode: 'ingest', attempted: counts.attempted, observations, errors }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('D1 ingest batch failed with HTTP ' + response.status + ': ' + String(body.error || body.detail || 'unknown error'));
  if (body.status === 'failed') throw new Error('D1 ingest batch was rejected because no valid observations remained.');
  counts.inserted = Number(body.counts?.inserted || 0);
  counts.duplicates = Number(body.counts?.duplicates || Math.max(0, Number(body.counts?.valid || 0) - counts.inserted));
  const accepted = Number(body.counts?.valid || 0);
  if (accepted < counts.valid) errors.push({ stage: 'd1-validation', error: 'D1 accepted ' + accepted + ' of ' + counts.valid + ' locally validated observations.' });
  counts.valid = accepted;
  const finishedAt = new Date().toISOString();
  const summary = buildReplicationSummary({ startedAt, finishedAt, plan, counts, errors, skipped, runId: body.runId || null });
  const report = {
    ...summary, markets: marketsSeen, observationsCollected: observations.length,
    observationsAccepted: accepted, observationsInserted: counts.inserted,
    source: 'github-actions-direct-market-data'
  };
  logger.log?.(JSON.stringify(report, null, 2));
  if (errors.length) logger.warn?.('Some exchanges, market categories or observations could not be collected; successful observations were retained.');
  return report;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRunnerReplication({ endpoint: process.env.REPLICATION_URL || DEFAULT_ENDPOINT, token: process.env.JPTI_API_TOKEN, logger: console })
    .catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
