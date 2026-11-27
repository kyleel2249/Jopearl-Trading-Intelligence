import './load-env.js';
import { tokensMatch, requestApiToken } from './token-auth.js';
import { getRuntimeConfigStatus, saveRuntimeConfig, verifyConfigAdminToken } from './runtime-config.js';
import express from 'express';
import { resolve } from 'node:path';
import helmet from 'helmet';
import { z } from 'zod';
import { classifyMarket, matchesProductType, exchangeConnectionStatus, listExchangeCatalog, withExchange, closeExchangeClients } from './exchanges.js';
import { intelligenceRouter } from './intelligence.js';
import { providerRouter } from './providers.js';
import { operationsRouter, startOperationsScheduler, stopOperationsScheduler } from './operations.js';
import { initializeSchedulerLease, closeSchedulerLease } from './scheduler-lease.js';
import { initializeStorage, closeStorage } from './storage.js';
import { assertLiveTradingAllowed, orderSchema, requirePrivateApiAuth } from './policy.js';
import { buildCrossVenueComparison } from './market-intelligence.js';
import { futuresRouter } from './futures-intelligence.js';
import { futuresPaperRouter } from './futures-paper.js';
import { assetIntelligenceRouter } from './asset-intelligence.js';
import { researchCouncilRouter } from './research-council.js';
import { allocationRouter } from './portfolio-allocation.js';
import { advancedRouter } from './advanced-intelligence.js';
import { labRouter } from './advanced-lab.js';
import { tbotsRouter } from './tbots-integration.js';
import { universalRouter } from './universal-engine.js';
import { portfolioRouter } from './portfolio-intelligence.js';
import { marketStreamRouter } from './market-stream.js';
import { portfolioStressRouter } from './portfolio-stress.js';
import { pretradeRouter } from './pretrade-risk.js';
import { strategyRegistryRouter } from './strategy-registry.js';
import { marketReplayRouter } from './market-replay.js';
import { observabilityRouter, observabilityMiddleware } from './observability.js';
import { productionReadinessRouter } from './production-readiness.js';
import { alphaSignalRouter } from './alpha-signal-engine.js';
import { institutionalRouter, assessExchangeEventRisk } from './institutional-intelligence.js';
import { sessionMemoryRouter } from './session-memory.js';
import { agentFleetRouter } from './agent-fleet.js';
import { validationRouter } from './trading-validation.js';

const app = express();
const port = Number(process.env.PORT || process.env.JPTI_API_PORT || 8787);
const host = process.env.NODE_ENV === 'production' ? '0.0.0.0' : (process.env.JPTI_API_HOST || '127.0.0.1');
app.disable('x-powered-by');

// Behind a hosting proxy (Cloudflare) every request otherwise appears to come
// from the proxy address, so all visitors would share one rate-limit bucket. Opt in
// with the number of trusted proxy hops (for example JPTI_TRUST_PROXY=1). A value of
// "true" is treated as one hop: trusting every hop would let clients spoof their IP.
const trustProxyRaw = String(process.env.JPTI_TRUST_PROXY || '').trim().toLowerCase();
if (trustProxyRaw && trustProxyRaw !== 'false' && trustProxyRaw !== '0') {
  const hops = Number.parseInt(trustProxyRaw, 10);
  app.set('trust proxy', Number.isInteger(hops) && hops > 0 ? hops : 1);
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '4mb', strict: true }));

// Capacitor Android uses its own WebView origin. Only explicitly configured origins
// receive CORS permission; same-origin local web clients need no CORS.
//
// JPTI_CORS_ORIGINS        comma-separated exact origins (replaces the built-in default list)
// JPTI_CORS_ORIGINS_EXTRA  comma-separated additions, merged with the list above
// An entry such as https://*.jpti.pages.dev allows any HTTPS subdomain of that host, which
// covers Cloudflare Pages preview deployments. The suffix must contain at least three
// labels, so a broad entry like https://*.pages.dev is refused.
const DEFAULT_CORS_ORIGINS = 'https://localhost,http://localhost,http://127.0.0.1,capacitor://localhost';
const corsEntries = [process.env.JPTI_CORS_ORIGINS || DEFAULT_CORS_ORIGINS, process.env.JPTI_CORS_ORIGINS_EXTRA || '']
  .join(',').split(',').map(value => value.trim()).filter(Boolean);
const allowedCorsOrigins = new Set();
const corsWildcardSuffixes = [];
for (const entry of corsEntries) {
  const wildcard = entry.match(/^https:\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
  if (wildcard) {
    if (wildcard[1].split('.').length < 3) {
      console.warn('Ignoring overly broad CORS wildcard "' + entry + '"; use at least three labels such as https://*.jpti.pages.dev.');
      continue;
    }
    corsWildcardSuffixes.push('.' + wildcard[1].toLowerCase());
  } else if (entry.includes('*')) {
    console.warn('Ignoring unsupported CORS entry "' + entry + '"; wildcards must look like https://*.example.com.');
  } else {
    allowedCorsOrigins.add(entry.replace(/\/+$/, ''));
  }
}
function isCorsOriginAllowed(origin) {
  if (!origin) return false;
  if (allowedCorsOrigins.has(origin)) return true;
  if (!corsWildcardSuffixes.length) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return false;
    const hostname = parsed.hostname.toLowerCase();
    return corsWildcardSuffixes.some((suffix) => hostname.length > suffix.length && hostname.endsWith(suffix));
  } catch { return false; }
}
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  const originAllowed = isCorsOriginAllowed(origin);
  if (origin && originAllowed) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, x-jpti-api-token, x-jpti-live-confirmation, Authorization');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    if (!origin || !originAllowed) return res.status(403).json({ error: 'This application origin is not permitted by JPTI CORS policy.' });
    return res.status(204).end();
  }
  next();
});

// A small per-process throttle protects local development endpoints from accidental request loops.
const windows = new Map();
const RATE_WINDOW_MS = 60_000;
// Expired windows are pruned so the map cannot grow without bound on a public API.
const rateWindowSweeper = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [key, entry] of windows) if (entry.start < cutoff) windows.delete(key);
}, RATE_WINDOW_MS);
rateWindowSweeper.unref?.();
app.use('/api', (req, res, next) => {
  const now = Date.now();
  const key = req.ip || 'local';
  const current = windows.get(key) || { start: now, count: 0 };
  if (now - current.start > RATE_WINDOW_MS) { current.start = now; current.count = 0; }
  current.count += 1;
  windows.set(key, current);
  if (current.count > 180) return res.status(429).json({ error: 'Rate limit exceeded. Retry in one minute.' });
  next();
});

if (!['127.0.0.1', '::1', 'localhost'].includes(host) && (!process.env.JPTI_ALLOW_REMOTE_API || process.env.JPTI_ALLOW_REMOTE_API !== 'true' || !process.env.JPTI_API_TOKEN)) {
  throw new Error('Remote API binding requires JPTI_ALLOW_REMOTE_API=true and a strong JPTI_API_TOKEN. Keep localhost binding for development.');
}

app.use('/api', observabilityMiddleware);
app.use('/api/observability', observabilityRouter);
app.use('/api/governance', productionReadinessRouter);
app.use('/api/alpha', alphaSignalRouter);
app.use('/api/session', sessionMemoryRouter);
app.use('/api/institutional', institutionalRouter);
app.use('/api/intelligence', intelligenceRouter);
app.use('/api/stream', marketStreamRouter);
app.use('/api/portfolio', portfolioStressRouter);
app.use('/api/risk', pretradeRouter);
app.use('/api/strategies', strategyRegistryRouter);
app.use('/api/research', marketReplayRouter);
app.use('/api', providerRouter);
app.use('/api', operationsRouter);
app.use('/api', advancedRouter);
app.use('/api', portfolioRouter);
app.use('/api', labRouter);
app.use('/api', tbotsRouter);
app.use('/api', universalRouter);
app.use('/api/futures', futuresRouter);
app.use('/api/futures', futuresPaperRouter);
app.use('/api/assets', assetIntelligenceRouter);
app.use('/api/council', researchCouncilRouter);
app.use('/api', agentFleetRouter);
app.use('/api/validation', validationRouter);
app.use('/api/portfolio', allocationRouter);
// T-Bots is preserved as an independently versioned paper-trading subsystem.
app.use('/t-bots', express.static(resolve(process.env.JPTI_TBOTS_PUBLIC_DIR || 'integrations/t-bots/public'), { fallthrough: true, index: 'index.html' }));

// Accepts the x-jpti-api-token header or an "Authorization: Bearer <token>" header.
// The previous pattern was written /^Bearer\\s+/i inside a regex literal, which matches a
// literal backslash instead of whitespace, so Bearer tokens were never unwrapped.
const configAdminCredential = (req) => req.get('x-jpti-api-token') || req.get('authorization')?.replace(/^Bearer\s+/i, '');

// Mirrors the Pages Function so "Verify access token" also works in desktop and self-hosted builds.
app.get('/api/auth/check', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = String(process.env.JPTI_API_TOKEN || '').trim();
  if (!expected) return res.status(409).json({ status: 'unconfigured', authorised: false, error: 'No JPTI_API_TOKEN is configured on this API server.' });
  if (!tokensMatch(expected, requestApiToken(req))) return res.status(401).json({ status: 'rejected', authorised: false, error: 'The server rejected this token.' });
  return res.json({ status: 'ok', authorised: true });
});

app.get('/api/configuration/status', (req, res) => {
  if (!verifyConfigAdminToken(configAdminCredential(req))) {
    return res.status(401).json({ error: 'Configuration administrator authentication required.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(getRuntimeConfigStatus());
});

app.post('/api/configuration', async (req, res) => {
  if (!verifyConfigAdminToken(configAdminCredential(req))) {
    return res.status(401).json({ error: 'Configuration administrator authentication required.' });
  }
  try {
    const variables = req.body?.variables;
    const status = await saveRuntimeConfig(variables);
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      status: 'saved',
      ...status,
      restartRequired: true,
      message: 'Configuration encrypted on this server. Restart the JPTI API to activate all settings.'
    });
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Could not save JPTI runtime configuration.' });
  }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  service: 'JPTI Exchange Gateway',
  mode: process.env.JPTI_TRADING_MODE || 'paper',
  liveTradingEnabled: process.env.JPTI_ENABLE_LIVE_TRADING === 'true',
  localPrivateAccess: process.env.JPTI_ALLOW_LOCAL_PRIVATE_ACCESS === 'true' && ['127.0.0.1', '::1', 'localhost'].includes(host),
  desktopInstanceId: process.env.JPTI_DESKTOP_INSTANCE_ID || null,
  timestamp: new Date().toISOString()
}));

app.get('/api/exchanges', (_req, res) => res.json({
  adapter: 'CCXT',
  count: listExchangeCatalog().length,
  exchanges: listExchangeCatalog()
}));


const crossVenueCache = new Map();
app.get('/api/exchanges/compare/ticker', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTC/USDT').trim().toUpperCase();
  if (!/^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}$/.test(symbol)) return res.status(400).json({ error: 'Use a normalized BASE/QUOTE symbol, for example BTC/USDT.' });
  const requested = String(req.query.exchanges || 'binance,bitget,bybit,okx').split(',').map((id) => id.trim().toLowerCase()).filter(Boolean);
  const exchangeIds = [...new Set(requested)].slice(0, 6);
  const supported = new Set(listExchangeCatalog().map((item) => item.id));
  const unsupported = exchangeIds.filter((id) => !supported.has(id));
  if (!exchangeIds.length) return res.status(400).json({ error: 'Select at least one exchange.' });
  if (unsupported.length) return res.status(400).json({ error: 'Unsupported exchange IDs.', unsupported });
  const cacheKey = symbol + '|' + exchangeIds.join(',');
  const cached = crossVenueCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 5000) return res.json({ ...cached.payload, cache: 'hit' });
  const results = await Promise.all(exchangeIds.map(async (id) => {
    try {
      const ticker = await withExchange(id, { privateAccess: false }, async (exchange) => {
        if (!exchange.has?.fetchTicker) throw Object.assign(new Error('Ticker capability unavailable.'), { status: 501 });
        if (!exchange.markets[symbol]) throw Object.assign(new Error('Market symbol is not listed on this venue.'), { status: 404 });
        return exchange.fetchTicker(symbol);
      });
      return { exchange: id, status: 'ok', observation: {
        exchange: id, symbol, last: ticker.last, bid: ticker.bid, ask: ticker.ask,
        baseVolume: ticker.baseVolume, quoteVolume: ticker.quoteVolume,
        percentage: ticker.percentage, timestamp: ticker.timestamp ? new Date(ticker.timestamp).toISOString() : null
      } };
    } catch (error) {
      return { exchange: id, status: 'error', error: error.message, httpStatus: error.status || 502 };
    }
  }));
  const observations = results.filter((item) => item.observation).map((item) => item.observation);
  const comparison = buildCrossVenueComparison(symbol, observations, Number(process.env.JPTI_CROSS_VENUE_OUTLIER_PERCENT) || 0.5);
  const payload = { ...comparison, results: results.map(({ exchange, status, error, httpStatus }) => ({ exchange, status, ...(error ? { error } : {}), ...(httpStatus ? { httpStatus } : {}) })),
    cache: 'miss', cacheTtlMs: 5000, note: 'Public exchange tickers only. No private keys or orders are used.' };
  crossVenueCache.set(cacheKey, { createdAt: Date.now(), payload });
  if (crossVenueCache.size > 200) crossVenueCache.delete(crossVenueCache.keys().next().value);
  res.json(payload);
});

app.get('/api/exchanges/:id/status', (req, res) => {
  const status = exchangeConnectionStatus(req.params.id.toLowerCase());
  if (!status.supported) return res.status(404).json({ error: 'Unsupported exchange.' });
  res.json({ id: req.params.id.toLowerCase(), ...status });
});

app.get('/api/exchanges/:id/markets', async (req, res, next) => {
  const id = req.params.id.toLowerCase();
  const requestedType = String(req.query.type || 'all').toLowerCase();
  const search = String(req.query.search || '').trim().toLowerCase().slice(0, 60);
  const allowedTypes = ['all', 'spot', 'futures', 'perpetual', 'margin', 'cfd', 'options', 'coin-futures', 'usdc-futures'];
  if (!allowedTypes.includes(requestedType)) return res.status(400).json({ error: 'Unsupported market type filter.', allowedTypes });
  try {
    const result = await withExchange(id, { privateAccess: false }, async (exchange) => {
      const all = Object.values(exchange.markets).filter((market) => market.active !== false).map((market) => {
        const meta = classifyMarket(market);
        return { symbol: market.symbol, id: market.id, base: market.base, quote: market.quote, settle: market.settle || null,
          active: market.active, type: meta.type, categories: meta.categories, spot: market.spot === true,
          margin: meta.categories.includes('margin'), swap: market.swap === true, future: market.future === true,
          option: market.option === true, cfd: meta.categories.includes('cfd'), contract: meta.contract,
          linear: meta.linear, inverse: meta.inverse, precision: market.precision, limits: market.limits };
      });
      const markets = all.filter((market) => {
        const matchesType = matchesProductType(market, requestedType);
        const matchesSearch = !search || [market.symbol, market.base, market.quote].some((v) => String(v || '').toLowerCase().includes(search));
        return matchesType && matchesSearch;
      });
      return { markets, totalMarkets: all.length,
        counts: Object.fromEntries(['spot','futures','perpetual','margin','cfd','options'].map((type) => [type, all.filter((m) => m.categories.includes(type) || (type === 'futures' && m.categories.includes('perpetual'))).length])),
        timeframes: exchange.timeframes ? Object.keys(exchange.timeframes) : null,
        capabilities: { fetchTicker: Boolean(exchange.has?.fetchTicker), fetchOHLCV: Boolean(exchange.has?.fetchOHLCV),
          fetchOrderBook: Boolean(exchange.has?.fetchOrderBook), fetchFundingRate: Boolean(exchange.has?.fetchFundingRate),
          fetchPositions: Boolean(exchange.has?.fetchPositions), createOrder: Boolean(exchange.has?.createOrder) },
        fetchedAt: new Date().toISOString() };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ exchange: id, filter: requestedType, count: result.markets.length, ...result });
  } catch (error) { next(error); }
});

app.get('/api/exchanges/:id/ticker/:symbol', async (req, res, next) => {
  const id = req.params.id.toLowerCase();
  const symbol = req.params.symbol.toUpperCase().replace('-', '/');
  try {
    const ticker = await withExchange(id, { privateAccess: false }, async (exchange) => {
      if (!exchange.markets[symbol]) throw Object.assign(new Error(`Unknown market symbol: ${symbol}`), { status: 404 });
      if (!exchange.has?.fetchTicker) throw Object.assign(new Error('Ticker endpoint unavailable for this exchange.'), { status: 501 });
      return exchange.fetchTicker(symbol);
    });
    res.json({
      exchange: id, symbol, timestamp: ticker.timestamp,
      datetime: ticker.datetime, last: ticker.last, bid: ticker.bid, ask: ticker.ask,
      high: ticker.high, low: ticker.low, baseVolume: ticker.baseVolume,
      quoteVolume: ticker.quoteVolume, percentage: ticker.percentage
    });
  } catch (error) { next(error); }
});

app.get('/api/exchanges/:id/ohlcv/:symbol', async (req, res, next) => {
  const id = req.params.id.toLowerCase();
  const symbol = req.params.symbol.toUpperCase().replace('-', '/');
  const timeframe = String(req.query.timeframe || '1h');
  const limit = Math.min(500, Math.max(20, Number.parseInt(req.query.limit || '120', 10) || 120));
  try {
    const candles = await withExchange(id, { privateAccess: false }, async (exchange) => {
      if (!exchange.markets[symbol]) throw Object.assign(new Error(`Unknown market symbol: ${symbol}`), { status: 404 });
      if (!exchange.has?.fetchOHLCV) throw Object.assign(new Error('OHLCV candles are unavailable for this exchange.'), { status: 501 });
      if (exchange.timeframes && !exchange.timeframes[timeframe]) throw Object.assign(new Error(`Unsupported timeframe: ${timeframe}`), { status: 400 });
      return exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
    });
    res.json({ exchange: id, symbol, timeframe, candles });
  } catch (error) { next(error); }
});

app.get('/api/exchanges/:id/balance', async (req, res, next) => {
  try { requirePrivateApiAuth(req); } catch (error) { return res.status(error.status || 401).json({ error: error.message }); }
  const id = req.params.id.toLowerCase();
  try {
    const balance = await withExchange(id, { privateAccess: true }, async (exchange) => {
      if (!exchange.has?.fetchBalance) throw Object.assign(new Error('Balance endpoint unavailable for this exchange.'), { status: 501 });
      return exchange.fetchBalance();
    });
    res.json({ exchange: id, timestamp: new Date().toISOString(), free: balance.free, used: balance.used, total: balance.total });
  } catch (error) { next(error); }
});

app.post('/api/exchanges/:id/orders', async (req, res, next) => {
  const id = req.params.id.toLowerCase();
  try {
    const order = orderSchema.parse(req.body);
    const result = await withExchange(id, { privateAccess: true }, async (exchange) => {
      const market = exchange.market(order.symbol);
      if (order.type === 'market' && !exchange.has?.fetchTicker) throw Object.assign(new Error('Ticker endpoint required for market-order risk checks.'), { status: 501 });
      const ticker = order.type === 'market' ? await exchange.fetchTicker(order.symbol) : null;
      const price = order.type === 'limit' ? order.price : ticker?.last;
      const risk = assertLiveTradingAllowed(req, exchange, market, order, price);
      const eventRisk = await assessExchangeEventRisk(exchange, order.symbol, '5m');
      if (!eventRisk.calendarAvailable && process.env.JPTI_EVENT_RISK_FAIL_CLOSED !== 'false') {
        throw Object.assign(new Error('Live order blocked: the economic-calendar feed is unavailable and event-risk policy is fail-closed. Set JPTI_EVENT_RISK_FAIL_CLOSED=false only after accepting this data gap.'), { status: 503 });
      }
      if (eventRisk.policy.blockNewEntries) {
        throw Object.assign(new Error('Live order blocked by institutional event/volatility risk: ' + eventRisk.state + '. Review the JPTI Institutional Market Intelligence panel.'), { status: 403 });
      }
      if (eventRisk.policy.reduceNewRisk) {
        throw Object.assign(new Error('Live order held by CAUTION/RECOVERY policy. Reduce the requested size manually or wait for the event/volatility condition to clear, then resubmit.'), { status: 409 });
      }
      const params = order.clientOrderId ? { clientOrderId: order.clientOrderId } : {};
      const created = await exchange.createOrder(order.symbol, order.type, order.side, order.amount, order.type === 'limit' ? order.price : undefined, params);
      return { id: created.id, clientOrderId: created.clientOrderId, symbol: created.symbol, side: created.side, type: created.type, amount: created.amount, price: created.price, status: created.status, timestamp: created.timestamp, risk, eventRisk };
    });
    res.status(201).json({ exchange: id, order: result });
  } catch (error) { next(error); }
});

if (process.env.JPTI_SERVE_WEB === 'true') {
  const webDist = resolve(process.env.JPTI_WEB_DIST || 'dist');
  app.use(express.static(webDist, { index: 'index.html' }));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/t-bots/')) return res.sendFile(resolve(webDist, 'index.html'));
    next();
  });
}

app.use((error, _req, res, _next) => {
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: 'Invalid request', details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  const status = Number.isInteger(error.status) ? error.status : 502;
  // Do not return request configs, headers, or raw exchange objects to clients.
  res.status(status).json({ error: error.message || 'Exchange gateway error', name: error.name || 'Error' });
});

await initializeStorage();
await initializeSchedulerLease();
const server = app.listen(port, host, () => {
  console.log(`JPTI API listening on http://${host}:${port}`);
  console.log(`Trading mode: ${process.env.JPTI_TRADING_MODE || 'paper'} | Live orders enabled: ${process.env.JPTI_ENABLE_LIVE_TRADING === 'true'}`);
  startOperationsScheduler();
});


let shutdownPromise;
export function shutdownJptiServer() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  }).then(async () => {
    clearInterval(rateWindowSweeper);
    await stopOperationsScheduler();
    await closeSchedulerLease();
    await closeStorage();
    await closeExchangeClients();
  });
  return shutdownPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdownJptiServer().finally(() => process.exit(0)));
}
