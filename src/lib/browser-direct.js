// Browser-direct market data: a last-resort provider that answers the JPTI API's public market-data
// routes straight from the exchanges' public REST endpoints, so the dashboard keeps working when the
// JPTI API is unreachable (static hosting, a sleeping or missing server, a native WebView with no backend).
//
// Scope (deliberately limited, never pretending to be the full API):
//   GET /api/health                              -> a "direct mode" status (never claims the API is up)
//   GET /api/exchanges                           -> catalog of the supported venues
//   GET /api/exchanges/:id/markets               -> spot markets (cached)
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
  bitget: { '1m': '1min', '5m': '5min', '15m': '15min', '30m': '30min', '1h': '1h', '4h': '4h', '6h': '6h', '12h': '12h', '1d': '1day', '1w': '1week', '1M': '1M' }
};

const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function parseSymbol(raw) {
  const text = decodeURIComponent(String(raw || '')).toUpperCase().replace('-', '/');
  const [base, quote, ...rest] = text.split('/');
  if (rest.length || !/^[A-Z0-9]{2,20}$/.test(base || '') || !/^[A-Z0-9]{2,20}$/.test(quote || '')) {
    throw new DirectError('Direct mode supports spot pairs such as BTC/USDT only: ' + text, 404);
  }
  return { base, quote, symbol: base + '/' + quote };
}

export const venueSymbol = (exchange, { base, quote }) => (exchange === 'okx' ? base + '-' + quote : base + quote);

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
    const t = p.data?.[0];
    if (!t) throw new DirectError('Unknown market symbol.', 404);
    const pct = num(t.change24h);
    return { timestamp: num(t.ts), last: num(t.lastPr ?? t.close), bid: num(t.bidPr), ask: num(t.askPr), high: num(t.high24h), low: num(t.low24h), baseVolume: num(t.baseVolume), quoteVolume: num(t.quoteVolume), percentage: pct === null ? null : pct * 100 };
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
  bitget: (p) => (p?.data || []).filter((s) => s.status === 'online').map((s) => ({ id: s.symbol, base: s.baseCoin, quote: s.quoteCoin }))
};

export const parsers = { ticker: TICKER_PARSERS, candles: CANDLE_PARSERS, markets: MARKET_PARSERS };

// ---------------------------------------------------------------------------
// URL builders
// ---------------------------------------------------------------------------
export function tickerUrl(exchange, sym) {
  const s = venueSymbol(exchange, sym);
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/ticker/24hr?symbol=' + s;
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/tickers?category=spot&symbol=' + s;
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/market/ticker?instId=' + s;
  return HOSTS.bitget + '/api/v2/spot/market/tickers?symbol=' + s;
}

export function candlesUrl(exchange, sym, timeframe, limit) {
  const frame = FRAMES[exchange]?.[timeframe];
  if (!frame) throw new DirectError('Unsupported timeframe: ' + timeframe, 400);
  const s = venueSymbol(exchange, sym);
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/klines?symbol=' + s + '&interval=' + frame + '&limit=' + Math.min(limit, 1000);
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/kline?category=spot&symbol=' + s + '&interval=' + frame + '&limit=' + Math.min(limit, 1000);
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/market/candles?instId=' + s + '&bar=' + frame + '&limit=' + Math.min(limit, 300);
  return HOSTS.bitget + '/api/v2/spot/market/candles?symbol=' + s + '&granularity=' + frame + '&limit=' + Math.min(limit, 1000);
}

export function marketsUrl(exchange) {
  if (exchange === 'binance') return HOSTS.binance + '/api/v3/exchangeInfo';
  if (exchange === 'bybit') return HOSTS.bybit + '/v5/market/instruments-info?category=spot';
  if (exchange === 'okx') return HOSTS.okx + '/api/v5/public/instruments?instType=SPOT';
  return HOSTS.bitget + '/api/v2/spot/public/symbols';
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

async function getJson(url, { fetchImpl, signal, timeoutMs = 7000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    const response = await fetchImpl(url, { method: 'GET', cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new DirectError('Exchange answered HTTP ' + response.status + '.', response.status === 404 ? 404 : 502);
    return await response.json();
  } catch (error) {
    if (error instanceof DirectError) throw error;
    throw new DirectError(error && error.name === 'AbortError' ? 'The exchange did not answer in time.' : 'The exchange could not be reached from this browser.', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
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
  async function withFailover(requested, attempt, signal) {
    let lastError = null;
    for (const venue of order(requested)) {
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
        return { status: 200, body: { adapter: 'browser-direct', source: DIRECT_SOURCE, count: DIRECT_EXCHANGES.length, exchanges: DIRECT_EXCHANGES.map((id) => ({ id, name: NAMES[id], configured: false, capabilities: { ticker: true, orderBook: false, ohlcv: true, balance: false, createOrder: false, fetchMarkets: true, fetchFundingRate: false, fetchPositions: false, fetchLeverage: false, fetchMarginMode: false } })) } };
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
        const sym = parseSymbol(route.symbol);
        const r = await withFailover(route.exchange, (venue) => cached('t:' + venue + sym.symbol, CACHE_TTL.ticker, async () => {
          const t = TICKER_PARSERS[venue](await getJson(tickerUrl(venue, sym), opts));
          if (t.last === null) throw new DirectError('The exchange returned no price.', 502);
          return t;
        }), signal);
        const t = r.value;
        return { status: 200, body: { exchange: r.venue, symbol: sym.symbol, timestamp: t.timestamp, datetime: isoOrNull(t.timestamp), last: t.last, bid: t.bid, ask: t.ask, high: t.high, low: t.low, baseVolume: t.baseVolume, quoteVolume: t.quoteVolume, percentage: t.percentage, source: DIRECT_SOURCE, requestedExchange: r.requested, failedOver: r.failedOver } };
      }
      case 'ohlcv': {
        const sym = parseSymbol(route.symbol);
        const timeframe = String(route.query.timeframe || '1h');
        const limit = Math.min(500, Math.max(20, Number.parseInt(route.query.limit || '120', 10) || 120));
        const r = await withFailover(route.exchange, (venue) => cached('c:' + venue + sym.symbol + timeframe + limit, CACHE_TTL.ohlcv, async () => {
          const rows = CANDLE_PARSERS[venue](await getJson(candlesUrl(venue, sym, timeframe, limit), opts));
          return rows.slice(-limit);
        }), signal);
        return { status: 200, body: { exchange: r.venue, symbol: sym.symbol, timeframe, candles: r.value, source: DIRECT_SOURCE, requestedExchange: r.requested, failedOver: r.failedOver } };
      }
      case 'markets': {
        const id = route.exchange;
        if (!DIRECT_EXCHANGES.includes(id)) throw new DirectError('Direct mode does not support ' + id + '.', 404);
        const type = String(route.query.type || 'all').toLowerCase();
        const search = String(route.query.search || '').trim().toLowerCase().slice(0, 60);
        const all = await cached('m:' + id, CACHE_TTL.markets, async () => MARKET_PARSERS[id](await getJson(marketsUrl(id), { ...opts, timeoutMs: 15000 })).map((m) => ({ symbol: m.base + '/' + m.quote, id: m.id, base: m.base, quote: m.quote, settle: null, active: true, type: 'spot', categories: ['spot'], spot: true, margin: false, swap: false, future: false, option: false, cfd: false, contract: false, linear: null, inverse: null, precision: null, limits: null })));
        const wantsSpot = type === 'all' || type === 'spot';
        const markets = wantsSpot ? all.filter((m) => !search || [m.symbol, m.base, m.quote].some((v) => String(v || '').toLowerCase().includes(search))) : [];
        return { status: 200, body: { exchange: id, filter: type, count: markets.length, markets, totalMarkets: all.length, counts: { spot: all.length, futures: 0, perpetual: 0, margin: 0, cfd: 0, options: 0 }, timeframes: Object.keys(FRAMES[id]), capabilities: { fetchTicker: true, fetchOHLCV: true, fetchOrderBook: false, fetchFundingRate: false, fetchPositions: false, createOrder: false }, fetchedAt: new Date(now()).toISOString(), source: DIRECT_SOURCE, note: 'Spot markets only in direct mode.' } };
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
