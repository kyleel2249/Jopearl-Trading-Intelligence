// Cloudflare Pages-native JPTI market-data API.
// This replaces the old Render pass-through. Public exchange data is fetched from
// Cloudflare's edge and normalized through the same tested provider used by the UI.
// Private account access, order execution, durable ledger and Node-only API routes
// are intentionally NOT advertised as implemented by this edge adapter.
import { createDirectProvider, DIRECT_EXCHANGES } from '../../src/lib/browser-direct.js';

const provider = createDirectProvider();
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-jpti-runtime': 'cloudflare-edge'
};
const MAX_URL_LENGTH = 2048;


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

export function createPagesApiHandler({ marketProvider = provider, now = () => new Date() } = {}) {
  return async function onRequest({ request, env = {} }) {
    const url = new URL(request.url);
    if (url.href.length > MAX_URL_LENGTH) return json(414, { error: 'Request URL is too long.' }, request);

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      const sameOrigin = (() => { try { return origin && new URL(origin).origin === url.origin; } catch { return false; } })();
      const allowedOrigin = sameOrigin || ['capacitor://localhost', 'https://localhost', 'http://localhost'].includes(origin);
      const headers = {
        allow: 'GET, HEAD, OPTIONS',
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, x-jpti-api-token',
        'cache-control': 'no-store'
      };
      if (allowedOrigin) {
        headers['access-control-allow-origin'] = origin;
        headers.vary = 'Origin';
      }
      return new Response(null, { status: 204, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return json(405, { error: 'This Cloudflare edge API currently accepts read-only requests.' }, request, { allow: 'GET, HEAD, OPTIONS' });
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
        const requiredTables = ['jpti_events', 'jpti_outbox', 'jpti_scheduler_leases', 'jpti_schema_migrations', 'jpti_sync_cursors'];
        const missingTables = requiredTables.filter((name) => !tables.includes(name));
        // A read-only KV lookup exercises the binding without creating a public write surface.
        await env.JPTI_KV.get('jpti:system:health');
        const healthy = missingTables.length === 0;
        return json(healthy ? 200 : 503, {
          status: healthy ? 'ok' : 'migration-required',
          service: 'JPTI Cloudflare storage',
          d1: { connected: true, tables, missingTables },
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
    if (!['spot', 'all'].includes(requestedType) && (
      /\/api\/exchanges\/[^/]+\/(?:markets|ticker|ohlcv)(?:\/|$)/i.test(url.pathname) ||
      /\/api\/intelligence\/market\/[^/]+\/[^/]+\/context$/i.test(url.pathname)
    )) {
      return json(501, {
        error: 'The Cloudflare edge market-data adapter currently supports spot markets only.',
        code: 'CLOUDFLARE_SPOT_ONLY',
        requestedType,
        supportedTypes: ['spot']
      }, request);
    }

    const contextRoute = url.pathname.match(/^\/api\/intelligence\/market\/([a-z0-9_]+)\/([^/]+)\/context$/i);
    if (contextRoute) {
      const exchange = contextRoute[1].toLowerCase();
      const symbol = contextRoute[2];
      const timeframe = String(url.searchParams.get('timeframe') || '1h');
      const candleUrl = '/api/exchanges/' + exchange + '/ohlcv/' + encodeURIComponent(symbol) +
        '?timeframe=' + encodeURIComponent(timeframe) + '&limit=200';
      const candlesResult = await marketProvider.request(candleUrl, { method: 'GET', signal: request.signal });
      if (!candlesResult || candlesResult.status !== 200) {
        return json(candlesResult?.status || 502, candlesResult?.body || { error: 'Market candles are unavailable for context analysis.' }, request);
      }
      const context = buildCandleContext(exchange, symbol, timeframe, candlesResult.body?.candles, now().toISOString());
      return json(context.status, context.body, request);
    }

    const result = await marketProvider.request(url.pathname + url.search, {
      method: request.method,
      signal: request.signal
    });
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
    return json(result.status, body, request);
  };
}

const handler = createPagesApiHandler();
export async function onRequest(context) {
  return handler(context);
}
