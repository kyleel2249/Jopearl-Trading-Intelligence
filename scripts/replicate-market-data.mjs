import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { createDirectProvider } from '../src/lib/browser-direct.js';
import {
  normalizeReplicationPlan, marketTypesForExchange, selectReplicationMarkets
} from '../src/market-replication-engine.js';

const cleanError = error => String(error?.message || error || 'Unknown exchange error').slice(0, 220);
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

function assertRequestedVenue(response, exchange, stage) {
  if (!response || response.status !== 200) throw new Error(response?.body?.error || stage + ' request failed.');
  const body = response.body || {};
  if (body.failedOver === true || String(body.exchange || '').toLowerCase() !== exchange || String(body.requestedExchange || '').toLowerCase() !== exchange) {
    throw new Error(stage + ' response came from a different exchange; cross-venue failover data was rejected.');
  }
  return body;
}

export async function runRunnerReplication({
  endpoint,
  token,
  provider = createDirectProvider(),
  fetchImpl = fetch,
  planInput = {},
  logger = console
} = {}) {
  if (!endpoint || !token) throw new Error('A production replication endpoint and JPTI API token are required.');
  const plan = normalizeReplicationPlan(planInput);
  const observations = [];
  const errors = [];
  const counts = { attempted: 0, succeeded: 0, tickers: 0, candles: 0, markets: 0, inserted: 0, duplicates: 0, valid: 0 };
  const runIds = [];

  for (const exchange of plan.exchanges) {
    for (const marketType of marketTypesForExchange(exchange, plan.marketTypes)) {
      counts.attempted++;
      let marketRows = [];
      try {
        const marketPath = '/api/exchanges/' + exchange + '/markets?type=' + encodeURIComponent(marketType);
        const result = await provider.request(marketPath, { method: 'GET' });
        if (!result || result.status !== 200) throw new Error(result?.body?.error || 'Market catalogue unavailable.');
        marketRows = selectReplicationMarkets(result.body?.markets, plan.symbols, plan.limit);
        counts.succeeded++;
        counts.markets += marketRows.length;
        if (!marketRows.length) errors.push({ exchange, marketType, stage: 'markets', error: 'No configured symbols were listed for this product category.' });
      } catch (error) {
        errors.push({ exchange, marketType, stage: 'markets', error: cleanError(error) });
        continue;
      }

      for (const market of marketRows) {
        const symbol = String(market.symbol || '').toUpperCase();
        const query = '?type=' + encodeURIComponent(marketType) + '&failover=false' +
          (exchange === 'bitget' && market.id ? '&instrumentId=' + encodeURIComponent(market.id) : '');

        counts.attempted++;
        try {
          const response = await provider.request('/api/exchanges/' + exchange + '/ticker/' + encodeURIComponent(symbol) + query, { method: 'GET' });
          const ticker = assertRequestedVenue(response, exchange, 'Ticker');
          observations.push({
            exchange, marketType, symbol, kind: 'ticker', ticker,
            sourceExchange: ticker.exchange, requestedExchange: ticker.requestedExchange, failedOver: ticker.failedOver
          });
          counts.succeeded++;
          counts.tickers++;
        } catch (error) {
          errors.push({ exchange, marketType, symbol, stage: 'ticker', error: cleanError(error) });
        }

        if (!plan.includeCandles) continue;
        for (const timeframe of plan.timeframes) {
          counts.attempted++;
          try {
            const candlePath = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol) +
              '?type=' + encodeURIComponent(marketType) + '&timeframe=' + encodeURIComponent(timeframe) +
              '&limit=' + plan.candleLimit + '&failover=false' +
              (exchange === 'bitget' && market.id ? '&instrumentId=' + encodeURIComponent(market.id) : '');
            const response = await provider.request(candlePath, { method: 'GET' });
            const candleBody = assertRequestedVenue(response, exchange, 'OHLCV');
            if (!Array.isArray(candleBody.candles) || !candleBody.candles.length) throw new Error('Exchange returned no candles.');
            observations.push({
              exchange, marketType, symbol, kind: 'ohlcv', timeframe, candles: candleBody.candles,
              sourceExchange: candleBody.exchange, requestedExchange: candleBody.requestedExchange, failedOver: candleBody.failedOver
            });
            counts.succeeded++;
            counts.candles += candleBody.candles.length;
          } catch (error) {
            errors.push({ exchange, marketType, symbol, timeframe, stage: 'ohlcv', error: cleanError(error) });
          }
        }
      }
    }
  }

  if (!observations.length) {
    const detail = errors.slice(0, 8).map(item => item.exchange + '/' + item.marketType + ' ' + item.stage + ': ' + item.error).join('; ');
    throw new Error('Runner replication collected no venue-verified market observations. ' + detail);
  }

  const ingestUrl = endpoint.replace(/\/+$/, '') + '/ingest';
  let apiPartial = false;
  for (const [index, batch] of chunks(observations, 8).entries()) {
    const response = await fetchImpl(ingestUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jpti-api-token': token },
      body: JSON.stringify({
        observations: batch,
        attempted: batch.length,
        errors: index === 0 ? errors : []
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.runId || !['completed', 'partial'].includes(body.status)) {
      throw new Error('D1 runner ingest failed with HTTP ' + response.status + ': ' + cleanError(body?.error || 'Invalid ingest response.'));
    }
    runIds.push(body.runId);
    counts.inserted += Number(body.counts?.inserted || 0);
    counts.duplicates += Number(body.counts?.duplicates || 0);
    counts.valid += Number(body.counts?.valid || 0);
    if (body.status === 'partial') apiPartial = true;
  }

  const status = errors.length || apiPartial ? 'partial' : 'completed';
  const summary = { status, runIds, counts, errors: errors.slice(0, 80), source: 'github-actions-runner', storage: 'cloudflare-d1' };
  logger.log('Runner market replication:', JSON.stringify(summary));
  if (status === 'partial') logger.warn('Some exchange sources were unavailable; only venue-verified observations were sent to D1.');
  return summary;
}

async function main() {
  const endpoint = process.env.REPLICATION_URL;
  const token = process.env.JPTI_API_TOKEN;
  const planInput = {
    exchanges: process.env.JPTI_REPLICATION_EXCHANGES ? process.env.JPTI_REPLICATION_EXCHANGES.split(',') : undefined,
    symbols: process.env.JPTI_REPLICATION_SYMBOLS ? process.env.JPTI_REPLICATION_SYMBOLS.split(',') : undefined,
    marketTypes: process.env.JPTI_REPLICATION_MARKET_TYPES ? process.env.JPTI_REPLICATION_MARKET_TYPES.split(',') : undefined,
    timeframes: process.env.JPTI_REPLICATION_TIMEFRAMES ? process.env.JPTI_REPLICATION_TIMEFRAMES.split(',') : ['1m', '5m', '1h'],
    marketLimit: Number(process.env.JPTI_REPLICATION_MARKET_LIMIT || 1),
    candleLimit: Number(process.env.JPTI_REPLICATION_CANDLE_LIMIT || 80),
    includeCandles: true
  };
  const summary = await runRunnerReplication({ endpoint, token, planInput });
  writeFileSync(process.env.JPTI_REPLICATION_OUTPUT || 'replication-result.json', JSON.stringify(summary, null, 2));
  if (summary.status === 'partial') process.exitCode = 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('Runner market replication failed:', cleanError(error));
    process.exitCode = 1;
  });
}
