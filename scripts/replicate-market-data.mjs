import { createDirectProvider } from '../src/lib/browser-direct.js';
import {
  DEFAULT_REPLICATION_SYMBOLS,
  normalizeTickerObservation,
  normalizeCandleObservations,
  selectReplicationMarkets
} from '../src/market-replication-engine.js';

const endpoint = String(process.env.REPLICATION_URL || 'https://jopearl-trading-intelligence.pages.dev/api/replication');
const token = String(process.env.JPTI_API_TOKEN || '');
if (!token.trim()) throw new Error('JPTI_API_TOKEN is required. Configure JPTI_JOURNAL_TOKEN or JPTI_API_TOKEN as a GitHub Actions secret.');
const parsedEndpoint = new URL(endpoint);
if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.hostname !== 'jopearl-trading-intelligence.pages.dev' || parsedEndpoint.pathname !== '/api/replication' || parsedEndpoint.search || parsedEndpoint.hash) {
  throw new Error('REPLICATION_URL must be the approved JPTI production HTTPS replication endpoint.');
}

const provider = createDirectProvider();
const categories = ['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m'];
const symbols = String(process.env.JPTI_REPLICATION_SYMBOLS || DEFAULT_REPLICATION_SYMBOLS.join(',')).split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
const timeframes = ['1m', '5m', '1h'];
const observations = [];
const errors = [];
const marketsSeen = [];

async function request(path) {
  const result = await provider.request(path, { method: 'GET' });
  if (!result || result.status !== 200) throw new Error(result?.body?.error || 'Direct exchange request returned no response.');
  const expectedExchange = String(path.match(/^\/api\/exchanges\/([a-z0-9_]+)/i)?.[1] || '').toLowerCase();
  const servedExchange = String(result.body?.exchange || '').toLowerCase();
  if (expectedExchange && servedExchange && servedExchange !== expectedExchange) {
    throw new Error('Exchange failover served ' + servedExchange + ' for a ' + expectedExchange + ' request; refusing to mislabel observations.');
  }
  if (result.body?.failedOver === true) throw new Error('Exchange failover is not accepted for source-specific replication.');
  return result.body;
}

for (const marketType of categories) {
  try {
    const catalog = await request('/api/exchanges/bitget/markets?type=' + encodeURIComponent(marketType));
    const markets = selectReplicationMarkets(catalog.markets, symbols, 1);
    if (!markets.length) {
      errors.push({ marketType, stage: 'markets', error: 'No configured BTC market was listed.' });
      continue;
    }
    for (const market of markets) {
      const symbol = String(market.symbol).toUpperCase();
      const query = '?type=' + encodeURIComponent(marketType) + (market.id ? '&instrumentId=' + encodeURIComponent(market.id) : '');
      marketsSeen.push({ marketType, symbol });
      try {
        const ticker = await request('/api/exchanges/bitget/ticker/' + encodeURIComponent(symbol) + query);
        const normalized = normalizeTickerObservation({ exchange: 'bitget', marketType, symbol, ticker, receivedAt: Date.now() });
        if (normalized) observations.push(normalized);
        else errors.push({ marketType, symbol, stage: 'ticker-validation', error: 'Ticker failed timestamp or positive-price validation.' });
      } catch (error) {
        errors.push({ marketType, symbol, stage: 'ticker', error: String(error?.message || error).slice(0, 180) });
      }

      for (const timeframe of timeframes) {
        try {
          const candles = await request('/api/exchanges/bitget/ohlcv/' + encodeURIComponent(symbol) + '?type=' + encodeURIComponent(marketType) + '&timeframe=' + encodeURIComponent(timeframe) + '&limit=80' + (market.id ? '&instrumentId=' + encodeURIComponent(market.id) : ''));
          const rows = normalizeCandleObservations({ exchange: 'bitget', marketType, symbol, timeframe, candles: candles.candles, receivedAt: Date.now() });
          observations.push(...rows);
          if (!rows.length) errors.push({ marketType, symbol, timeframe, stage: 'ohlcv-validation', error: 'No candles passed OHLCV integrity validation.' });
        } catch (error) {
          errors.push({ marketType, symbol, timeframe, stage: 'ohlcv', error: String(error?.message || error).slice(0, 180) });
        }
      }
    }
  } catch (error) {
    errors.push({ marketType, stage: 'markets', error: String(error?.message || error).slice(0, 180) });
  }
}

if (!observations.length) {
  console.error(JSON.stringify({ marketsSeen, errors: errors.slice(0, 20) }, null, 2));
  throw new Error('Direct runner acquisition returned zero valid observations. No empty replication batch was sent.');
}

let inserted = 0;
let accepted = 0;
for (let offset = 0; offset < observations.length; offset += 1500) {
  const batch = observations.slice(offset, offset + 1500);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jpti-api-token': token },
    body: JSON.stringify({ mode: 'ingest', observations: batch }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error('D1 ingest batch failed with HTTP ' + response.status + ': ' + String(body.error || body.detail || 'unknown error'));
  accepted += Number(body.counts?.valid || 0);
  inserted += Number(body.counts?.inserted || 0);
  if (body.status === 'failed') throw new Error('D1 ingest batch was rejected because no valid observations remained.');
}

console.log(JSON.stringify({
  source: 'github-actions-direct-bitget',
  markets: marketsSeen,
  observationsCollected: observations.length,
  observationsAccepted: accepted,
  observationsInserted: inserted,
  errors: errors.slice(0, 20),
  status: errors.length ? 'partial' : 'completed'
}, null, 2));
if (errors.length) console.warn('Some Bitget categories or observations could not be collected; successful observations were retained.');
