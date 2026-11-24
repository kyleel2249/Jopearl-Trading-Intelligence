// Cloudflare Pages-native JPTI market-data API.
// This replaces the old Render pass-through. Public exchange data is fetched from
// Cloudflare's edge and normalized through the same tested provider used by the UI.
// Private account access, order execution, durable ledger and Node-only API routes
// are intentionally NOT advertised as implemented by this edge adapter.
import { createDirectProvider, DIRECT_EXCHANGES } from '../../src/lib/browser-direct.js';
import { createBitgetCfdProvider } from '../bitget-cfd.js';

const provider = createDirectProvider();
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-jpti-runtime': 'cloudflare-edge'
};
const MAX_URL_LENGTH = 2048;


async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function marketCacheTtl(path) {
  if (/\/markets(?:\/|$)/i.test(path)) return 300;
  if (/\/ohlcv(?:\/|$)/i.test(path)) return 20;
  return 8;
}

async function readMarketCache(env, routeKey) {
  if (!env.JPTI_KV) return null;
  try {
    const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
    const cached = await env.JPTI_KV.get(key, 'json');
    return cached && Number.isInteger(cached.status) && cached.body ? { ...cached, key } : null;
  } catch {
    return null;
  }
}

async function persistMarketSnapshot(env, routeKey, body, occurredAt) {
  if (!env.JPTI_DB) return;
  try {
    const routeHash = await sha256Hex(routeKey);
    const id = 'market:' + routeHash;
    await env.JPTI_DB.prepare(
      "INSERT INTO jpti_events (id, kind, source, external_id, occurred_at, payload) VALUES (?, 'market-snapshot', 'cloudflare-edge', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET external_id = excluded.external_id, occurred_at = excluded.occurred_at, payload = excluded.payload, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    ).bind(id, routeKey, occurredAt, JSON.stringify(body)).run();
  } catch {
    // Public market delivery must remain available if optional snapshot persistence is degraded.
  }
}

async function cacheMarketResponse(env, routeKey, status, body, occurredAt) {
  const ttl = marketCacheTtl(routeKey);
  if (env.JPTI_KV) {
    try {
      const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
      const value = JSON.stringify({ status, body, cachedAt: occurredAt });
      // KV values have a finite size limit. Skip oversized market catalogs rather than fail the API.
      if (new TextEncoder().encode(value).byteLength <= 900000) {
        await env.JPTI_KV.put(key, value, { expirationTtl: ttl });
      }
    } catch {
      // Cache failures must not make live exchange data unavailable.
    }
  }
  await persistMarketSnapshot(env, routeKey, body, occurredAt);
}

async function readStoredMarketSnapshot(env, routeKey) {
  if (!env.JPTI_DB) return null;
  try {
    const row = await env.JPTI_DB.prepare(
      "SELECT payload, occurred_at FROM jpti_events WHERE kind = 'market-snapshot' AND external_id = ? ORDER BY occurred_at DESC LIMIT 1"
    ).bind(routeKey).first();
    if (!row?.payload) return null;
    const body = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    return { body, occurredAt: row.occurred_at || null };
  } catch {
    return null;
  }
}

async function cacheStaleMarketResponse(env, routeKey, body, occurredAt) {
  if (!env.JPTI_KV) return;
  try {
    const key = 'jpti:market:v1:' + await sha256Hex(routeKey);
    await env.JPTI_KV.put(key, JSON.stringify({ status: 200, body, cachedAt: occurredAt, stale: true }), { expirationTtl: 5 });
  } catch {
    // Stale cache is best-effort; D1 remains the durable source.
  }
}

function buildCandleContext(exchange, symbol, timeframe, candles, generatedAt) {
  const rows = (Array.isArray(candles) ? candles : [])
    .filter((row) => Array.isArray(row) && row.length >= 6 && row.slice(0, 6).every((value) => Number.isFinite(Number(value))))
    .map((row) => row.slice(0, 6).map(Number));
  if (rows.length < 21) {
    return { status: 422, body: { error: 'At least 21 valid candles are required for market context.', source: 'cloudflare-edge' } };
  }
  const closed = rows.slice(0, -1);
  const closes = closed.map((row) => row[4]);
  const volumes = closed.map((row) => row[5]);
  const latest = closed.at(-1);
  const prior = closes.at(-21);
  const priceChangePct = prior ? ((latest[4] - prior) / prior) * 100 : 0;
  const avgVolume = volumes.slice(-21, -1).reduce((sum, value) => sum + value, 0) / Math.max(1, volumes.slice(-21, -1).length);
  const volumeChangePct = avgVolume > 0 ? ((latest[5] / avgVolume) - 1) * 100 : null;
  const sma20 = closes.slice(-20).reduce((sum, value) => sum + value, 0) / 20;
  const trendPct = sma20 ? ((latest[4] - sma20) / sma20) * 100 : 0;
  const momentumContribution = Math.max(-35, Math.min(35, priceChangePct * 3));
  const trendContribution = Math.max(-25, Math.min(25, trendPct * 8));
  const volumeContribution = volumeChangePct === null ? 0 : Math.sign(priceChangePct) * Math.max(0, Math.min(15, volumeChangePct * 0.15));
  const score = Math.round(Math.max(-100, Math.min(100, momentumContribution + trendContribution + volumeContribution)));
  const direction = score >= 12 ? 'bullish' : score <= -12 ? 'bearish' : 'neutral';
  const confidence = Math.abs(score) >= 45 ? 'moderate' : 'low';
  const bias = priceChangePct > 0.15 ? 'bullish' : priceChangePct < -0.15 ? 'bearish' : 'neutral';
  return {
    status: 200,
    body: {
      exchange,
      symbol: symbol.replace('-', '/'),
      generatedAt,
      market: {
        exchange, symbol: symbol.replace('-', '/'), priceChangePct: Number(priceChangePct.toFixed(4)),
        volumeChangePct: volumeChangePct === null ? null : Number(volumeChangePct.toFixed(2)),
        orderBookImbalancePct: null, fundingRate: null, last: latest[4], sma20
      },
      broadContext: { globalMarketCapChange24hPct: null, status: 'not-connected' },
      multiTimeframe: [{ timeframe, bias, changePct: Number(priceChangePct.toFixed(4)), source: 'selected-timeframe OHLCV' }],
      score: {
        score, direction, confidence,
        evidence: [
          { factor: '20-bar momentum', contribution: Number(momentumContribution.toFixed(2)) },
          { factor: 'SMA20 trend', contribution: Number(trendContribution.toFixed(2)) },
          { factor: 'Relative volume confirmation', contribution: Number(volumeContribution.toFixed(2)) }
        ]
      },
      sources: [
        { name: exchange.toUpperCase() + ' OHLCV', status: 'live' },
        { name: 'Order book depth', status: 'unsupported' },
        { name: 'Perpetual funding', status: 'unsupported' },
        { name: 'Global market context', status: 'not-connected' }
      ],
      limitations: [
        'This is a lightweight, single-timeframe OHLCV heuristic generated at the Cloudflare edge.',
        'Order-book depth, funding, global market breadth and multi-timeframe confirmation are not included; this is not a trade instruction.'
      ],
      source: 'cloudflare-edge'
    }
  };
}

function json(status, body, request, extra = {}) {
  const headers = new Headers({ ...JSON_HEADERS, ...extra });
  const origin = request.headers.get('Origin');
  // Same-origin Pages traffic plus the standard Capacitor WebView origins.
  // No wildcard is used and credentials are never enabled.
  const nativeOrigins = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
  let allowed = false;
  if (origin) {
    try { allowed = new URL(origin).origin === new URL(request.url).origin || nativeOrigins.has(origin); }
    catch { allowed = false; }
  }
  if (allowed) {
    headers.set('access-control-allow-origin', origin);
    headers.append('vary', 'Origin');
  }
  return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
}


async function verifyJournalToken(request, env) {
  const expected = String(env.JPTI_JOURNAL_TOKEN || env.JPTI_API_TOKEN || '');
  const provided = String(request.headers.get('x-jpti-api-token') || request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '');
  if (!expected) return { ok: false, status: 503, error: 'Private journal storage is not configured. Set the JPTI_JOURNAL_TOKEN Cloudflare secret.' };
  const [a,b] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided))
  ]);
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0 ? { ok: true } : { ok: false, status: 401, error: 'Private journal authorization failed.' };
}

async function handleJournalRoute(request, env, url) {
  if (!env.JPTI_DB) return json(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.' }, request);
  const auth = await verifyJournalToken(request, env);
  if (!auth.ok) return json(auth.status, { error: auth.error }, request);
  const ownerKey = 'primary';
  if (request.method === 'GET') {
    try {
      const result = await env.JPTI_DB.prepare(
        'SELECT payload, updated_at FROM jpti_journal_entries WHERE owner_key = ? ORDER BY updated_at DESC LIMIT 200'
      ).bind(ownerKey).all();
      const entries = (result.results || []).map(row => {
        try { return typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch { return null; }
      }).filter(Boolean);
      return json(200, { entries, count: entries.length, storage: 'cloudflare-d1', durable: true }, request);
    } catch (error) {
      return json(500, { error: 'Could not read journal records from D1.', detail: String(error?.message || error).slice(0, 180) }, request);
    }
  }
  if (request.method === 'POST') {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 512000) return json(413, { error: 'Journal record exceeds the 512 KB request limit.' }, request);
    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'A valid JSON journal record is required.' }, request); }
    const entry = body?.entry;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return json(400, { error: 'Send one journal entry in the entry field.' }, request);
    const id = String(entry.id || '').trim();
    const symbol = String(entry.symbol || '').trim().toUpperCase();
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !/^[A-Z0-9._/-]{3,40}$/.test(symbol)) {
      return json(400, { error: 'Journal entry id or symbol is invalid.' }, request);
    }
    const payload = JSON.stringify(entry);
    if (new TextEncoder().encode(payload).byteLength > 500000) return json(413, { error: 'Journal record exceeds the 500 KB storage limit.' }, request);
    try {
      await env.JPTI_DB.prepare(
        "INSERT INTO jpti_journal_entries (owner_key, entry_id, symbol, payload) VALUES (?, ?, ?, ?) ON CONFLICT(owner_key, entry_id) DO UPDATE SET symbol = excluded.symbol, payload = excluded.payload, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"
      ).bind(ownerKey, id, symbol, payload).run();
      return json(200, { ok: true, id, symbol, storage: 'cloudflare-d1', durable: true }, request);
    } catch (error) {
      return json(500, { error: 'Could not save journal record to D1.', detail: String(error?.message || error).slice(0, 180) }, request);
    }
  }
  return json(405, { error: 'Journal route supports GET and POST only.' }, request, { allow: 'GET, POST, OPTIONS' });
}

export function createPagesApiHandler({ marketProvider = provider, bitgetCfdProvider = createBitgetCfdProvider(), now = () => new Date() } = {}) {
  return async function onRequest({ request, env = {} }) {
    const url = new URL(request.url);
    if (url.href.length > MAX_URL_LENGTH) return json(414, { error: 'Request URL is too long.' }, request);

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const sameOrigin = (() => { try { return origin && new URL(origin).origin === url.origin; } catch { return false; } })();
      const allowedOrigin = sameOrigin || ['capacitor://localhost', 'https://localhost', 'http://localhost'].includes(origin);
      const headers = {
        allow: 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-jpti-api-token',
        'cache-control': 'no-store'
      };
      if (allowedOrigin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      return new Response(null, { status: 204, headers });
    }
    if (url.pathname.replace(/\/+$/, '') === '/api/journal/entries') {
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'Journal route supports GET and POST only.' }, request, { allow: 'GET, HEAD, POST, OPTIONS' });
      if (request.method === 'HEAD') return json(200, { status: 'available' }, request);
      return handleJournalRoute(request, env, url);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json(405, { error: 'This Cloudflare edge API currently accepts read-only requests.' }, request, { allow: 'GET, HEAD, OPTIONS' });
    }

    const isMarketDataRoute =
      /^\/api\/exchanges\/[^/]+\/(?:markets|ticker\/[^/]+|ohlcv\/[^/]+)(?:\/|$)/i.test(url.pathname) ||
      /^\/api\/exchanges\/compare\/ticker$/i.test(url.pathname) ||
      /^\/api\/intelligence\/market\/[^/]+\/[^/]+\/context$/i.test(url.pathname);
    const marketRouteKey = url.pathname + url.search;
    if (isMarketDataRoute) {
      const cached = await readMarketCache(env, marketRouteKey);
      if (cached) {
        return json(cached.status, cached.body, request, { 'x-jpti-cache': 'hit', 'x-jpti-runtime': 'cloudflare-edge' });
      }
    }

    if (url.pathname.replace(/\/+$/, '') === '/api/storage/health') {
      const missing = [];
      if (!env.JPTI_DB) missing.push('JPTI_DB');
      if (!env.JPTI_KV) missing.push('JPTI_KV');
      if (missing.length) {
        return json(503, { status: 'degraded', service: 'JPTI Cloudflare storage', missingBindings: missing }, request);
      }
      try {
        const result = await env.JPTI_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'jpti_%' ORDER BY name").all();
        const tables = (result?.results || []).map((row) => row.name);
        const requiredTables = ['jpti_events', 'jpti_outbox', 'jpti_scheduler_leases', 'jpti_schema_migrations', 'jpti_sync_cursors', 'jpti_journal_entries'];
        const missingTables = requiredTables.filter((name) => !tables.includes(name));
        const snapshotIndex = await env.JPTI_DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
        ).bind('jpti_events_market_snapshot_lookup').first();
        const missingIndexes = snapshotIndex ? [] : ['jpti_events_market_snapshot_lookup'];
        // A read-only KV lookup exercises the binding without creating a public write surface.
        await env.JPTI_KV.get('jpti:system:health');
        const healthy = missingTables.length === 0 && missingIndexes.length === 0;
        return json(healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'migration-required',
          service: 'JPTI Cloudflare storage',
          d1: { connected: true, tables, missingTables, indexes: snapshotIndex ? [snapshotIndex.name] : [], missingIndexes },
          kv: { connected: true, operation: 'read' },
          timestamp: now().toISOString()
        }, request);
      } catch (error) {
        return json(503, {
          status: 'degraded',
          service: 'JPTI Cloudflare storage',
          error: 'Cloudflare storage health check failed.',
          detail: String(error?.message || error).slice(0, 240)
        }, request);
      }
    }

    if (url.pathname.replace(/\/+$/, '') === '/api/health') {
      return json(200, {
        status: 'ok',
        service: 'JPTI Cloudflare Edge Market Data',
        mode: 'cloudflare-edge',
        source: 'cloudflare-edge',
        directMode: true,
        liveTradingEnabled: false,
        capabilities: {
          publicMarketCatalog: true,
          publicTicker: true,
          publicCandlesticks: true,
          crossVenuePublicTicker: true,
          bitgetProductTypes: ['spot', 'margin', 'futures', 'coin-futures', 'usdc-futures', 'cfd'],
          bitgetCfd: true,
          bitgetCfdConfigured: Boolean(env.JPTI_BITGET_API_KEY && env.JPTI_BITGET_API_SECRET && (env.JPTI_BITGET_API_PASSPHRASE || env.JPTI_BITGET_PASSWORD)),
          bitgetCfdRequiresCloudflareSecrets: true,
          privateAccounts: false,
          orderExecution: false,
          durablePortfolioLedger: false,
          serverBackedAdvancedAnalytics: false
        },
        exchanges: DIRECT_EXCHANGES,
        timestamp: now().toISOString()
      }, request);
    }

    const requestedType = String(url.searchParams.get('type') || 'spot').toLowerCase();
    const supportedBitgetTypes = ['spot', 'margin', 'futures', 'perpetual', 'coin-futures', 'usdc-futures', 'usdt-m', 'usdt-m-futures', 'usdt-futures', 'coin-m', 'coin-m-futures', 'usdc-m', 'usdc-m-futures', 'cfd', 'all'];
    const isExchangeMarketRoute = /\/api\/exchanges\/([a-z0-9_]+)\/(?:markets|ticker\/[^/]+|ohlcv\/[^/]+)$/i.test(url.pathname);
    const exchangeMatch = url.pathname.match(/\/api\/exchanges\/([a-z0-9_]+)\//i);
    const requestedExchange = exchangeMatch?.[1]?.toLowerCase();
    if (isExchangeMarketRoute && requestedExchange !== 'bitget' && !['spot', 'all'].includes(requestedType)) {
      return json(501, { error: 'This direct market adapter currently exposes spot markets for this exchange.', code: 'EXCHANGE_PRODUCT_TYPE_UNAVAILABLE', requestedExchange, requestedType, supportedTypes: ['spot'] }, request);
    }
    if (isExchangeMarketRoute && requestedExchange === 'bitget' && !supportedBitgetTypes.includes(requestedType)) {
      return json(400, { error: 'Unsupported Bitget market category.', code: 'BITGET_CATEGORY_UNSUPPORTED', requestedType, supportedTypes: supportedBitgetTypes }, request);
    }

    if (url.pathname === '/api/exchanges/bitget/cfd/diagnostics') {
      try {
        const result = await bitgetCfdProvider.request(env, { kind: 'diagnostics' });
        return json(result.status, result.body, request);
      } catch (error) {
        return json(error.status || 502, {
          error: error.message || 'Bitget CFD API diagnostics are unavailable.',
          code: error.code || 'BITGET_CFD_UPSTREAM_ERROR',
          upstreamStatus: error.upstreamStatus || null,
          upstreamCode: error.upstreamCode || null,
          upstreamMessage: error.upstreamMessage || null,
          upstreamContentType: error.upstreamContentType || null,
          upstreamPreview: error.upstreamPreview || null,
          exchange: 'bitget', productType: 'cfd'
        }, request);
      }
    }

    // CFD is a separate Bitget product line with its own signed UTA read-only API.
    // Never route CFD symbols through the crypto CCXT/browser-direct adapter.
    const cfdRoute = url.pathname.match(/^\/api\/exchanges\/bitget\/(markets|ticker\/([^/]+)|ohlcv\/([^/]+))$/i);
    if (cfdRoute && requestedType === 'cfd') {
      try {
        const kind = cfdRoute[1] === 'markets' ? 'markets' : cfdRoute[1].startsWith('ticker/') ? 'ticker' : 'ohlcv';
        const symbol = cfdRoute[2] || cfdRoute[3] || '';
        const result = await bitgetCfdProvider.request(env, {
          kind,
          symbol,
          timeframe: url.searchParams.get('timeframe') || '1h',
          side: url.searchParams.get('side') || 'buy',
          search: url.searchParams.get('search') || '',
          limit: url.searchParams.get('limit') || '100'
        });
        const body = { ...result.body, source: 'cloudflare-edge' };
        await cacheMarketResponse(env, marketRouteKey, result.status, body, now().toISOString());
        return json(result.status, body, request, { 'x-jpti-cache': 'miss' });
      } catch (error) {
        return json(error.status || 502, {
          error: error.message || 'Bitget CFD market data is unavailable.',
          code: error.code || 'BITGET_CFD_UPSTREAM_ERROR',
          upstreamStatus: error.upstreamStatus || null,
          upstreamCode: error.upstreamCode || null,
          upstreamMessage: error.upstreamMessage || null,
          upstreamContentType: error.upstreamContentType || null,
          upstreamPreview: error.upstreamPreview || null,
          exchange: 'bitget', productType: 'cfd'
        }, request);
      }
    }

    const contextRoute = url.pathname.match(/^\/api\/intelligence\/market\/([a-z0-9_]+)\/([^/]+)\/context$/i);
    if (contextRoute) {
      const exchange = contextRoute[1].toLowerCase();
      let symbol;
      try { symbol = decodeURIComponent(contextRoute[2]); }
      catch { return json(400, { error: 'Invalid encoded market symbol.', code: 'MARKET_SYMBOL_ENCODING_INVALID' }, request); }
      const timeframe = String(url.searchParams.get('timeframe') || '1h');
      const instrumentId = String(url.searchParams.get('instrumentId') || '').trim();
      const instrumentQuery = instrumentId ? '&instrumentId=' + encodeURIComponent(instrumentId) : '';
      const contextType = String(url.searchParams.get('type') || 'spot').toLowerCase();
      let candlesResult;
      if (exchange === 'bitget' && contextType === 'cfd') {
        try {
          candlesResult = await bitgetCfdProvider.request(env, {
            kind: 'ohlcv', symbol, timeframe, side: url.searchParams.get('side') || 'buy', limit: 200
          });
        } catch (error) {
          candlesResult = { status: error.status || 502, body: { error: error.message, code: error.code || 'BITGET_CFD_UPSTREAM_ERROR' } };
        }
      } else {
        const candleUrl = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol) +
          '?timeframe=' + encodeURIComponent(timeframe) + '&limit=200&type=' + encodeURIComponent(contextType) + instrumentQuery;
        candlesResult = await marketProvider.request(candleUrl, { method: 'GET', signal: request.signal });
      }
      if (!candlesResult || candlesResult.status !== 200) {
        const snapshot = await readStoredMarketSnapshot(env, marketRouteKey);
        if (snapshot) {
          const staleBody = { ...snapshot.body, stale: true, lastUpdatedAt: snapshot.occurredAt, source: 'cloudflare-d1-stale' };
          await cacheStaleMarketResponse(env, marketRouteKey, staleBody, now().toISOString());
          return json(200, staleBody, request, { 'x-jpti-cache': 'd1-stale' });
        }
        return json(candlesResult?.status || 502, candlesResult?.body || { error: 'Market candles are unavailable for context analysis.' }, request);
      }
      const generatedAt = now().toISOString();
      const context = buildCandleContext(exchange, symbol, timeframe, candlesResult.body?.candles, generatedAt);
      if (context.status === 200) await cacheMarketResponse(env, marketRouteKey, context.status, context.body, generatedAt);
      return json(context.status, context.body, request, { 'x-jpti-cache': 'miss' });
    }

    const result = await marketProvider.request(url.pathname + url.search, {
      method: request.method,
      signal: request.signal
    });
    if ((!result || result.status >= 500) && isMarketDataRoute) {
      const snapshot = await readStoredMarketSnapshot(env, marketRouteKey);
      if (snapshot) {
        const staleBody = { ...snapshot.body, stale: true, lastUpdatedAt: snapshot.occurredAt, source: 'cloudflare-d1-stale' };
        await cacheStaleMarketResponse(env, marketRouteKey, staleBody, now().toISOString());
        return json(200, staleBody, request, { 'x-jpti-cache': 'd1-stale' });
      }
    }
    if (!result) {
      return json(501, {
        error: 'This endpoint is not implemented in the Cloudflare edge runtime.',
        code: 'CLOUDFLARE_EDGE_ROUTE_UNAVAILABLE',
        path: url.pathname,
        available: [
          '/api/health',
          '/api/exchanges',
          '/api/exchanges/compare/ticker',
          '/api/exchanges/:id/markets',
          '/api/exchanges/:id/ticker/:symbol',
          '/api/exchanges/:id/ohlcv/:symbol'
        ],
        note: 'Public chart data is available without an external API gateway. Private trading and persistent server services require separate Cloudflare-native implementations.'
      }, request);
    }

    const body = { ...result.body, source: 'cloudflare-edge' };
    if (isMarketDataRoute && result.status >= 200 && result.status < 300) {
      await cacheMarketResponse(env, marketRouteKey, result.status, body, now().toISOString());
    }
    return json(result.status, body, request, isMarketDataRoute ? { 'x-jpti-cache': 'miss' } : {});
  };
}

const handler = createPagesApiHandler();
export async function onRequest(context) {
  return handler(context);
}
