// Browser-direct market data: a last-resort provider that answers the JPTI API's public market-data
// routes straight from the exchanges' public REST endpoints, so the dashboard keeps working when the
// JPTI API is unreachable (static hosting, a sleeping or missing server, a native WebView with no backend).
//
// Scope (deliberately limited, never pretending to be the full API):
//   GET /api/health                              -> a "direct mode" status (never claims the API is up)
//   GET /api/exchanges                           -> catalog of the supported venues
//   GET /api/exchanges/:id/markets               -> public instrument catalog (Bitget spot/margin/derivatives; spot for other direct venues)
//   GET /api/exchanges/:id/ticker/:symbol        -> same fields as the API
//   GET /api/exchanges/:id/ohlcv/:symbol         -> same fields as the API
// Everything else (ledger, trading, private/signed calls, analytics) still requires the real API.
// Responses carry `source: 'browser-direct'`. Public endpoints only: no keys, no signing, no orders.
//
// NOT verified against the live exchanges from the build sandbox (no network): the parsers follow each
// exchange's published public-API format and are covered by unit tests with representative payloads.

export const DIRECT_EXCHANGES = ['binance', 'bybit', 'okx', 'bitget'];
export const DIRECT_SOURCE = 'browser-direct';

export class DirectError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'DirectError'; this.status = status; }
}

const NAMES = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', bitget: 'Bitget' };
const HOSTS = { binance: 'https://api.binance.com', bybit: 'https://api.bybit.com', okx: 'https://www.okx.com', bitget: 'https://api.bitget.com' };

const FRAMES = {
  binance: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h', '1d': '1d', '3d': '3d', '1w': '1w', '1M': '1M' },
  bybit: { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1d': 'D', '1w': 'W', '1M': 'M' },
  okx: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W', '1M': '1M' },
  bitget: { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D' }
};

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function parseSymbol(raw) {
  const text = decodeURIComponent(String(raw || '')).toUpperCase();
  const [pairPart, settlePart, ...rest] = text.split(':');
  const normalizedPair = pairPart.includes('/') ? pairPart : pairPart.replace('-', '/');
  const [base, quote, ...pairRest] = normalizedPair.split('/');
  const settle = settlePart || null;
  if (rest.length || pairRest.length || !/^[A-Z0-9]{2,20}$/.test(base || '') || !/^[A-Z0-9]{2,20}$/.test(quote || '') || (settle && !/^[A-Z0-9]{2,20}$/.test(settle))) {
    throw new DirectError('Invalid market symbol. Use BASE/QUOTE for spot or BASE/QUOTE:SETTLE for contracts.', 400);
  }
  return { base, quote, ...(settle ? { settle } : {}), symbol: base + '/' + quote + (settle ? ':' + settle : '') };
}

export const venueSymbol = (exchange, { base, quote, instrumentId }) => exchange === 'okx' ? base + '-' + quote : exchange === 'bitget' && instrumentId ? instrumentId : base + quote;

const BITGET_MARKET_TYPE_ALIASES = Object.freeze({
  spot: 'spot',
  margin: 'margin',
  futures: 'futures', perpetual: 'perpetual',
  'usdt-m': 'usdt-futures', 'usdt-m-futures': 'usdt-futures', 'usdt-futures': 'usdt-futures',
  'coin-m': 'coin-futures', 'coin-m-futures': 'coin-futures',
  'usdc-m': 'usdc-futures', 'usdc-m-futures': 'usdc-futures',
  'coin-futures': 'coin-futures', 'usdc-futures': 'usdc-futures',
  all: 'all'
});
export function normalizeBitgetMarketType(value = 'spot') {
  const key = String(value || 'spot').trim().toLowerCase();
  return BITGET_MARKET_TYPE_ALIASES[key] || key;
}
const BITGET_CATEGORIES = Object.freeze({
  spot: 'SPOT', margin: 'SPOT',
  futures: 'USDT-FUTURES', perpetual: 'USDT-FUTURES',
  'usdt-futures': 'USDT-FUTURES', 'usdt-m': 'USDT-FUTURES', 'usdt-m-futures': 'USDT-FUTURES',
  'coin-futures': 'COIN-FUTURES', 'coin-m': 'COIN-FUTURES', 'coin-m-futures': 'COIN-FUTURES',
  'usdc-futures': 'USDC-FUTURES', 'usdc-m': 'USDC-FUTURES', 'usdc-m-futures': 'USDC-FUTURES'
});
const BITGET_TIMEFRAMES = Object.freeze({ '1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','4h':'4H','6h':'6H','12h':'12H','1d':'1D' });
const marketTypeOf = (market) => market.contract ? (market.swap ? 'perpetual' : 'futures') : market.margin ? 'margin' : 'spot';

// ---------------------------------------------------------------------------
// Parsers (pure): venue payload -> JPTI API shape
// ---------------------------------------------------------------------------
function isoOrNull(ms) { return ms ? new Date(ms).toISOString() : null; }

const TICKER_PARSERS = {
  binance(p) {
    if (!p || p.lastPrice === undefined) throw new DirectError('Unknown market symbol.', 404);
    return { timestamp: num(p.closeTime), last: num(p.lastPrice), bid: num(p.bidPrice), ask: num(p.askPrice), high: num(p.highPrice), low: num(p.lowPrice), baseVolume: num(p.volume), quoteVolume: num(p.quoteVolume), percentage: num(p.priceChangePercent) };
  },
  bybit(p) {
    if (p?.retCode !== 0) throw new DirectError(p?.retMsg || 'Bybit rejected the request.', 404);
    const t = p.result?.list?.[0];
    if (!t) throw new DirectError('Unknown market symbol.', 404);
    const pct = num(t.price24hPcnt);
    return { timestamp: num(p.time), last: num(t.lastPrice), bid: num(t.bid1Price), ask: num(t.ask1Price), high: num(t.highPrice24h), low: num(t.lowPrice24h), baseVolume: num(t.volume24h), quoteVolume: num(t.turnover24h), percentage: pct === null ? null : pct * 100 };
  },
  okx(p) {
    if (String(p?.code) !== '0') throw new DirectError(p?.msg || 'OKX rejected the request.', 404);
    const t = p.data?.[0];
    if (!t) throw new DirectError('Unknown market symbol.', 404);
    const last = num(t.last), open = num(t.open24h);
    return { timestamp: num(t.ts), last, bid: num(t.bidPx), ask: num(t.askPx), high: num(t.high24h), low: num(t.low24h), baseVolume: num(t.vol24h), quoteVolume: num(t.volCcy24h), percentage: last !== null && open ? (last - open) / open * 100 : null };
  },
  bitget(p) {
    if (String(p?.code) !== '00000') throw new DirectError(p?.msg || 'Bitget rejected the request.', 404);
    const t = Array.isArray(p.data) ? p.data[0] : p.data;
    if (!t) throw new DirectError('Unknown Bitget market symbol.', 404);
    const last = num(t.lastPrice ?? t.lastPr ?? t.close);
    const open = num(t.openPrice24h ?? t.open24h);
    const pct = num(t.price24hPcnt ?? t.change24h);
    return { timestamp: num(t.ts ?? p.requestTime), last, bid: num(t.bid1Price ?? t.bidPr), ask: num(t.ask1Price ?? t.askPr), high: num(t.highPrice24h ?? t.high24h), low: num(t.lowPrice24h ?? t.low24h), baseVolume: num(t.volume24h ?? t.baseVolume), quoteVolume: num(t.turnover24h ?? t.quoteVolume), percentage: pct === null ? (last !== null && open ? ((last - open) / open) * 100 : null) : Math.abs(pct) <= 1 ? pct * 100 : pct };
  }
};

const rowsToCandles = (rows) => {
  const candles = (Array.isArray(rows) ? rows : [])
    .map((r) => [num(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4]), num(r[5])])
    .filter((r) => r.every((v) => v !== null) && r[2] >= r[3]);
  candles.sort((a, b) => a[0] - b[0]);
  if (!candles.length) throw new DirectError('No candles returned for this market.', 404);
  return candles;
};

const CANDLE_PARSERS = {
  binance: (p) => rowsToCandles(p),
  bybit(p) {
    if (p?.retCode !== 0) throw new DirectError(p?.retMsg || 'Bybit rejected the request.', 404);
    return rowsToCandles(p.result?.list);
  },
  okx(p) {
    if (String(p?.code) !== '0') throw new DirectError(p?.msg || 'OKX rejected the request.', 404);
    return rowsToCandles(p.data);
  },
  bitget(p) {
    if (String(p?.code) !== '00000') throw new DirectError(p?.msg || 'Bitget rejected the request.', 404);
    return rowsToCandles(p.data);
  }
};

const MARKET_PARSERS = {
  binance: (p) => (p?.symbols || []).filter((s) => s.status === 'TRADING').map((s) => ({ id: s.symbol, base: s.baseAsset, quote: s.quoteAsset })),
  bybit: (p) => (p?.result?.list || []).filter((s) => s.status === 'Trading').map((s) => ({ id: s.symbol, base: s.baseCoin, quote: s.quoteCoin })),
  okx: (p) => (p?.data || []).filter((s) => s.state === 'live').map((s) => ({ id: s.instId, base: s.baseCcy, quote: s.quoteCcy })),
  bitget: (p) => (p?.data || []).filter((s) => s.status === 'online').map((s) => ({ id: s.symbol, base: s.baseCoin, quote: s.quoteCoin, category: s.category, contractType: s.type, settle: s.settleCoin || (s.category === 'COIN-FUTURES' ? s.baseCoin : s.quoteCoin), pricePrecision: s.pricePrecision, quantityPrecision: s.quantityPrecision, minOrderQty: s.minOrderQty, maxLeverage: s.maxLeverage, instrumentType: s.instrumentType }))
};

export const parsers = { ticker: TICKER_PARSERS, candles: CANDLE_PARSERS, markets: MARKET_PARSERS };
const BITGET_V2_CATALOG_PATHS = Object.freeze({
  SPOT: '/api/v2/spot/public/symbols',
  MARGIN: '/api/v2/margin/currencies',
  'USDT-FUTURES': '/api/v2/mix/market/contracts?productType=USDT-FUTURES',
  'COIN-FUTURES': '/api/v2/mix/market/contracts?productType=COIN-FUTURES',
  'USDC-FUTURES': '/api/v2/mix/market/contracts?productType=USDC-FUTURES'
});
async function fetchBitgetInstrumentCategory(category, options) {
  const primary = HOSTS.bitget + '/api/v3/market/instruments?category=' + encodeURIComponent(category);
  try {
    const payload = await getJson(primary, { ...options, retry404: true });
    if (String(payload?.code) !== '00000') throw new DirectError(payload?.msg || 'Bitget v3 instruments failed for ' + category + '.', 502);
    return { payload, apiVersion: 'v3' };
  } catch (primaryError) {
    const fallbackPath = BITGET_V2_CATALOG_PATHS[category];
    if (!fallbackPath) throw primaryError;
    try {
      const payload = await getJson(HOSTS.bitget + fallbackPath, { ...options, retry404: true });
      if (String(payload?.code) !== '00000') throw new DirectError(payload?.msg || 'Bitget v2 catalog fallback failed for ' + category + '.', 502);
      return { payload, apiVersion: 'v2' };
    } catch (fallbackError) {
      throw new DirectError(
        String(primaryError?.message || primaryError).slice(0, 120) +
        '; v2 fallback failed: ' + String(fallbackError?.message || fallbackError).slice(0, 120),
        fallbackError?.status || primaryError?.status || 502
      );
    }
  }
}

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------
export function tickerUrl(exchange, sym) {
  const s = venueSymbol(exchange, sym);
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/ticker/24hr?symbol=' + s;
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/tickers?category=spot&symbol=' + s;
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/market/ticker?instId=' + s;
  const category = BITGET_CATEGORIES[String(sym.marketType || 'spot').toLowerCase()] || 'SPOT';
  return HOSTS.bitget + '/api/v3/market/tickers?category=' + encodeURIComponent(category) + '&symbol=' + encodeURIComponent(s);
}

export function candlesUrl(exchange, sym, timeframe, limit, endTime = null) {
  const frame = FRAMES[exchange]?.[timeframe];
  if (!frame) throw new DirectError('Unsupported timeframe: ' + timeframe, 400);
  const s = venueSymbol(exchange, sym);
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/klines?symbol=' + s + '&interval=' + frame + '&limit=' + Math.min(limit, 1000);
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/kline?category=spot&symbol=' + s + '&interval=' + frame + '&limit=' + Math.min(limit, 1000);
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/market/candles?instId=' + s + '&bar=' + frame + '&limit=' + Math.min(limit, 300);
  const category = BITGET_CATEGORIES[String(sym.marketType || 'spot').toLowerCase()] || 'SPOT';
  const bitgetFrame = BITGET_TIMEFRAMES[timeframe];
  if (!bitgetFrame) throw new DirectError('Bitget does not support timeframe ' + timeframe + '.', 400);
  return HOSTS.bitget + '/api/v3/market/history-candles?category=' + encodeURIComponent(category) + '&symbol=' + encodeURIComponent(s) + '&interval=' + encodeURIComponent(bitgetFrame) + '&limit=' + Math.min(limit, 100) + (endTime === null ? '' : '&endTime=' + encodeURIComponent(String(endTime)));
}

export function marketsUrl(exchange) {
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/exchangeInfo';
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/instruments-info?category=spot';
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/public/instruments?instType=SPOT';
  return HOSTS.bitget + '/api/v3/market/instruments?category=SPOT';
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------
export function matchDirectRoute(path, method = 'GET') {
  if (String(method).toUpperCase() !== 'GET') return null;
  const raw = String(path || '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // absolute URLs are never rerouted
  const [pathname, queryString = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString));
  const clean = pathname.replace(/\/+$/, '');
  if (clean === '/api/health') return { kind: 'health', query };
  if (clean === '/api/exchanges') return { kind: 'catalog', query };
  if (clean === '/api/exchanges/compare/ticker') return { kind: 'compare', query };
  let m = clean.match(/^\/api\/exchanges\/([a-z0-9_]+)\/(ticker|ohlcv)\/([^/]+)$/i);
  if (m) return { kind: m[2].toLowerCase(), exchange: m[1].toLowerCase(), symbol: m[3], query };
  m = clean.match(/^\/api\/exchanges\/([a-z0-9_]+)\/markets$/i);
  if (m) return { kind: 'markets', exchange: m[1].toLowerCase(), query };
  return null;
}

export const isDirectCapable = (path, method = 'GET') => matchDirectRoute(path, method) !== null;

// ---------------------------------------------------------------------------
// Fetching with timeout, failover and micro-caching
// ---------------------------------------------------------------------------
const CACHE_TTL = { ticker: 3000, ohlcv: 10000, markets: 10 * 60000 };

// Bitget (and some other venues) answer HTTP 403 to requests that carry no User-Agent, which is
// exactly what a Cloudflare Worker sends by default, and to datacentre egress that trips their WAF.
// Server-side runtimes therefore identify themselves, and a blocked or throttled response is retried
// once on an alternate API host before it is reported. Browsers forbid overriding User-Agent, so it is
// only set outside a window context.
const IS_BROWSER = typeof window !== 'undefined' && typeof window.document !== 'undefined';
const SERVER_USER_AGENT = 'Mozilla/5.0 (compatible; JPTI-MarketData/1.0; +https://github.com/kyleel2249/Jopearl-Trading-Intelligence)';
const ALTERNATE_HOSTS = { 'https://api.bitget.com': ['https://capi.bitget.com', 'https://api.bitgetapi.com'] };
const RETRYABLE_STATUS = new Set([403, 429, 451, 502, 503, 504]);

function alternateUrls(url) {
  for (const [host, alternates] of Object.entries(ALTERNATE_HOSTS)) {
    if (url.startsWith(host + '/')) return alternates.map((alt) => alt + url.slice(host.length));
  }
  return [];
}

async function fetchJsonOnce(url, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const headers = { accept: 'application/json' };
    if (!IS_BROWSER) { headers['user-agent'] = SERVER_USER_AGENT; headers['accept-language'] = 'en-US,en;q=0.9'; }
    const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', signal: controller.signal, headers });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = String(payload?.msg || payload?.message || payload?.error || '').trim().slice(0, 180);
      const error = new DirectError('Exchange answered HTTP ' + response.status + (detail ? ': ' + detail : '.'), response.status === 404 ? 404 : 502);
      error.upstreamStatus = response.status;
      throw error;
    }
    if (payload === null) throw new DirectError('Exchange returned an invalid JSON response.', 502);
    return payload;
  } catch (error) {
    if (error instanceof DirectError) throw error;
    throw new DirectError(error && error.name === 'AbortError' ? 'The exchange did not answer in time.' : 'The exchange could not be reached from this runtime.', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function getJson(url, options = {}) {
  const { fetchImpl, signal, timeoutMs = 7000, retry404 = false } = options;
  let firstError = null;
  for (const candidate of [url, ...alternateUrls(url)]) {
    try {
      return await fetchJsonOnce(candidate, { fetchImpl, signal, timeoutMs });
    } catch (error) {
      if (signal?.aborted) throw error;
      firstError = firstError || error;
      const retryable = !error.upstreamStatus || RETRYABLE_STATUS.has(error.upstreamStatus) || (retry404 && error.upstreamStatus === 404);
      if (!retryable) throw error;
    }
  }
  if (firstError && firstError.upstreamStatus === 403) {
    firstError.message += ' (Blocked by the exchange for this runtime; alternate hosts were tried and the last stored snapshot is served when one exists.)';
  }
  throw firstError;
}

export function createDirectProvider({ fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  const cache = new Map();

  const cached = async (key, ttl, producer) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value;
    const value = await producer();
    cache.set(key, { at: now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  };

  const order = (requested) => [...new Set([DIRECT_EXCHANGES.includes(requested) ? requested : null, ...DIRECT_EXCHANGES].filter(Boolean))];

  // Try each venue in turn; the first that answers wins. The response says which venue served it.
  async function withFailover(requested, attempt, signal, allowFailover = true) {
    let lastError = null;
    for (const venue of (allowFailover ? order(requested) : [requested])) {
      if (signal && signal.aborted) throw new DirectError('The request was cancelled.', 499);
      try {
        const value = await attempt(venue);
        return { venue, value, failedOver: venue !== requested, requested };
      } catch (error) {
        lastError = error;
        if (error instanceof DirectError && error.status === 400) throw error; // bad request: other venues will not help
      }
    }
    throw lastError || new DirectError('No exchange answered.', 502);
  }

  async function handle(route, { signal } = {}) {
    const opts = { fetchImpl: doFetch, signal };
    switch (route.kind) {
      case 'health':
        return { status: 200, body: { status: 'degraded', service: 'JPTI Browser Direct', directMode: true, source: DIRECT_SOURCE, mode: 'direct', liveTradingEnabled: false, localPrivateAccess: false, desktopInstanceId: null, note: 'The JPTI API is unreachable. Showing public exchange market data directly. Trading, ledger and analytics need the API.', timestamp: new Date(now()).toISOString() } };
      case 'catalog':
        return { status: 200, body: { adapter: 'browser-direct', source: DIRECT_SOURCE, count: DIRECT_EXCHANGES.length, exchanges: DIRECT_EXCHANGES.map((id) => ({ id, name: NAMES[id], configured: false, capabilities: { ticker: true, orderBook: false, ohlcv: true, balance: false, createOrder: false, fetchMarkets: true, fetchFundingRate: false, fetchPositions: false, fetchLeverage: false, fetchMarginMode: false }, productTypes: id === 'bitget' ? ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures'] : ['spot'], unsupportedProductTypes: id === 'bitget' ? ['cfd', 'options'] : ['futures', 'margin', 'cfd', 'options'] })) } };
      case 'compare': {
        const sym = parseSymbol(route.query.symbol || 'BTC/USDT');
        const requested = String(route.query.exchanges || DIRECT_EXCHANGES.join(',')).split(',').map((id) => id.trim().toLowerCase()).filter(Boolean);
        const venues = [...new Set(requested)].filter((id) => DIRECT_EXCHANGES.includes(id)).slice(0, 6);
        if (!venues.length) throw new DirectError('Select at least one supported direct-data exchange.', 400);
        const results = await Promise.all(venues.map(async (venue) => {
          try {
            const ticker = await cached('t:' + venue + sym.symbol, CACHE_TTL.ticker, async () => {
              const value = TICKER_PARSERS[venue](await getJson(tickerUrl(venue, sym), opts));
              if (value.last === null) throw new DirectError('The exchange returned no price.', 502);
              return value;
            });
            return { exchange: venue, status: 'ok', observation: {
              exchange: venue, symbol: sym.symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask,
              baseVolume: ticker.baseVolume, quoteVolume: ticker.quoteVolume, percentage: ticker.percentage,
              timestamp: isoOrNull(ticker.timestamp)
            } };
          } catch (error) {
            return { exchange: venue, status: 'error', error: error.message || 'Ticker unavailable.', httpStatus: error.status || 502 };
          }
        }));
        const observations = results.filter((item) => item.observation).map((item) => item.observation);
        const sorted = observations.map((item) => item.last).filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
        const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
        const crossVenuePairs = observations.filter((item) => Number.isFinite(item.ask) && item.ask > 0).flatMap((ask) => observations
          .filter((bid) => bid.exchange !== ask.exchange && Number.isFinite(bid.bid) && bid.bid > 0)
          .map((bid) => ({ buyVenue: ask.exchange, ask: ask.ask, sellVenue: bid.exchange, bid: bid.bid, grossEdgePercent: ((bid.bid - ask.ask) / ask.ask) * 100 })));
        crossVenuePairs.sort((a, b) => b.grossEdgePercent - a.grossEdgePercent);
        const threshold = 0.5;
        const venuesWithContext = observations.map((item) => ({ ...item,
          deviationFromMedianPercent: median ? ((item.last - median) / median) * 100 : null,
          outlier: observations.length >= 3 && median ? Math.abs((item.last - median) / median) * 100 > threshold : false
        }));
        return { status: 200, body: {
          symbol: sym.symbol, generatedAt: new Date(now()).toISOString(), venueCount: observations.length, medianLast: median,
          lastPriceSpreadPercent: sorted.length > 1 && median ? ((sorted[sorted.length - 1] - sorted[0]) / median) * 100 : null,
          bestIndicativeTopOfBook: crossVenuePairs[0] || null, venues: venuesWithContext,
          results: results.map(({ exchange, status, error, httpStatus }) => ({ exchange, status, ...(error ? { error } : {}), ...(httpStatus ? { httpStatus } : {}) })),
          cache: 'direct', cacheTtlMs: CACHE_TTL.ticker, source: DIRECT_SOURCE,
          note: 'Public exchange tickers only. No private keys or orders are used. Direct mode is indicative and excludes fees, depth, slippage and latency.',
          caveats: ['Top-of-book comparison is indicative only; it excludes trading fees, funding, slippage, latency, queue position, transfer costs and venue-specific restrictions.', 'Displayed bid/ask sizes are not modeled. A positive gross edge is not proof of an executable arbitrage.', 'Only venues that returned a valid ticker are included; market symbols and quote conventions must match.']
        } };
      }
      case 'ticker': {
        if (!DIRECT_EXCHANGES.includes(route.exchange)) throw new DirectError('Direct mode does not support ' + route.exchange + '.', 404);
        const marketType = normalizeBitgetMarketType(route.query.type || 'spot');
        const sym = parseSymbol(route.symbol);
        const instrumentId = String(route.query.instrumentId || '').trim().toUpperCase();
        if (route.exchange === 'bitget' && marketType === 'cfd') throw new DirectError('Bitget CFD data must be requested through the authenticated Cloudflare Pages Function. Configure the Bitget read-only UTA secrets in Cloudflare.', 503);
        if (instrumentId && !/^[A-Z0-9_]{2,40}$/.test(instrumentId)) throw new DirectError('Invalid Bitget instrument ID.', 400);
        if (route.exchange === 'bitget' && instrumentId) sym.instrumentId = instrumentId;
        sym.marketType = marketType;
        const allowFailover = String(route.query.failover || 'true').toLowerCase() !== 'false' && !(route.exchange === 'bitget' && (marketType !== 'spot' || !IS_BROWSER));
        const r = await withFailover(route.exchange, (venue) => cached('t:' + venue + ':' + marketType + ':' + sym.symbol + ':' + (sym.instrumentId || ''), CACHE_TTL.ticker, async () => {
          const t = TICKER_PARSERS[venue](await getJson(tickerUrl(venue, sym), opts));
          if (t.last === null) throw new DirectError('The exchange returned no price.', 502);
          return t;
        }), signal, allowFailover);
        const t = r.value;
        return { status: 200, body: { exchange: r.venue, symbol: sym.symbol, timestamp: t.timestamp, datetime: isoOrNull(t.timestamp), last: t.last, bid: t.bid, ask: t.ask, high: t.high, low: t.low, baseVolume: t.baseVolume, quoteVolume: t.quoteVolume, percentage: t.percentage, source: DIRECT_SOURCE, requestedExchange: r.requested, failedOver: r.failedOver } };
      }
      case 'ohlcv': {
        if (!DIRECT_EXCHANGES.includes(route.exchange)) throw new DirectError('Direct mode does not support ' + route.exchange + '.', 404);
        const marketType = String(route.query.type || 'spot').toLowerCase();
        if (route.exchange === 'bitget' && marketType === 'cfd') throw new DirectError('Bitget CFD data must be requested through the authenticated Cloudflare Pages Function. Configure the Bitget read-only UTA secrets in Cloudflare.', 503);
        const sym = parseSymbol(route.symbol);
        const instrumentId = String(route.query.instrumentId || '').trim().toUpperCase();
        if (instrumentId && !/^[A-Z0-9_]{2,40}$/.test(instrumentId)) throw new DirectError('Invalid Bitget instrument ID.', 400);
        if (route.exchange === 'bitget' && instrumentId) sym.instrumentId = instrumentId;
        sym.marketType = marketType;
        const timeframe = String(route.query.timeframe || '1h');
        const limit = Math.min(500, Math.max(20, Number.parseInt(route.query.limit || '120', 10) || 120));
        const allowFailover = String(route.query.failover || 'true').toLowerCase() !== 'false' && !(route.exchange === 'bitget' && (marketType !== 'spot' || !IS_BROWSER));
        const r = await withFailover(route.exchange, (venue) => cached('c:' + venue + ':' + marketType + ':' + sym.symbol + ':' + (sym.instrumentId || '') + ':' + timeframe + ':' + limit, CACHE_TTL.ohlcv, async () => {
          if (venue !== 'bitget') {
            const rows = CANDLE_PARSERS[venue](await getJson(candlesUrl(venue, sym, timeframe, limit), opts));
            return rows.slice(-limit);
          }
          const merged = new Map();
          let endTime = null;
          const maxPages = Math.min(5, Math.ceil(limit / 100));
          for (let page = 0; page < maxPages && merged.size < limit; page += 1) {
            const pageLimit = Math.min(100, limit - merged.size);
            const payload = await getJson(candlesUrl('bitget', sym, timeframe, pageLimit, endTime), opts);
            const rows = CANDLE_PARSERS.bitget(payload);
            for (const row of rows) merged.set(row[0], row);
            const oldest = rows[0]?.[0];
            if (!Number.isFinite(oldest) || rows.length < pageLimit || (endTime !== null && oldest >= endTime)) break;
            endTime = oldest - 1;
          }
          const rows = [...merged.values()].sort((a, b) => a[0] - b[0]);
          if (!rows.length) throw new DirectError('Bitget returned no historical candles for this market.', 404);
          return rows.slice(-limit);
        }), signal, allowFailover);
        return { status: 200, body: { exchange: r.venue, symbol: sym.symbol, timeframe, candles: r.value, source: DIRECT_SOURCE, requestedExchange: r.requested, failedOver: r.failedOver } };
      }
      case 'markets': {
        const id = route.exchange;
        if (!DIRECT_EXCHANGES.includes(id)) throw new DirectError('Direct mode does not support ' + id + '.', 404);
        const type = normalizeBitgetMarketType(route.query.type || 'all');
        if (id === 'bitget' && type === 'cfd') throw new DirectError('Bitget CFD instruments require the authenticated Cloudflare Pages Function. Configure the Bitget read-only UTA secrets in Cloudflare.', 503);
        const search = String(route.query.search || '').trim().toLowerCase().slice(0, 60);
        const all = await cached('m:' + id, CACHE_TTL.markets, async () => {
          if (id !== 'bitget') return MARKET_PARSERS[id](await getJson(marketsUrl(id), { ...opts, timeoutMs: 15000 })).map((m) => ({ symbol: m.base + '/' + m.quote, id: m.id, base: m.base, quote: m.quote, settle: null, active: true, type: 'spot', categories: ['spot'], spot: true, margin: false, swap: false, future: false, option: false, cfd: false, contract: false, linear: null, inverse: null, precision: null, limits: null }));
          const categories = ['SPOT', 'MARGIN', 'USDT-FUTURES', 'COIN-FUTURES', 'USDC-FUTURES'];
          const categoryResults = await Promise.allSettled(categories.map(async (category) => {
            const { payload, apiVersion } = await fetchBitgetInstrumentCategory(category, { ...opts, timeoutMs: 15000 });
            const markets = (payload.data || []).filter((market) => {
              const status = String(market.status ?? market.symbolStatus ?? '').toLowerCase();
              return category === 'MARGIN' ? ['1','online','normal'].includes(status) : ['online','normal'].includes(status);
            }).map((market) => {
              const isSpot = category === 'SPOT', isMargin = category === 'MARGIN';
              const isCoin = category === 'COIN-FUTURES';
              const isContract = !isSpot && !isMargin;
              const contractType = String(market.type || market.symbolType || '').toLowerCase();
              const perpetual = isContract && (contractType.includes('perpetual') || (!market.deliveryTime || market.deliveryTime === '-1'));
              const marginCoins = Array.isArray(market.supportMarginCoins) ? market.supportMarginCoins : [];
              const settle = isContract ? (market.settleCoin || (isCoin ? market.baseCoin : (marginCoins[0] || market.quoteCoin))) : null;
              const symbol = market.baseCoin + '/' + market.quoteCoin + (isContract ? ':' + settle : '');
              return {
                symbol, id: market.symbol, base: market.baseCoin, quote: market.quoteCoin, settle,
                active: true, type: isSpot ? 'spot' : isMargin ? 'margin' : perpetual ? 'perpetual' : 'futures',
                categories: [isSpot ? 'spot' : isMargin ? 'margin' : perpetual ? 'perpetual' : 'futures'],
                spot: isSpot, margin: isMargin, swap: perpetual, future: isContract && !perpetual,
                option: false, cfd: false, contract: isContract, linear: !isCoin, inverse: isCoin,
                precision: { price: Number(market.pricePrecision ?? market.pricePlace), amount: Number(market.quantityPrecision ?? market.volumePlace) },
                limits: { amount: { min: Number(market.minOrderQty ?? market.minTradeNum ?? market.minTradeAmount) || null }, leverage: { max: Number(market.maxLeverage ?? market.maxLever) || null } },
                productCategory: category, contractType: market.type || market.symbolType || null,
                instrumentType: market.instrumentType || 'crypto', catalogueApiVersion: apiVersion
              };
            });
            return { category, apiVersion, markets };
          }));
          const successful = categoryResults.filter((result) => result.status === 'fulfilled').map((result) => result.value);
          const failedCategories = categoryResults
            .map((result, index) => ({ result, category: categories[index] }))
            .filter(({ result }) => result.status === 'rejected')
            .map(({ result, category }) => ({ category, error: String(result.reason?.message || 'Category unavailable').slice(0, 220) }));
          if (!successful.length) {
            const detail = failedCategories.map(({ category, error }) => category + ': ' + error).join('; ');
            throw new DirectError('Bitget instrument catalog is unavailable for every product category. ' + detail, 502);
          }
          return successful.flatMap((result) => result.markets).map((market) => ({ ...market, categoryErrors: failedCategories }));
        });
        const normalizedType = normalizeBitgetMarketType(type);
        const markets = all.filter((market) => {
          const typeMatch = normalizedType === 'all' ||
            (normalizedType === 'futures' && (market.future || market.swap)) ||
            (normalizedType === 'usdt-futures' && market.productCategory === 'USDT-FUTURES') ||
            (normalizedType === 'perpetual' && market.swap) ||
            (normalizedType === 'coin-futures' && market.productCategory === 'COIN-FUTURES') ||
            (normalizedType === 'usdc-futures' && market.productCategory === 'USDC-FUTURES') ||
            (normalizedType === 'margin' && market.margin) ||
            (normalizedType === 'spot' && market.spot);
          return typeMatch && (!search || [market.symbol, market.id, market.base, market.quote, market.settle].some((value) => String(value || '').toLowerCase().includes(search)));
        });
        const counts = {
          spot: all.filter((market) => market.spot).length,
          futures: all.filter((market) => market.future || market.swap).length,
          perpetual: all.filter((market) => market.swap).length,
          margin: all.filter((market) => market.margin).length,
          cfd: 0, options: 0,
          coinFutures: all.filter((market) => market.productCategory === 'COIN-FUTURES').length,
          usdtFutures: all.filter((market) => market.productCategory === 'USDT-FUTURES').length,
          usdcFutures: all.filter((market) => market.productCategory === 'USDC-FUTURES').length
        };
        const frames = id === 'bitget' ? Object.keys(BITGET_TIMEFRAMES) : Object.keys(FRAMES[id]);
        return { status: 200, body: { exchange: id, filter: type, count: markets.length, markets, totalMarkets: all.length, counts, timeframes: frames, capabilities: { fetchTicker: true, fetchOHLCV: true, fetchOrderBook: false, fetchFundingRate: false, fetchPositions: false, createOrder: false }, unsupported: { cfd: 'Bitget does not list a native CFD product category in its public instruments API.', options: 'Options are not included in this Bitget public instrument catalogue.' }, categoryErrors: all.find((market) => market.categoryErrors)?.categoryErrors || [], fetchedAt: new Date(now()).toISOString(), source: DIRECT_SOURCE, note: id === 'bitget' ? 'Spot, margin, USDT-margined, USDC-margined and coin-margined public instruments are loaded from Bitget instrument categories.' : 'This venue direct adapter currently exposes spot markets only.' } };
      }
      default:
        throw new DirectError('Not available in direct mode.', 501);
    }
  }

  return {
    // Resolves to { status, body, servedBy } or null when the path is outside direct mode's scope.
    async request(path, { method = 'GET', signal } = {}) {
      const route = matchDirectRoute(path, method);
      if (!route) return null;
      try {
        const result = await handle(route, { signal });
        return { ...result, servedBy: result.body.exchange || null };
      } catch (error) {
        const status = error instanceof DirectError ? error.status : 502;
        return { status, body: { error: error.message || 'Direct mode failed.', source: DIRECT_SOURCE }, servedBy: null, failed: true };
      }
    },
    clearCache() { cache.clear(); }
  };
}
