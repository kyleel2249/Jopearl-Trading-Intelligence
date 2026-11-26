export const REPLICATION_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx', 'bitget']);
export const BITGET_MARKET_TYPES = Object.freeze(['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m']);
export const DEFAULT_REPLICATION_SYMBOLS = Object.freeze(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'DOGE/USDT']);
export const DEFAULT_REPLICATION_TIMEFRAMES = Object.freeze(['1m', '5m', '15m', '1h']);

const SYMBOL_PATTERN = /^[A-Z0-9._-]{2,20}\/[A-Z0-9._-]{2,20}(?::[A-Z0-9._-]{2,20})?$/;
const TIMEFRAME_PATTERN = /^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|1w|1M)$/;

const boundedList = (value, fallback, max, normalise) => {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : fallback;
  return [...new Set(input.map(normalise).filter(Boolean))].slice(0, max);
};

export function normalizeReplicationPlan(input = {}, env = {}) {
  const exchanges = boundedList(input.exchanges ?? env.JPTI_REPLICATION_EXCHANGES, REPLICATION_EXCHANGES, 4, value => {
    const id = String(value || '').trim().toLowerCase();
    return REPLICATION_EXCHANGES.includes(id) ? id : null;
  });
  const symbols = boundedList(input.symbols ?? env.JPTI_REPLICATION_SYMBOLS, DEFAULT_REPLICATION_SYMBOLS, 20, value => {
    const symbol = String(value || '').trim().toUpperCase().replace('-', '/');
    return SYMBOL_PATTERN.test(symbol) ? symbol : null;
  });
  const timeframes = boundedList(input.timeframes ?? env.JPTI_REPLICATION_TIMEFRAMES, DEFAULT_REPLICATION_TIMEFRAMES, 6, value => {
    const timeframe = String(value || '').trim();
    return TIMEFRAME_PATTERN.test(timeframe) ? timeframe : null;
  });
  const requestedTypes = boundedList(input.marketTypes ?? env.JPTI_REPLICATION_MARKET_TYPES, BITGET_MARKET_TYPES, 5, value => {
    const type = String(value || '').trim().toLowerCase();
    return BITGET_MARKET_TYPES.includes(type) ? type : null;
  });
  const limit = Math.max(1, Math.min(20, Number.parseInt(input.marketLimit ?? env.JPTI_REPLICATION_MARKET_LIMIT ?? '8', 10) || 8));
  const candleLimit = Math.max(20, Math.min(200, Number.parseInt(input.candleLimit ?? env.JPTI_REPLICATION_CANDLE_LIMIT ?? '100', 10) || 100));
  const includeCandles = input.includeCandles !== false;
  if (!exchanges.length) throw Object.assign(new Error('At least one supported exchange is required.'), { status: 400 });
  if (!symbols.length) throw Object.assign(new Error('At least one valid BASE/QUOTE symbol is required.'), { status: 400 });
  if (!timeframes.length && includeCandles) throw Object.assign(new Error('At least one supported candle timeframe is required.'), { status: 400 });
  return { exchanges, symbols, timeframes: includeCandles ? timeframes : [], marketTypes: requestedTypes, limit, candleLimit, includeCandles };
}

export function marketTypesForExchange(exchange, requestedTypes = BITGET_MARKET_TYPES) {
  return exchange === 'bitget' ? requestedTypes : ['spot'];
}

export function selectReplicationMarkets(markets, symbols, limit) {
  const allowed = new Set(symbols.map(value => String(value).toUpperCase()));
  const rows = (Array.isArray(markets) ? markets : []).filter(market => {
    if (!market || market.active === false || !market.symbol) return false;
    const symbol = String(market.symbol).toUpperCase();
    const base = symbol.split('/')[0];
    return allowed.has(symbol) || allowed.has(base + '/USDT') || allowed.has(base + '/USDC');
  });
  rows.sort((a, b) => {
    const rank = market => {
      const base = String(market.symbol || '').split('/')[0];
      const index = symbols.findIndex(symbol => symbol.split('/')[0] === base);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    return rank(a) - rank(b) || String(a.symbol).localeCompare(String(b.symbol));
  });
  return rows.slice(0, limit);
}

const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function normalizeTickerObservation({ exchange, marketType, ticker, symbol, receivedAt = Date.now() }) {
  if (!ticker || typeof ticker !== 'object') return null;
  const price = finite(ticker.last);
  const timestamp = finite(ticker.timestamp);
  if (!(price > 0) || !(timestamp > 0)) return null;
  const bid = finite(ticker.bid), ask = finite(ticker.ask);
  const spreadPct = bid > 0 && ask >= bid ? ((ask - bid) / ((ask + bid) / 2)) * 100 : null;
  return {
    exchange, marketType, symbol: symbol || ticker.symbol, kind: 'ticker',
    observedAt: new Date(timestamp).toISOString(), receivedAt: new Date(receivedAt).toISOString(),
    last: price, bid, ask, high: finite(ticker.high), low: finite(ticker.low),
    baseVolume: finite(ticker.baseVolume), quoteVolume: finite(ticker.quoteVolume),
    changePct: finite(ticker.percentage), spreadPct,
    quality: { timestamped: true, positivePrice: true, validSpread: spreadPct === null || spreadPct >= 0, stale: receivedAt - timestamp > 30000 }
  };
}

export function normalizeCandleObservations({ exchange, marketType, symbol, timeframe, candles, receivedAt = Date.now() }) {
  if (!Array.isArray(candles)) return [];
  const unique = new Map();
  for (const row of candles) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [timestamp, open, high, low, close, volume] = row.slice(0, 6).map(finite);
    if (!(timestamp > 0) || ![open, high, low, close, volume].every(Number.isFinite)) continue;
    if (!(open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0 && high >= Math.max(open, close, low) && low <= Math.min(open, close, high))) continue;
    unique.set(timestamp, {
      exchange, marketType, symbol, kind: 'ohlcv', timeframe,
      observedAt: new Date(timestamp).toISOString(), receivedAt: new Date(receivedAt).toISOString(),
      open, high, low, close, volume,
      quality: { timestamped: true, validOhlc: true, nonNegativeVolume: true, stale: receivedAt - timestamp > 2 * timeframeMs(timeframe) }
    });
  }
  return [...unique.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
}

export function timeframeMs(timeframe) {
  const match = String(timeframe || '').match(/^(\d+)(m|h|d|w|M)$/);
  if (!match) return 60000;
  const amount = Number(match[1]);
  const unit = match[2] === 'm' ? 60000 : match[2] === 'h' ? 3600000 : match[2] === 'd' ? 86400000 : match[2] === 'w' ? 604800000 : 2592000000;
  return amount * unit;
}

export function replicationObservationKey(observation) {
  return [observation.exchange, observation.marketType, observation.symbol, observation.kind, observation.timeframe || 'na', observation.observedAt]
    .map(value => encodeURIComponent(String(value || 'na'))).join('|');
}

export function buildReplicationSummary({ startedAt, finishedAt, plan, counts, errors, skipped, runId }) {
  const attempted = counts.attempted || 0;
  const stored = counts.inserted || 0;
  return {
    runId, startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    status: errors.length ? stored ? 'partial' : 'failed' : 'completed',
    plan, counts: { ...counts, attempted, inserted: stored, duplicates: Math.max(0, (counts.valid || 0) - stored) },
    errorCount: errors.length, skippedCount: skipped.length, errors: errors.slice(0, 30), skipped: skipped.slice(0, 30),
    coverage: { successRatePct: attempted ? Number(((counts.succeeded || 0) / attempted * 100).toFixed(2)) : 0 }
  };
}
