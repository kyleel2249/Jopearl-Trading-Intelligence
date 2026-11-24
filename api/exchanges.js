import ccxt from 'ccxt';

export const SUPPORTED_EXCHANGES = ccxt.exchanges.filter((id) => typeof ccxt[id] === 'function');

const envKey = (id, suffix) => `JPTI_${id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_${suffix}`;

export function exchangeConnectionStatus(id) {
  if (!SUPPORTED_EXCHANGES.includes(id)) return { supported: false, configured: false };
  return {
    supported: true,
    configured: Boolean(process.env[envKey(id, 'API_KEY')] && process.env[envKey(id, 'API_SECRET')]),
    hasPassword: Boolean(process.env[envKey(id, 'PASSWORD')])
  };
}

export function createExchange(id, { privateAccess = false } = {}) {
  if (!SUPPORTED_EXCHANGES.includes(id)) {
    throw Object.assign(new Error('Exchange is not in the supported exchange catalog.'), { status: 404 });
  }
  const ExchangeClass = ccxt[id];
  if (!ExchangeClass) throw Object.assign(new Error('Exchange adapter is unavailable in this CCXT build.'), { status: 503 });

  const config = {
    enableRateLimit: true,
    timeout: Number(process.env.JPTI_EXCHANGE_TIMEOUT_MS || 15000),
    options: { defaultType: 'spot' }
  };
  if (privateAccess) {
    const apiKey = process.env[envKey(id, 'API_KEY')];
    const secret = process.env[envKey(id, 'API_SECRET')];
    if (!apiKey || !secret) {
      throw Object.assign(new Error(`Server-side API credentials are not configured for ${id}.`), { status: 409 });
    }
    config.apiKey = apiKey;
    config.secret = secret;
    const password = process.env[envKey(id, 'PASSWORD')];
    if (password) config.password = password;
    const uid = process.env[envKey(id, 'UID')];
    if (uid) config.uid = uid;
  }
  return new ExchangeClass(config);
}

// Reuse one CCXT client per venue/access mode. Refresh its market catalogue on a
// bounded TTL: otherwise CCXT's in-memory loadMarkets cache can keep delisted or
// newly-listed instruments stale for the lifetime of a long-running API process.
const MARKET_CACHE_TTL_MS = Math.max(30_000, Number(process.env.JPTI_MARKET_CACHE_TTL_MS) || 5 * 60_000);
const MARKET_REFRESH_RETRY_MS = 30_000;
export function isMarketCacheStale(loadedAt, now = Date.now(), ttlMs = MARKET_CACHE_TTL_MS) {
  return !Number.isFinite(loadedAt) || loadedAt <= 0 || now - loadedAt >= ttlMs;
}
const exchangeClients = new Map();

async function getReadyExchange(id, options = {}) {
  const privateAccess = options.privateAccess === true;
  const cacheKey = id + ':' + (privateAccess ? 'private' : 'public');
  let entry = exchangeClients.get(cacheKey);
  if (!entry) {
    const exchange = createExchange(id, options);
    entry = { exchange, ready: exchange.loadMarkets(), loadedAt: 0, refreshing: null, retryAfter: 0, lastRefreshError: null };
    exchangeClients.set(cacheKey, entry);
    try {
      await entry.ready;
      entry.loadedAt = Date.now();
    } catch (error) {
      if (exchangeClients.get(cacheKey) === entry) exchangeClients.delete(cacheKey);
      try { await exchange.close?.(); } catch { /* Preserve the original market-load error. */ }
      throw error;
    }
  } else {
    await entry.ready;
    if (!entry.loadedAt) entry.loadedAt = Date.now();
  }

  // Concurrent requests share one refresh. A transient exchange outage does not
  // take working cached markets offline; retry is throttled and the last known
  // catalogue remains available until a refresh succeeds.
  if (isMarketCacheStale(entry.loadedAt) && Date.now() >= entry.retryAfter) {
    if (!entry.refreshing) {
      entry.refreshing = entry.exchange.loadMarkets(true)
        .then(() => { entry.loadedAt = Date.now(); entry.lastRefreshError = null; entry.retryAfter = 0; })
        .catch((error) => {
          entry.lastRefreshError = error?.message || 'Market catalogue refresh failed.';
          entry.retryAfter = Date.now() + MARKET_REFRESH_RETRY_MS;
        })
        .finally(() => { entry.refreshing = null; });
    }
    await entry.refreshing;
  }
  return entry.exchange;
}

export async function withExchange(id, options, operation) {
  const exchange = await getReadyExchange(id, options);
  return operation(exchange);
}

export async function closeExchangeClients() {
  const entries = [...exchangeClients.values()];
  exchangeClients.clear();
  await Promise.allSettled(entries.map(async ({ exchange, refreshing }) => {
    if (refreshing) await refreshing;
    await exchange.close?.();
  }));
}

export function classifyMarket(market) {
  const type = String(market.type || '').toLowerCase();
  const info = market.info || {};
  const margin = market.margin === true || info.isMarginTradingAllowed === true || info.marginTrading === true;
  const cfd = market.cfd === true || type === 'cfd';
  const categories = [];
  if (market.spot === true) categories.push('spot');
  if (market.swap === true) categories.push('perpetual');
  if (market.future === true) categories.push('futures');
  if (market.option === true) categories.push('options');
  if (margin) categories.push('margin');
  if (cfd) categories.push('cfd');
  return { categories, type: type || (market.spot ? 'spot' : 'unknown'), contract: market.contract === true, linear: market.linear === true, inverse: market.inverse === true, settle: market.settle || null };
}

/**
 * Product filter used by the markets route. Keeps the existing category semantics ('futures' also matches perpetuals) and
 * adds the settlement-based products the chart's product selector offers: Coin-M (inverse contracts) and USDC-M (USDC-settled linear).
 */
export function matchesProductType(market, requestedType) {
  const type = String(requestedType || 'all').toLowerCase();
  if (type === 'all') return true;
  const categories = Array.isArray(market.categories) ? market.categories : classifyMarket(market).categories;
  const derivative = market.swap === true || market.future === true;
  if (type === 'coin-futures') return derivative && market.contract === true && market.inverse === true;
  if (type === 'usdc-futures') return derivative && market.contract === true && market.linear === true && String(market.settle || '').toUpperCase() === 'USDC';
  return categories.includes(type) || (type === 'futures' && categories.includes('perpetual'));
}

export function listExchangeCatalog() {
  return SUPPORTED_EXCHANGES.map((id) => ({
    id,
    name: ccxt[id].name || id,
    configured: exchangeConnectionStatus(id).configured,
    capabilities: {
      ticker: Boolean(ccxt[id].has?.fetchTicker),
      orderBook: Boolean(ccxt[id].has?.fetchOrderBook),
      ohlcv: Boolean(ccxt[id].has?.fetchOHLCV),
      balance: Boolean(ccxt[id].has?.fetchBalance),
      createOrder: Boolean(ccxt[id].has?.createOrder),
      fetchMarkets: Boolean(ccxt[id].has?.fetchMarkets),
      fetchFundingRate: Boolean(ccxt[id].has?.fetchFundingRate),
      fetchPositions: Boolean(ccxt[id].has?.fetchPositions),
      fetchLeverage: Boolean(ccxt[id].has?.fetchLeverage),
      fetchMarginMode: Boolean(ccxt[id].has?.fetchMarginMode)
    }
  }));
}
