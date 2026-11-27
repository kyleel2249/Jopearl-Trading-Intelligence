const BASE = 'https://api.bitget.com';
const CFD_TIMEFRAMES = Object.freeze({ '1m': '1m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' });

const jsonError = (message, status = 502, code = 'BITGET_CFD_UPSTREAM_ERROR', details = {}) =>
  Object.assign(new Error(message), { status, code, ...details });

function credentials(env = {}) {
  const key = env.JPTI_BITGET_API_KEY || env.BITGET_API_KEY;
  const secret = env.JPTI_BITGET_API_SECRET || env.BITGET_API_SECRET;
  const passphrase = env.JPTI_BITGET_API_PASSPHRASE || env.BITGET_API_PASSPHRASE || env.JPTI_BITGET_PASSWORD;
  if (!key || !secret || !passphrase) {
    throw jsonError('Bitget CFD market data requires JPTI_BITGET_API_KEY, JPTI_BITGET_API_SECRET and JPTI_BITGET_API_PASSPHRASE as Cloudflare Pages secrets. Use a read-only UTA API key; no trading permission is needed for chart data.', 503, 'BITGET_CFD_CREDENTIALS_REQUIRED');
  }
  return { key, secret, passphrase };
}

function encodeQuery(params = {}) {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
    .join('&');
}

async function sign(secret, message) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedGet(env, path, params, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const auth = credentials(env);
  const query = encodeQuery(params);
  const requestPath = path + (query ? '?' + query : '');
  const timestamp = String(now());
  const signature = await sign(auth.secret, timestamp + 'GET' + requestPath);
  const response = await fetchImpl(BASE + requestPath, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'ACCESS-KEY': auth.key,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': auth.passphrase,
      'Content-Type': 'application/json',
      locale: 'en-US'
    }
  });
  const responseText = await response.text().catch(() => '');
  let payload = null;
  try { payload = responseText ? JSON.parse(responseText) : null; } catch { /* retain a short non-JSON diagnostic below */ }
  const contentType = response.headers?.get?.('content-type') || 'unknown';
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 403 : response.status === 429 ? 429 : 502;
    throw jsonError(payload?.msg || payload?.message || 'Bitget CFD request returned HTTP ' + response.status + '.', status, 'BITGET_CFD_UPSTREAM_ERROR', {
      upstreamStatus: response.status,
      upstreamCode: payload?.code == null ? null : String(payload.code),
      upstreamMessage: payload?.msg || payload?.message || null,
      upstreamContentType: contentType,
      upstreamPreview: payload && (payload.code != null || payload.msg || payload.message) ? null : responseText.slice(0, 180),
      upstreamServer: response.headers?.get?.('server') || null,
      upstreamRay: response.headers?.get?.('cf-ray') || null,
      upstreamDate: response.headers?.get?.('date') || null
    });
  }
  if (!payload || String(payload.code) !== '00000') {
    throw jsonError(payload?.msg || 'Bitget CFD returned an unsuccessful response.', 502, 'BITGET_CFD_UPSTREAM_ERROR', {
      upstreamCode: payload?.code == null ? null : String(payload.code),
      upstreamMessage: payload?.msg || null,
      upstreamContentType: contentType
    });
  }
  return payload;
}

function safeInstrument(value) {
  const symbol = decodeURIComponent(String(value || '')).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/.test(symbol)) throw jsonError('Invalid Bitget CFD instrument symbol.', 400, 'BITGET_CFD_INVALID_SYMBOL');
  return symbol;
}

function normalizeInstruments(payload) {
  const markets = (Array.isArray(payload.data) ? payload.data : []).map((item) => {
    const symbol = safeInstrument(item.symbol);
    return {
      symbol, id: symbol, base: item.currency || null, quote: item.profitCurrency || item.marginCurrency || null,
      settle: item.marginCurrency || null, active: true, type: 'cfd', categories: ['cfd'],
      spot: false, margin: false, swap: false, future: false, option: false, cfd: true, contract: false,
      precision: { price: Number(item.digits) || null },
      limits: { contractSize: Number(item.contractSize) || null, stopLevel: Number(item.stopLevel) || null },
      productCategory: 'CFD', instrumentType: 'traditional-finance',
      spread: Number(item.spread) || null, onlineTime: item.onlineTime || null
    };
  });
  return markets;
}

function normalizeTicker(payload, symbol) {
  const item = (Array.isArray(payload.data) ? payload.data : []).find((row) => String(row.symbol).toUpperCase() === symbol.toUpperCase());
  if (!item) throw jsonError('Bitget CFD ticker is unavailable for ' + symbol + '.', 404, 'BITGET_CFD_SYMBOL_UNAVAILABLE');
  const bid = Number(item.bid1), ask = Number(item.ask1);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
  const change = Number(item.askOpenPriceChange ?? item.bidOpenPriceChange);
  return {
    exchange: 'bitget', symbol, last: mid, mid: mid, bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null, high: Number(item.highPrice) || null, low: Number(item.lowPrice) || null,
    percentage: Number.isFinite(change) ? change * 100 : null,
    timestamp: Number(item.quoteTime) || Number(payload.requestTime) || null,
    priceType: 'bid-ask-midpoint', source: 'cloudflare-edge', productType: 'cfd'
  };
}

function normalizeCandles(payload, symbol, timeframe, side) {
  const candles = (Array.isArray(payload.data) ? payload.data : [])
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => row.slice(0, 5).map(Number))
    .filter((row) => row.every(Number.isFinite) && row[2] >= row[3])
    .map(([timestamp, open, high, low, close]) => [timestamp, open, high, low, close, 0])
    .sort((a, b) => a[0] - b[0]);
  if (!candles.length) throw jsonError('Bitget CFD returned no ' + side + '-side candles for ' + symbol + '.', 404, 'BITGET_CFD_CANDLES_UNAVAILABLE');
  return { exchange: 'bitget', symbol, timeframe, side, candles, volumeAvailable: false, source: 'cloudflare-edge', productType: 'cfd' };
}

export function createBitgetCfdProvider({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  return {
    async request(env, { kind, symbol, timeframe = '1h', side = 'buy', search = '', limit = 100 } = {}) {
      if (kind === 'diagnostics') {
        const payload = await signedGet(env, '/api/v3/account/info', {}, { fetchImpl, now });
        const account = payload.data || {};
        const permissionType = String(account.permType || '').toLowerCase();
        const permissions = Array.isArray(account.permissions) ? account.permissions.map((value) => String(value).toLowerCase()) : [];
        const readOnly = permissionType === 'read-only' || permissionType === 'read_only' || permissionType === 'readonly';
        const ipEntries = String(account.ips || '').split(/[;,\\s]+/).filter(Boolean);
        return { status: 200, body: {
          exchange: 'bitget', productType: 'cfd', authenticated: true,
          permissionType: account.permType || null, permissions,
          utaTradeReadOnly: readOnly && permissions.includes('uta_trade'),
          ipWhitelistConfigured: ipEntries.length > 0, ipWhitelistCount: ipEntries.length,
          source: 'cloudflare-edge'
        } };
      }
      if (kind === 'markets') {
        const payload = await signedGet(env, '/api/v3/cfd/account/instruments', {}, { fetchImpl, now });
        const all = normalizeInstruments(payload);
        const needle = String(search).trim().toLowerCase();
        const markets = needle ? all.filter((item) => item.symbol.toLowerCase().includes(needle)) : all;
        return { status: 200, body: {
          exchange: 'bitget', filter: 'cfd', count: markets.length, totalMarkets: all.length, markets,
          counts: { cfd: all.length, spot: 0, margin: 0, futures: 0, perpetual: 0, options: 0 },
          timeframes: Object.keys(CFD_TIMEFRAMES),
          capabilities: { fetchTicker: true, fetchOHLCV: true, cfd: true, fetchOrderBook: false, createOrder: false },
          source: 'cloudflare-edge', fetchedAt: new Date(now()).toISOString(),
          note: 'Bitget CFD instruments are read from the authenticated UTA read-only instruments endpoint.'
        } };
      }
      const market = safeInstrument(symbol);
      if (kind === 'ticker') {
        const payload = await signedGet(env, '/api/v3/cfd/market/tickers', { symbol: market }, { fetchImpl, now });
        return { status: 200, body: normalizeTicker(payload, market) };
      }
      if (kind === 'ohlcv') {
        const frame = CFD_TIMEFRAMES[String(timeframe)];
        if (!frame) throw jsonError('Bitget CFD supports 1m, 15m, 1h, 4h and 1d candles.', 400, 'BITGET_CFD_TIMEFRAME_UNSUPPORTED');
        const candleSide = String(side).toLowerCase();
        if (!['buy', 'sell'].includes(candleSide)) throw jsonError('CFD candle side must be buy or sell.', 400, 'BITGET_CFD_SIDE_INVALID');
        const candleLimit = Math.min(100, Math.max(20, Number.parseInt(limit || '100', 10) || 100));
        const payload = await signedGet(env, '/api/v3/cfd/market/history-candlestick', {
          symbol: market, interval: frame, side: candleSide, limit: candleLimit
        }, { fetchImpl, now });
        return { status: 200, body: normalizeCandles(payload, market, frame, candleSide) };
      }
      throw jsonError('Unsupported Bitget CFD market route.', 404, 'BITGET_CFD_ROUTE_UNSUPPORTED');
    }
  };
}

export const BITGET_CFD_TIMEFRAMES = Object.keys(CFD_TIMEFRAMES);
