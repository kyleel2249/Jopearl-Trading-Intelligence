export const REPLICATION_EXCHANGES = Object.freeze(['binance', 'bybit', 'okx', 'bitget']);
export const BITGET_MARKET_TYPES = Object.freeze(['spot', 'margin', 'usdt-m', 'coin-m', 'usdc-m']);
export const DEFAULT_REPLICATION_SYMBOLS = Object.freeze(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'BNB/USDT', 'DOGE/USDT', 'BTC/USD:BTC', 'BTC/USDC:USDC']);
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

export function boundReplicationPlanToSubrequestBudget(plan, groupCount, maxSubrequests = 45) {
  const groups = Math.max(1, Number(groupCount) || 1);
  const budget = Math.max(groups + 1, Math.min(45, Number(maxSubrequests) || 45));
  const timeframes = [...plan.timeframes];
  const includeCandles = plan.includeCandles;
  while (includeCandles && timeframes.length > 1 && groups + groups * (1 + timeframes.length) > budget) timeframes.pop();
  const perMarketRequests = 1 + (includeCandles ? timeframes.length : 0);
  const safeMarketLimit = Math.max(1, Math.floor((budget - groups) / (groups * perMarketRequests)));
  const limit = Math.min(plan.limit, safeMarketLimit);
  return {
    ...plan, limit, timeframes,
    requestBudget: { maxSubrequests: budget, estimatedSubrequests: groups + groups * limit * perMarketRequests, marketGroups: groups, requestsPerMarket: perMarketRequests }
  };
}

export function marketTypesForExchange(exchange, requestedTypes = BITGET_MARKET_TYPES) {
  return exchange === 'bitget' ? requestedTypes : ['spot'];
}

export function selectReplicationMarkets(markets, symbols, limit) {
  const allowed = new Set(symbols.map(value => String(value).toUpperCase()));
  const rows = (Array.isArray(markets) ? markets : []).filter(market => {
    if (!market || market.active === false || !market.symbol) return false;
    const symbol = String(market.symbol).toUpperCase();
    const pair = symbol.split(':')[0];
    return allowed.has(symbol) || allowed.has(pair);
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
      quality: { timestamped: true, validOhlc: true, nonNegativeVolume: true, stale: false }
    });
  }
  const rows = [...unique.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const latestTimestamp = rows.length ? Date.parse(rows.at(-1).observedAt) : 0;
  const stale = latestTimestamp > 0 && receivedAt - latestTimestamp > 2 * timeframeMs(timeframe);
  return rows.map(row => ({ ...row, quality: { ...row.quality, stale } }));
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


export function detectCandleGaps(observations = []) {
  const groups = new Map();
  for (const row of observations) {
    if (row?.kind !== 'ohlcv' || !row.timeframe) continue;
    const key = [row.exchange, row.marketType, row.symbol, row.timeframe].join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const gaps = [];
  for (const [key, rows] of groups) {
    const interval = timeframeMs(rows[0].timeframe);
    const sorted = [...rows].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = Date.parse(sorted[index - 1].observedAt);
      const current = Date.parse(sorted[index].observedAt);
      const missing = Math.max(0, Math.floor((current - previous) / interval) - 1);
      if (missing > 0) gaps.push({ key, exchange: sorted[index].exchange, marketType: sorted[index].marketType, symbol: sorted[index].symbol, timeframe: sorted[index].timeframe, missingCandles: missing, after: sorted[index - 1].observedAt, before: sorted[index].observedAt });
    }
  }
  return { groups: groups.size, gapCount: gaps.length, missingCandles: gaps.reduce((sum, gap) => sum + gap.missingCandles, 0), gaps: gaps.slice(0, 100) };
}

export function buildCrossExchangeConsensus(observations = [], outlierThresholdPct = 0.5) {
  const groups = new Map();
  for (const row of observations) {
    if (row?.kind !== 'ticker' || row.marketType !== 'spot' || !(row.last > 0)) continue;
    if (!groups.has(row.symbol)) groups.set(row.symbol, []);
    groups.get(row.symbol).push(row);
  }
  return [...groups.entries()].map(([symbol, rows]) => {
    const prices = rows.map(row => row.last).sort((a, b) => a - b);
    const middle = Math.floor(prices.length / 2);
    const median = prices.length % 2 ? prices[middle] : (prices[middle - 1] + prices[middle]) / 2;
    const min = prices[0], max = prices.at(-1);
    const dispersionPct = median > 0 ? ((max - min) / median) * 100 : null;
    return {
      symbol, venueCount: rows.length, medianPrice: median, minPrice: min, maxPrice: max,
      dispersionPct: dispersionPct === null ? null : Number(dispersionPct.toFixed(5)),
      outliers: rows.filter(row => Math.abs((row.last - median) / median * 100) > outlierThresholdPct).map(row => ({ exchange: row.exchange, price: row.last, deviationPct: Number(((row.last - median) / median * 100).toFixed(5)) })),
      sources: rows.map(row => ({ exchange: row.exchange, observedAt: row.observedAt, receivedAt: row.receivedAt })),
      interpretation: rows.length < 2 ? 'single-venue-observation' : 'indicative-cross-venue-reference-not-executable'
    };
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export function buildReplicationSummary({ startedAt, finishedAt, plan, counts, errors, skipped, runId }) {
  const attempted = counts.attempted || 0;
  const stored = counts.inserted || 0;
  return {
    runId, startedAt, finishedAt, durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    status: errors.length ? counts.valid ? 'partial' : 'failed' : counts.valid ? 'completed' : 'failed',
    plan, counts: { ...counts, attempted, inserted: stored, duplicates: Math.max(0, (counts.valid || 0) - stored) },
    errorCount: errors.length, skippedCount: skipped.length, errors: errors.slice(0, 30), skipped: skipped.slice(0, 30),
    coverage: { successRatePct: attempted ? Number(((counts.succeeded || 0) / attempted * 100).toFixed(2)) : 0 }
  };
}
