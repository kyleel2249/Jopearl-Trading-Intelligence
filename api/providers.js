import express from 'express';
import { withExchange } from './exchanges.js';
import { tokensMatch, requestApiToken } from './token-auth.js';

export const providerRouter = express.Router();

const now = () => new Date().toISOString();
const positiveSeconds = (key, fallback, min = 1, max = 86400) => {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
};

export function getOperationalIntervals() {
  return {
    marketMakerIntervalSeconds: positiveSeconds('JPTI_MM_INTERVAL_SECONDS', 5, 1, 3600),
    marketMonitorSeconds: positiveSeconds('JPTI_MARKET_MONITOR_INTERVAL_SECONDS', 5, 1, 3600),
    reconcileSeconds: positiveSeconds('JPTI_RECONCILE_INTERVAL_SECONDS', 30, 5, 86400),
    investorMonitorSeconds: positiveSeconds('JPTI_INVESTOR_MONITOR_INTERVAL_SECONDS', 60, 5, 86400),
    providerHealthSeconds: positiveSeconds('JPTI_PROVIDER_HEALTH_INTERVAL_SECONDS', 300, 30, 86400),
    marketDataRefreshSeconds: positiveSeconds('JPTI_MARKET_DATA_REFRESH_INTERVAL_SECONDS', 5, 1, 3600),
    newsRefreshSeconds: positiveSeconds('JPTI_NEWS_REFRESH_INTERVAL_SECONDS', 60, 10, 86400),
    onchainRefreshSeconds: positiveSeconds('JPTI_ONCHAIN_REFRESH_INTERVAL_SECONDS', 30, 5, 86400),
    schedulerEnabled: process.env.JPTI_SCHEDULER_ENABLED !== 'false'
  };
}

const providers = [
  { id: 'bitget', name: 'Bitget', category: 'exchange-market-data', env: [], optionalEnv: ['JPTI_BITGET_API_KEY', 'JPTI_BITGET_API_SECRET', 'JPTI_BITGET_PASSWORD'], capabilities: ['Public ticker and order book', 'recent trades', 'funding rate and open interest where supported', 'CCXT exchange gateway market catalog and private account reads'], docs: 'https://www.bitget.com/api-doc/' },
  { id: 'alpaca', name: 'Alpaca', category: 'broker-and-market-data', env: ['JPTI_ALPACA_API_KEY', 'JPTI_ALPACA_API_SECRET'], capabilities: ['US stock historical bars', 'crypto historical bars', 'paper account read', 'paper account activity history'], docs: 'https://docs.alpaca.markets/' },
  { id: 'quiver', name: 'Quiver Quantitative', category: 'alternative-data', env: ['JPTI_QUIVER_API_KEY'], capabilities: ['Ticker-specific congressional trade history'], docs: 'https://www.quiverquant.com/' },
  { id: 'finnhub', name: 'Finnhub', category: 'market-data-and-news', env: ['JPTI_FINNHUB_API_KEY'], capabilities: ['Equity quote', 'historical stock candles', 'general, forex, crypto and merger news'], docs: 'https://finnhub.io/docs/api' },
  { id: 'alphavantage', name: 'Alpha Vantage', category: 'multi-asset-data', env: ['JPTI_ALPHAVANTAGE_API_KEY'], capabilities: ['Global equity quote', 'daily equity time series', 'market news and sentiment'], docs: 'https://www.alphavantage.co/documentation/' },
  { id: 'twelvedata', name: 'Twelve Data', category: 'multi-asset-data', env: ['JPTI_TWELVEDATA_API_KEY'], capabilities: ['Cross-asset quote', 'historical time series'], docs: 'https://twelvedata.com/docs' },
  { id: 'infura', name: 'Infura', category: 'blockchain-rpc', env: ['JPTI_INFURA_API_KEY'], capabilities: ['Read-only JSON-RPC block, transaction, receipt and balance methods on allowlisted networks'], docs: 'https://docs.infura.io/' },
  { id: 'liquid', name: 'Liquid Exchange (legacy adapter)', category: 'exchange-adapter', env: [], capabilities: ['Legacy public product-catalog probe only'], docs: 'https://developers.liquid.com/', caveat: 'Legacy service availability and API access must be verified; this adapter does not imply an active venue or supported account.' },
  { id: 'gdelt', name: 'GDELT Project', category: 'news', env: [], capabilities: ['Global news discovery and event monitoring'], docs: 'https://www.gdeltproject.org/' },
  { id: 'coingecko', name: 'CoinGecko', category: 'crypto-reference-data', env: [], capabilities: ['Global crypto market statistics and asset reference data'], docs: 'https://docs.coingecko.com/' },
  { id: 'defillama', name: 'DeFiLlama', category: 'defi-and-onchain', env: [], capabilities: ['Chain TVL', 'stablecoin supply', 'protocol fees and DeFi metrics'], docs: 'https://defillama.com/docs/api' },
  { id: 'fred', name: 'FRED', category: 'macro-data', env: ['JPTI_FRED_API_KEY'], capabilities: ['Macroeconomic and rates time series'], docs: 'https://fred.stlouisfed.org/docs/api/' },
  { id: 'alchemy', name: 'Alchemy', category: 'blockchain-indexer', env: ['JPTI_ALCHEMY_API_KEY'], capabilities: ['Indexed EVM transfers and enhanced blockchain data'], docs: 'https://www.alchemy.com/docs' },
  { id: 'helius', name: 'Helius', category: 'solana-indexer', env: ['JPTI_HELIUS_API_KEY'], capabilities: ['Solana enhanced transactions and webhooks'], docs: 'https://www.helius.dev/docs' }
];

export function providerDirectory() {
  return providers.map((item) => ({
    ...item,
    configured: item.env.length === 0 || item.env.every((key) => Boolean(process.env[key])),
    missingCredentials: item.env.filter((key) => !process.env[key]),
    optionalCredentialsConfigured: Boolean(item.optionalEnv?.length && item.optionalEnv.every((key) => Boolean(process.env[key]))),
    missingOptionalCredentials: (item.optionalEnv || []).filter((key) => !process.env[key]),
    status: item.env.length === 0 ? 'public-or-no-key' : item.env.every((key) => Boolean(process.env[key])) ? 'credentials-configured-not-verified' : 'not-configured'
  }));
}

async function requestJson(url, { headers = {}, method = 'GET', body, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method, body, signal: controller.signal,
      headers: { accept: 'application/json', ...headers }
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { raw: raw.slice(0, 1000) }; }
    if (!response.ok) throw Object.assign(new Error(payload?.message || payload?.error || `Provider HTTP ${response.status}`), { status: response.status === 429 ? 429 : 502 });
    if (payload?.error && !payload?.data) throw Object.assign(new Error(payload.error.message || payload.error), { status: 502 });
    return payload;
  } finally { clearTimeout(timer); }
}
const requireKey = (key, provider) => {
  if (!process.env[key]) throw Object.assign(new Error(`${provider} API key is not configured. Set ${key} in the server .env file.`), { status: 503 });
  return process.env[key];
};
const safeSymbol = (value) => {
  const symbol = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9._:/-]{1,32}$/.test(symbol)) throw Object.assign(new Error('Invalid symbol.'), { status: 400 });
  return symbol;
};

providerRouter.get('/providers', (_req, res) => {
  res.json({ generatedAt: now(), providers: providerDirectory(), intervals: getOperationalIntervals(), note: 'Configured means credentials are present only. A successful live request is required to verify connectivity and entitlement.' });
});
providerRouter.get('/providers/intervals', (_req, res) => res.json({ generatedAt: now(), intervals: getOperationalIntervals(), units: 'seconds', note: 'These are scheduler policy settings. A configured interval does not mean a market-making, reconciliation or investor-monitor worker is implemented or running.' }));

providerRouter.get('/providers/alpaca/bars', async (req, res) => {
  try {
    const key = requireKey('JPTI_ALPACA_API_KEY', 'Alpaca');
    const secret = requireKey('JPTI_ALPACA_API_SECRET', 'Alpaca');
    const symbol = safeSymbol(req.query.symbol || 'AAPL');
    const timeframe = String(req.query.timeframe || '1Day');
    if (!/^(1Min|5Min|15Min|30Min|1Hour|1Day)$/.test(timeframe)) return res.status(400).json({ error: 'Unsupported Alpaca timeframe.' });
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '100', 10) || 100));
    const feed = String(req.query.feed || 'iex');
    if (!['iex', 'sip', 'delayed_sip', 'boats', 'overnight'].includes(feed)) return res.status(400).json({ error: 'Unsupported Alpaca feed.' });
    const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(symbol)}/bars`);
    url.search = new URLSearchParams({ timeframe, limit: String(limit), feed }).toString();
    const data = await requestJson(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    res.json({ provider: 'alpaca', symbol, timeframe, feed, bars: data.bars || [], nextPageToken: data.next_page_token || null, fetchedAt: now(), entitlementNote: 'Feed availability depends on the Alpaca account subscription.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});


providerRouter.get('/providers/alpaca/crypto-bars', async (req, res) => {
  try {
    const key = requireKey('JPTI_ALPACA_API_KEY', 'Alpaca');
    const secret = requireKey('JPTI_ALPACA_API_SECRET', 'Alpaca');
    const symbol = safeSymbol(req.query.symbol || 'BTC/USD');
    const timeframe = String(req.query.timeframe || '1Day');
    if (!/^(1Min|5Min|15Min|30Min|1Hour|1Day)$/.test(timeframe)) return res.status(400).json({ error: 'Unsupported Alpaca timeframe.' });
    const limit = Math.min(1000, Math.max(1, Number.parseInt(req.query.limit || '100', 10) || 100));
    const url = new URL(`https://data.alpaca.markets/v1beta3/crypto/us/bars`);
    url.search = new URLSearchParams({ symbols: symbol, timeframe, limit: String(limit) }).toString();
    const data = await requestJson(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    res.json({ provider: 'alpaca', assetClass: 'crypto', symbol, timeframe, bars: data.bars?.[symbol] || [], fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/alpaca/account', async (req, res) => {
  try {
    const expectedToken = process.env.JPTI_API_TOKEN;
    if (!tokensMatch(expectedToken, requestApiToken(req))) return res.status(401).json({ error: 'Valid x-jpti-api-token required for private broker account data.' });
    const key = requireKey('JPTI_ALPACA_API_KEY', 'Alpaca');
    const secret = requireKey('JPTI_ALPACA_API_SECRET', 'Alpaca');
    const data = await requestJson('https://paper-api.alpaca.markets/v2/account', { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    res.json({ provider: 'alpaca', account: data, fetchedAt: now(), environment: 'paper' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/alpaca/activities', async (req, res) => {
  try {
    const expectedToken = process.env.JPTI_API_TOKEN;
    if (!tokensMatch(expectedToken, requestApiToken(req))) return res.status(401).json({ error: 'Valid x-jpti-api-token required for private broker activity.' });
    const key = requireKey('JPTI_ALPACA_API_KEY', 'Alpaca');
    const secret = requireKey('JPTI_ALPACA_API_SECRET', 'Alpaca');
    const activityType = String(req.query.activity_type || 'FILL');
    if (!['FILL','TRANS','MISC','ACATC','ACATS','CFEE','CSD','CSW','DIV','FEE','INT','JNL','JNLC','JNLS','MA','NC','OPASN','OPCA','OPTRD','PTC','PTR','REORG','SC'].includes(activityType)) return res.status(400).json({ error: 'Unsupported Alpaca activity type.' });
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit || '50', 10) || 50));
    const url = new URL(`https://paper-api.alpaca.markets/v2/account/activities/${encodeURIComponent(activityType)}`);
    url.search = new URLSearchParams({ page_size: String(limit) }).toString();
    const data = await requestJson(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    res.json({ provider: 'alpaca', environment: 'paper', activityType, activities: Array.isArray(data) ? data : [], fetchedAt: now(), note: 'Paper-account activities only. Activity history may be paginated by Alpaca.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/finnhub/quote/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_FINNHUB_API_KEY', 'Finnhub');
    const symbol = safeSymbol(req.params.symbol);
    const url = new URL('https://finnhub.io/api/v1/quote');
    url.search = new URLSearchParams({ symbol, token: key }).toString();
    const data = await requestJson(url);
    res.json({ provider: 'finnhub', symbol, quote: data, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/finnhub/candles/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_FINNHUB_API_KEY', 'Finnhub');
    const symbol = safeSymbol(req.params.symbol);
    const resolution = String(req.query.resolution || 'D');
    if (!['1','5','15','30','60','D','W','M'].includes(resolution)) return res.status(400).json({ error: 'Unsupported Finnhub candle resolution.' });
    const to = Math.floor(Date.now() / 1000);
    const from = Math.max(0, Number.parseInt(req.query.from || String(to - 30 * 86400), 10));
    if (!Number.isFinite(from) || from >= to) return res.status(400).json({ error: 'Invalid candle from timestamp.' });
    const url = new URL('https://finnhub.io/api/v1/stock/candle');
    url.search = new URLSearchParams({ symbol, resolution, from: String(from), to: String(to), token: key }).toString();
    const data = await requestJson(url);
    if (data.s === 'no_data') return res.json({ provider: 'finnhub', symbol, resolution, candles: [], status: 'no_data', fetchedAt: now() });
    if (data.s !== 'ok') return res.status(502).json({ error: 'Finnhub returned an unsuccessful candle response.' });
    const candles = (data.t || []).map((timestamp, i) => ({ timestamp, open: data.o?.[i], high: data.h?.[i], low: data.l?.[i], close: data.c?.[i], volume: data.v?.[i] }));
    res.json({ provider: 'finnhub', symbol, resolution, candles, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/finnhub/news', async (req, res) => {
  try {
    const key = requireKey('JPTI_FINNHUB_API_KEY', 'Finnhub');
    const category = String(req.query.category || 'general');
    if (!['general', 'forex', 'crypto', 'merger'].includes(category)) return res.status(400).json({ error: 'Invalid Finnhub news category.' });
    const url = new URL('https://finnhub.io/api/v1/news');
    url.search = new URLSearchParams({ category, token: key }).toString();
    const news = await requestJson(url);
    res.json({ provider: 'finnhub', category, articles: Array.isArray(news) ? news : [], fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/alphavantage/quote/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_ALPHAVANTAGE_API_KEY', 'Alpha Vantage');
    const symbol = safeSymbol(req.params.symbol);
    const url = new URL('https://www.alphavantage.co/query');
    url.search = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol, apikey: key }).toString();
    const data = await requestJson(url);
    if (data.Note || data.Information) return res.status(429).json({ error: data.Note || data.Information, provider: 'alphavantage' });
    res.json({ provider: 'alphavantage', symbol, quote: data['Global Quote'] || null, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/alphavantage/daily/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_ALPHAVANTAGE_API_KEY', 'Alpha Vantage');
    const symbol = safeSymbol(req.params.symbol);
    const outputsize = String(req.query.outputsize || 'compact');
    if (!['compact', 'full'].includes(outputsize)) return res.status(400).json({ error: 'outputsize must be compact or full.' });
    const url = new URL('https://www.alphavantage.co/query');
    url.search = new URLSearchParams({ function: 'TIME_SERIES_DAILY', symbol, outputsize, apikey: key }).toString();
    const data = await requestJson(url);
    if (data.Note || data.Information) return res.status(429).json({ error: data.Note || data.Information, provider: 'alphavantage' });
    const seriesKey = 'Time Series (Daily)';
    res.json({ provider: 'alphavantage', symbol, series: data[seriesKey] || {}, metadata: data['Meta Data'] || {}, fetchedAt: now(), entitlementNote: 'Full history and realtime/intraday access depend on Alpha Vantage plan and market-data licensing.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/alphavantage/news', async (req, res) => {
  try {
    const key = requireKey('JPTI_ALPHAVANTAGE_API_KEY', 'Alpha Vantage');
    const url = new URL('https://www.alphavantage.co/query');
    url.search = new URLSearchParams({ function: 'NEWS_SENTIMENT', tickers: String(req.query.tickers || 'AAPL'), limit: String(Math.min(1000, Math.max(1, Number(req.query.limit) || 50))), apikey: key }).toString();
    const data = await requestJson(url);
    if (data.Note || data.Information) return res.status(429).json({ error: data.Note || data.Information, provider: 'alphavantage' });
    res.json({ provider: 'alphavantage', feed: data.feed || [], sentiment: data, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/twelvedata/quote/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_TWELVEDATA_API_KEY', 'Twelve Data');
    const symbol = safeSymbol(req.params.symbol);
    const url = new URL('https://api.twelvedata.com/quote');
    url.search = new URLSearchParams({ symbol, apikey: key }).toString();
    const data = await requestJson(url);
    if (data.status === 'error') return res.status(502).json({ error: data.message || 'Twelve Data quote request failed.' });
    res.json({ provider: 'twelvedata', symbol, quote: data, fetchedAt: now(), meta: data.exchange || data.instrument_name || null });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/twelvedata/time-series/:symbol', async (req, res) => {
  try {
    const key = requireKey('JPTI_TWELVEDATA_API_KEY', 'Twelve Data');
    const symbol = safeSymbol(req.params.symbol);
    const interval = String(req.query.interval || '1day');
    if (!/^(1min|5min|15min|30min|45min|1h|2h|4h|1day|1week|1month)$/.test(interval)) return res.status(400).json({ error: 'Unsupported Twelve Data interval.' });
    const url = new URL('https://api.twelvedata.com/time_series');
    url.search = new URLSearchParams({ symbol, interval, outputsize: String(Math.min(5000, Math.max(1, Number(req.query.outputsize) || 100))), apikey: key, format: 'JSON' }).toString();
    const data = await requestJson(url);
    if (data.status === 'error') return res.status(502).json({ error: data.message || 'Twelve Data request failed' });
    res.json({ provider: 'twelvedata', symbol, interval, values: data.values || [], meta: data.meta || {}, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/quiver/congress/:ticker', async (req, res) => {
  try {
    const key = requireKey('JPTI_QUIVER_API_KEY', 'Quiver Quantitative');
    const ticker = safeSymbol(req.params.ticker);
    const url = new URL(`https://api.quiverquant.com/beta/historical/congresstrading/${encodeURIComponent(ticker)}`);
    const data = await requestJson(url, { headers: { Authorization: `Bearer ${key}` } });
    res.json({ provider: 'quiver', dataset: 'congressional-trading', ticker, records: Array.isArray(data) ? data : data.data || [], fetchedAt: now(), note: 'Access and historical depth depend on Quiver subscription. Congressional disclosures can be delayed from transaction date.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

const INFURA_NETWORKS = new Set(['mainnet', 'sepolia', 'arbitrum-mainnet', 'base-mainnet', 'optimism-mainnet', 'polygon-mainnet']);
const INFURA_METHODS = new Set(['eth_blockNumber', 'eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBalance']);
providerRouter.post('/providers/infura/:network/rpc', async (req, res) => {
  try {
    const key = requireKey('JPTI_INFURA_API_KEY', 'Infura');
    const network = String(req.params.network).toLowerCase();
    const method = String(req.body?.method || '');
    if (!INFURA_NETWORKS.has(network)) return res.status(400).json({ error: 'Unsupported Infura network.', supported: [...INFURA_NETWORKS] });
    if (!INFURA_METHODS.has(method)) return res.status(400).json({ error: 'RPC method is not in the read-only allowlist.', allowedMethods: [...INFURA_METHODS] });
    const params = Array.isArray(req.body?.params) ? req.body.params : [];
    if (params.length > 3) return res.status(400).json({ error: 'Too many RPC parameters.' });
    const data = await requestJson(`https://${network}.infura.io/v3/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (data.error) return res.status(502).json({ error: data.error.message || 'Infura RPC error', code: data.error.code });
    res.json({ provider: 'infura', network, method, result: data.result, fetchedAt: now() });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/news/search', async (req, res) => {
  try {
    const query = String(req.query.q || 'financial markets').trim().slice(0, 120);
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    url.search = new URLSearchParams({ query, mode: 'ArtList', format: 'json', maxrecords: '50', sort: 'HybridRel' }).toString();
    const data = await requestJson(url);
    res.json({ provider: 'gdelt', query, articles: data.articles || [], fetchedAt: now(), note: 'News discovery only; validate source credibility, publication time and duplicate syndication before using as a signal.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

providerRouter.get('/providers/liquid/markets', async (_req, res) => {
  try {
    const base = String(process.env.JPTI_LIQUID_API_BASE_URL || 'https://api.liquid.com').replace(/\/$/, '');
    const data = await requestJson(`${base}/products`);
    res.json({ provider: 'liquid', markets: Array.isArray(data) ? data : [], fetchedAt: now(), caveat: 'Legacy Liquid/Quoine API reachability does not establish current exchange operations, liquidity or account support.' });
  } catch (e) { res.status(e.status || 502).json({ error: `Liquid legacy endpoint unavailable or unsupported: ${e.message}` }); }
});


// Bitget public market intelligence. The endpoint is read-only and does not require exchange credentials.
const bitgetSnapshotCache = new Map();
const bitgetSnapshotTtlMs = Math.max(1000, Math.min(15000, Number(process.env.JPTI_BITGET_SNAPSHOT_CACHE_MS) || 5000));
providerRouter.get('/providers/bitget/market-intelligence/:symbol', async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);
  const cacheKey = symbol.toUpperCase();
  const cached = bitgetSnapshotCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < bitgetSnapshotTtlMs) return res.json({ ...cached.payload, cache: 'hit' });
  const startedAt = Date.now();
  try {
    const snapshot = await withExchange('bitget', { privateAccess: false }, async (exchange) => {
      const tasks = {
        ticker: () => exchange.fetchTicker(symbol),
        orderBook: () => exchange.fetchOrderBook(symbol, 20),
        recentTrades: () => exchange.fetchTrades(symbol, undefined, 50),
        fundingRate: () => typeof exchange.fetchFundingRate === 'function' ? exchange.fetchFundingRate(symbol) : Promise.reject(new Error('Funding rate not supported by adapter')),
        openInterest: () => typeof exchange.fetchOpenInterest === 'function' ? exchange.fetchOpenInterest(symbol) : Promise.reject(new Error('Open interest not supported by adapter'))
      };
      const entries = await Promise.all(Object.entries(tasks).map(async ([name, fn]) => {
        try { return [name, { status: 'available', data: await fn() }]; }
        catch (error) { return [name, { status: 'unavailable', error: String(error?.message || error).slice(0, 180) }]; }
      }));
      return Object.fromEntries(entries);
    });
    const availableCount = Object.values(snapshot).filter(item => item.status === 'available').length;
    const payload = { provider: 'bitget', symbol, status: availableCount === Object.keys(snapshot).length ? 'complete' : availableCount ? 'partial' : 'unavailable', snapshot, fetchedAt: now(), latencyMs: Date.now() - startedAt, sourceQuality: { availableComponents: availableCount, totalComponents: Object.keys(snapshot).length, coveragePercent: Math.round(availableCount / Object.keys(snapshot).length * 100) }, cacheTtlMs: bitgetSnapshotTtlMs, cache: 'miss', note: 'Public, read-only snapshot. Optional derivatives components may be unavailable by market type or exchange entitlement.' };
    bitgetSnapshotCache.set(cacheKey, { createdAt: Date.now(), payload });
    if (bitgetSnapshotCache.size > 300) bitgetSnapshotCache.delete(bitgetSnapshotCache.keys().next().value);
    res.json(payload);
  } catch (error) {
    res.status(error.status || 502).json({ provider: 'bitget', symbol, status: 'unavailable', error: String(error.message || error).slice(0, 250), fetchedAt: now(), latencyMs: Date.now() - startedAt });
  }
});


// Cross-provider quote consensus: normalized observations, explicit provenance and
// anomaly flags. This is an intelligence aid, never an order trigger.
const quoteCache = new Map();
const quoteCacheTtlMs = Math.max(10000, Math.min(300000, Number(process.env.JPTI_QUOTE_CACHE_TTL_MS) || 30000));

export function normalizeProviderQuote(provider, symbol, payload, fetchedAt = now()) {
  let price = null;
  let change = null;
  let changePercent = null;
  let timestamp = fetchedAt;
  let currency = null;
  let venue = null;
  if (provider === 'bitget') {
    const ticker = payload?.ticker || payload || {};
    price = Number(ticker.last ?? ticker.close ?? ticker.price);
    change = Number(ticker.change);
    changePercent = Number(ticker.percentage ?? ticker.changePercent);
    currency = ticker.currency || (String(symbol).includes('/') ? String(symbol).split('/')[1] : null);
    venue = ticker.exchange || 'bitget';
    if (Number(ticker.timestamp) > 0) timestamp = new Date(Number(ticker.timestamp)).toISOString();
  } else if (provider === 'finnhub') {
    price = Number(payload?.c);
    change = Number(payload?.d);
    changePercent = Number(payload?.dp);
    if (Number(payload?.t) > 0) timestamp = new Date(Number(payload.t) * 1000).toISOString();
    currency = 'USD';
  } else if (provider === 'alphavantage') {
    const q = payload?.['Global Quote'] || payload || {};
    price = Number(q['05. price']);
    change = Number(q['09. change']);
    changePercent = Number.parseFloat(String(q['10. change percent'] || '').replace('%', ''));
    currency = 'USD';
  } else if (provider === 'twelvedata') {
    price = Number(payload?.price);
    change = Number(payload?.change);
    changePercent = Number(payload?.percent_change);
    currency = payload?.currency || null;
    venue = payload?.exchange || null;
    if (payload?.datetime) {
      const parsed = Date.parse(payload.datetime);
      if (Number.isFinite(parsed)) timestamp = new Date(parsed).toISOString();
    }
  } else if (provider === 'alpaca') {
    const quote = payload?.quote || payload || {};
    const bid = Number(quote.bp);
    const ask = Number(quote.ap);
    price = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(quote.ap || quote.bp);
    timestamp = quote.t || fetchedAt;
    currency = 'USD';
    venue = quote.x || null;
  }
  if (!Number.isFinite(price) || price <= 0) return null;
  return { provider, symbol, price, change: Number.isFinite(change) ? change : null,
    changePercent: Number.isFinite(changePercent) ? changePercent : null,
    timestamp, currency, venue, fetchedAt };
}

export function buildQuoteConsensus(symbol, observations) {
  const valid = observations.filter((item) => item && Number.isFinite(item.price) && item.price > 0);
  const prices = valid.map((item) => item.price).sort((a, b) => a - b);
  const median = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) : null;
  const spreadPercent = prices.length > 1 && median ? ((prices[prices.length - 1] - prices[0]) / median) * 100 : null;
  const outlierThreshold = Math.max(0.75, Number(process.env.JPTI_QUOTE_OUTLIER_THRESHOLD_PERCENT) || 1.5);
  const staleAfterSeconds = Math.max(60, Math.min(3600, Number(process.env.JPTI_QUOTE_STALE_AFTER_SECONDS) || 900));
  const sources = valid.map((item) => {
    const timestampMs = Date.parse(item.timestamp || '');
    const ageSeconds = Number.isFinite(timestampMs) ? Math.max(0, Math.round((Date.now() - timestampMs) / 1000)) : null;
    return { ...item, ageSeconds, stale: ageSeconds != null && ageSeconds > staleAfterSeconds,
      deviationFromMedianPercent: median ? ((item.price - median) / median) * 100 : null,
      outlier: valid.length >= 3 && median ? Math.abs((item.price - median) / median) * 100 > outlierThreshold : false
    };
  });
  const currencies = [...new Set(sources.map((item) => item.currency).filter(Boolean))];
  const currencyConflict = currencies.length > 1;
  return {
    symbol, generatedAt: now(), sourceCount: sources.length,
    consensusPrice: currencyConflict || !sources.length ? null : median,
    currency: currencyConflict ? null : currencies[0] || null,
    spreadPercent: currencyConflict ? null : spreadPercent,
    confidence: currencyConflict ? 'currency-conflict' : sources.length >= 3 ? 'multi-source' : sources.length === 2 ? 'cross-check' : sources.length === 1 ? 'single-source' : 'unavailable',
    sources, currencyConflict,
    caveats: ['Sources may represent different venues, feeds, trading sessions and entitlements.',
      'A median is a cross-check, not an executable price or guaranteed consolidated NBBO.',
      'Outlier flags are statistical alerts and must be reviewed before any trading decision.']
  };
}

const providerLastRequestAt = new Map();
const providerCooldowns = { bitget: 1000, finnhub: 1000, alphavantage: 3600000, twelvedata: 8000, alpaca: 500 };

async function quoteSource(provider, symbol) {
  const configuredCooldown = Number(process.env['JPTI_' + provider.toUpperCase() + '_MIN_INTERVAL_MS']);
  const cooldownMs = Number.isFinite(configuredCooldown) && configuredCooldown > 0
    ? Math.max(providerCooldowns[provider] || 1000, configuredCooldown)
    : (providerCooldowns[provider] || 1000);
  const lastRequest = providerLastRequestAt.get(provider) || 0;
  const waitMs = cooldownMs - (Date.now() - lastRequest);
  if (waitMs > 0) throw Object.assign(new Error('Provider cooldown active. Retry in approximately ' + Math.ceil(waitMs / 1000) + ' seconds.'), { status: 429 });
  providerLastRequestAt.set(provider, Date.now());
  const stamp = now();
  if (provider === 'bitget') {
    const ticker = await withExchange('bitget', { privateAccess: false }, (exchange) => exchange.fetchTicker(symbol));
    return normalizeProviderQuote(provider, symbol, ticker, stamp);
  }
  if (provider === 'finnhub') {
    const key = requireKey('JPTI_FINNHUB_API_KEY', 'Finnhub');
    const url = new URL('https://finnhub.io/api/v1/quote');
    url.search = new URLSearchParams({ symbol, token: key }).toString();
    return normalizeProviderQuote(provider, symbol, await requestJson(url), stamp);
  }
  if (provider === 'alphavantage') {
    const key = requireKey('JPTI_ALPHAVANTAGE_API_KEY', 'Alpha Vantage');
    const url = new URL('https://www.alphavantage.co/query');
    url.search = new URLSearchParams({ function: 'GLOBAL_QUOTE', symbol, apikey: key }).toString();
    const data = await requestJson(url);
    if (data.Note || data.Information) throw Object.assign(new Error(data.Note || data.Information), { status: 429 });
    return normalizeProviderQuote(provider, symbol, data, stamp);
  }
  if (provider === 'twelvedata') {
    const key = requireKey('JPTI_TWELVEDATA_API_KEY', 'Twelve Data');
    const url = new URL('https://api.twelvedata.com/quote');
    url.search = new URLSearchParams({ symbol, apikey: key }).toString();
    const data = await requestJson(url);
    if (data.status === 'error') throw new Error(data.message || 'Twelve Data quote failed');
    return normalizeProviderQuote(provider, symbol, data, stamp);
  }
  if (provider === 'alpaca') {
    const key = requireKey('JPTI_ALPACA_API_KEY', 'Alpaca');
    const secret = requireKey('JPTI_ALPACA_API_SECRET', 'Alpaca');
    const url = new URL('https://data.alpaca.markets/v2/stocks/' + encodeURIComponent(symbol) + '/quotes/latest');
    url.search = new URLSearchParams({ feed: 'iex' }).toString();
    const data = await requestJson(url, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } });
    return normalizeProviderQuote(provider, symbol, data, stamp);
  }
  return null;
}

providerRouter.get('/providers/consensus/quote/:symbol', async (req, res) => {
  const symbol = safeSymbol(req.params.symbol);
  const cacheKey = symbol.toUpperCase();
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < quoteCacheTtlMs) {
    return res.json({ ...cached.payload, cache: 'hit' });
  }
  const candidates = [
    ['bitget', process.env.JPTI_ENABLE_BITGET_CONSENSUS !== 'false'],
    ['finnhub', Boolean(process.env.JPTI_FINNHUB_API_KEY)],
    ['alphavantage', Boolean(process.env.JPTI_ALPHAVANTAGE_API_KEY && process.env.JPTI_ENABLE_ALPHAVANTAGE_CONSENSUS === 'true')],
    ['twelvedata', Boolean(process.env.JPTI_TWELVEDATA_API_KEY)],
    ['alpaca', Boolean(process.env.JPTI_ALPACA_API_KEY && process.env.JPTI_ALPACA_API_SECRET)]
  ].filter(([, configured]) => configured).map(([id]) => id);
  const results = await Promise.all(candidates.map(async (provider) => {
    try {
      const quote = await quoteSource(provider, symbol);
      return quote ? { provider, status: 'ok', quote } : { provider, status: 'no-quote', error: 'Provider returned no usable price.' };
    } catch (error) {
      return { provider, status: 'error', error: error.message, httpStatus: error.status || 502 };
    }
  }));
  const observations = results.filter((item) => item.quote).map((item) => item.quote);
  const consensus = buildQuoteConsensus(symbol, observations);
  const payload = { ...consensus, providerResults: results.map(({ provider, status, error, httpStatus }) => ({ provider, status, ...(error ? { error } : {}), ...(httpStatus ? { httpStatus } : {}) })),
    cache: 'miss', cacheTtlMs: quoteCacheTtlMs,
    note: candidates.length ? 'Only configured providers were queried. Provider errors and plan restrictions remain visible.' : 'No quote providers are configured. Add server-side provider credentials to enable cross-provider checks.' };
  quoteCache.set(cacheKey, { createdAt: Date.now(), payload });
  if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value);
  res.json(payload);
});
