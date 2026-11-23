import express from 'express';
import { withExchange } from './exchanges.js';
import { requirePrivateApiAuth } from './policy.js';

export const advancedRouter = express.Router();
const snapshots = new Map();
const cache = new Map();
const finite = (n) => Number.isFinite(Number(n)) ? Number(n) : null;
const median = (values) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return !a.length ? null : a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function calculateForecast(candles, horizons = [1, 4, 12, 24], barMinutes = 60) {
  const rows = candles.filter((c) => Array.isArray(c) && c.length >= 6 && c.slice(1, 6).every((v) => Number.isFinite(Number(v))) && Number(c[4]) > 0);
  if (rows.length < 30) throw Object.assign(new Error('At least 30 valid OHLCV candles are required.'), { status: 422 });
  const closes = rows.map((c) => Number(c[4]));
  const highs = rows.map((c) => Number(c[2]));
  const lows = rows.map((c) => Number(c[3]));
  const last = closes.at(-1);
  const returns = closes.slice(1).map((v, i) => Math.log(v / closes[i]));
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const sigma = Math.sqrt(variance);
  const tr = rows.slice(1).map((c, i) => Math.max(Number(c[2]) - Number(c[3]), Math.abs(Number(c[2]) - closes[i]), Math.abs(Number(c[3]) - closes[i])));
  const atr = tr.slice(-14).reduce((s, v) => s + v, 0) / Math.min(14, tr.length);
  const recent = closes.slice(-20);
  const momentum = recent.length > 1 ? recent.at(-1) / recent[0] - 1 : 0;
  const drift = clamp(mean + momentum / Math.max(20, recent.length) * 0.35, -sigma * 0.5, sigma * 0.5);
  const rangeHigh = Math.max(...highs.slice(-24));
  const rangeLow = Math.min(...lows.slice(-24));
  const results = horizons.map((hours) => {
    const steps = Math.max(1, (hours * 60) / barMinutes);
    const projectedSigma = sigma * Math.sqrt(steps);
    const expected = last * Math.exp(drift * steps);
    const q = 1.28 * projectedSigma;
    const atrMove = atr * Math.sqrt(steps);
    const upper = Math.max(expected * Math.exp(q), last + atrMove);
    const lower = Math.min(expected * Math.exp(-q), last - atrMove);
    return {
      horizonHours: hours, horizonBars: steps, referencePrice: last, expectedMid: expected,
      forecastHigh: upper, forecastLow: Math.max(Number.EPSILON, lower),
      upsidePercent: (upper / last - 1) * 100, downsidePercent: (lower / last - 1) * 100,
      intervalMethod: 'historical log-return volatility envelope widened by ATR',
      nominalCoverage: 'model-derived; not calibrated until walk-forward validation',
      scenarios: {
        conservative: { high: Math.min(upper, last + atrMove), low: Math.max(Number.EPSILON, last - atrMove) },
        base: { high: upper, low: lower },
        aggressive: { high: last * Math.exp(Math.max(drift * steps, 0) + 2 * projectedSigma), low: last * Math.exp(Math.min(drift * steps, 0) - 2 * projectedSigma) }
      },
      recentRange24Bars: { high: rangeHigh, low: rangeLow }
    };
  });
  return {
    generatedAt: new Date().toISOString(), referencePrice: last, candlesUsed: rows.length,
    volatilityPerCandlePercent: sigma * 100, atr, momentum20Percent: momentum * 100,
    method: 'statistical baseline: log-return volatility + ATR + bounded drift',
    forecasts: results,
    limitations: ['These are estimates, not exchange-published future highs/lows.', 'Coverage probabilities are not calibrated probabilities until sufficient walk-forward testing.', 'No machine-learning model is claimed or trained by this baseline.', 'Forecast quality depends on timeframe, liquidity, market regime and candle quality.']
  };
}

export function analyzeOrderBook(book, previous = null, now = Date.now()) {
  const bids = (book.bids || []).filter((x) => finite(x[0]) > 0 && finite(x[1]) > 0);
  const asks = (book.asks || []).filter((x) => finite(x[0]) > 0 && finite(x[1]) > 0);
  const bidDepth = bids.reduce((s, x) => s + x[0] * x[1], 0);
  const askDepth = asks.reduce((s, x) => s + x[0] * x[1], 0);
  const imbalance = bidDepth + askDepth ? (bidDepth - askDepth) / (bidDepth + askDepth) : null;
  const walls = (levels, side) => {
    const sizes = levels.map((x) => x[0] * x[1]);
    const baseline = median(sizes) || 0;
    return levels.filter((x) => x[0] * x[1] > baseline * 5 && x[0] * x[1] > 0).slice(0, 8).map((x) => ({ side, price: x[0], quantity: x[1], notional: x[0] * x[1], multipleOfMedian: baseline ? x[0] * x[1] / baseline : null }));
  };
  const currentWalls = [...walls(bids, 'bid'), ...walls(asks, 'ask')];
  const key = (w) => w.side + ':' + Number(w.price).toPrecision(8);
  const previousMap = new Map((previous?.walls || []).map((w) => [key(w), w]));
  const wallChanges = currentWalls.map((w) => {
    const old = previousMap.get(key(w));
    return { ...w, persistence: old ? 'observed-in-consecutive-snapshots' : 'newly-observed', priorNotional: old?.notional ?? null };
  });
  return {
    sampledAt: new Date(now).toISOString(), bidDepthNotional: bidDepth, askDepthNotional: askDepth,
    depthImbalance: imbalance, pressure: imbalance == null ? 'unavailable' : imbalance > 0.15 ? 'bid-dominant' : imbalance < -0.15 ? 'ask-dominant' : 'balanced',
    spread: bids[0] && asks[0] ? asks[0][0] - bids[0][0] : null,
    spreadPercent: bids[0] && asks[0] ? ((asks[0][0] - bids[0][0]) / ((asks[0][0] + bids[0][0]) / 2)) * 100 : null,
    liquidityWalls: wallChanges,
    alerts: wallChanges.filter((w) => w.persistence === 'newly-observed').map((w) => ({ type: 'new-large-visible-order', side: w.side, price: w.price, note: 'Large visible order; intent cannot be inferred from one or two snapshots.' })),
    spoofingAssessment: 'NOT_DETERMINED: spoofing requires order-level add/cancel/replace history and venue surveillance data; snapshots cannot prove intent.'
  };
}

export function buildEvidenceCouncil(evidence = {}) {
  const price = finite(evidence.priceChangePct);
  const volume = finite(evidence.volumeChangePct);
  const imbalance = finite(evidence.depthImbalance);
  const funding = finite(evidence.fundingRate);
  const oi = finite(evidence.openInterestChangePct);
  const agents = [
    { id: 'trend', specialty: 'trend and momentum', bias: price == null ? 'insufficient-data' : price > 0.5 ? 'bullish' : price < -0.5 ? 'bearish' : 'neutral', evidence: price == null ? [] : [{ metric: 'priceChangePct', value: price }] },
    { id: 'volume', specialty: 'participation and volume', bias: volume == null ? 'insufficient-data' : volume > 20 ? 'bullish-confirmation' : volume < -20 ? 'weak-participation' : 'neutral', evidence: volume == null ? [] : [{ metric: 'volumeChangePct', value: volume }] },
    { id: 'microstructure', specialty: 'order-book pressure', bias: imbalance == null ? 'insufficient-data' : imbalance > 0.15 ? 'bullish' : imbalance < -0.15 ? 'bearish' : 'neutral', evidence: imbalance == null ? [] : [{ metric: 'depthImbalance', value: imbalance }] },
    { id: 'derivatives', specialty: 'funding and open-interest risk', bias: funding == null && oi == null ? 'insufficient-data' : funding > 0.001 && oi > 0 ? 'crowded-long-risk' : funding < -0.001 && oi > 0 ? 'crowded-short-risk' : 'mixed', evidence: [{ metric: 'fundingRate', value: funding }, { metric: 'openInterestChangePct', value: oi }].filter((x) => x.value != null) },
    { id: 'risk', specialty: 'risk and data quality', bias: evidence.stale ? 'data-quality-warning' : 'risk-review-required', evidence: [{ metric: 'stale', value: Boolean(evidence.stale) }] }
  ];
  const directional = agents.filter((a) => ['bullish', 'bearish'].includes(a.bias));
  const bull = directional.filter((a) => a.bias === 'bullish').length;
  const bear = directional.filter((a) => a.bias === 'bearish').length;
  const agreement = directional.length ? Math.max(bull, bear) / directional.length : 0;
  return { generatedAt: new Date().toISOString(), agents, consensus: bull > bear ? 'bullish-lean' : bear > bull ? 'bearish-lean' : 'no-directional-consensus', agreementRatio: agreement, evidenceCount: agents.reduce((n, a) => n + a.evidence.filter((x) => x.value != null).length, 0), confidence: directional.length >= 3 && agreement >= 0.75 ? 'moderate' : 'low', dissent: bull && bear ? 'Specialists disagree; preserve both views and reduce confidence.' : null, note: 'Deterministic evidence agents, not autonomous LLM traders. No order is generated.' };
}

export function backtestEmaStrategy(candles, fast = 9, slow = 21, feeBps = 10) {
  if (!Array.isArray(candles) || candles.length < slow + 10 || fast < 2 || slow <= fast || slow > 200) throw new Error('Need sufficient candles and valid fast/slow EMA parameters.');
  const closes = candles.map((c) => Number(c[4]));
  if (closes.some((x) => !Number.isFinite(x) || x <= 0)) throw new Error('Candles contain invalid close prices.');
  const ema = (period) => {
    const alpha = 2 / (period + 1); const out = Array(closes.length).fill(null);
    out[0] = closes[0]; for (let i = 1; i < closes.length; i++) out[i] = closes[i] * alpha + out[i - 1] * (1 - alpha);
    return out;
  };
  const a = ema(fast), b = ema(slow); let position = 0, equity = 1, peak = 1, maxDrawdown = 0, trades = 0, wins = 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const signal = a[i - 1] <= b[i - 1] && a[i] > b[i] ? 1 : a[i - 1] >= b[i - 1] && a[i] < b[i] ? 0 : position;
    const barReturn = (closes[i] / closes[i - 1] - 1) * position;
    equity *= Math.max(0.000001, 1 + barReturn);
    if (signal !== position) { equity *= Math.max(0.000001, 1 - feeBps / 10000); trades++; if (barReturn > 0) wins++; position = signal; }
    returns.push(barReturn); peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const avg = returns.reduce((s, x) => s + x, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((s, x) => s + (x - avg) ** 2, 0) / Math.max(1, returns.length - 1);
  return { strategy: 'EMA crossover long/flat baseline', parameters: { fast, slow, feeBps }, candles: closes.length, equityMultiple: equity, returnPercent: (equity - 1) * 100, maxDrawdownPercent: maxDrawdown * 100, trades, winRatePercent: trades ? wins / trades * 100 : null, volatilityPerBarPercent: Math.sqrt(variance) * 100, validation: 'in-sample baseline only; use walk-forward/out-of-sample before any deployment', execution: 'no leverage, funding, spread, market impact or partial fills modeled' };
}

export function monteCarloReturns(returns, paths = 500, steps = 100, seed = 17) {
  if (!returns.length || paths < 50 || paths > 5000 || steps < 1 || steps > 1000) throw new Error('Provide returns and paths 50–5000, steps 1–1000.');
  let state = seed >>> 0;
  const random = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const finals = [];
  for (let p = 0; p < paths; p++) { let equity = 1; for (let i = 0; i < steps; i++) equity *= Math.max(0.000001, 1 + returns[Math.floor(random() * returns.length)]); finals.push(equity); }
  return { paths, steps, seed, finalEquityQuantiles: { p05: quantile(finals, .05), p50: quantile(finals, .5), p95: quantile(finals, .95) }, note: 'Bootstrap scenario distribution from supplied historical returns; not a forecast guarantee.' };
}
function quantile(a, p) { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; }

advancedRouter.get('/advanced/forecast/:exchange/:symbol', async (req, res) => {
  try {
    const exchangeId = req.params.exchange.toLowerCase();
    const symbol = req.params.symbol.toUpperCase().replace('-', '/');
    const timeframe = String(req.query.timeframe || '1h');
    const limit = clamp(Number.parseInt(req.query.limit || '500', 10) || 500, 100, 1000);
    const candles = await withExchange(exchangeId, { privateAccess: false }, async (ex) => {
      if (!ex.markets[symbol] || !ex.has?.fetchOHLCV) throw Object.assign(new Error('Market or OHLCV capability unavailable.'), { status: 404 });
      if (ex.timeframes && !ex.timeframes[timeframe]) throw Object.assign(new Error('Unsupported timeframe.'), { status: 400 });
      return ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    });
    const unit = timeframe.at(-1);
    const amount = Number.parseInt(timeframe, 10);
    const barMinutes = unit === 'm' ? amount : unit === 'h' ? amount * 60 : unit === 'd' ? amount * 1440 : unit === 'w' ? amount * 10080 : unit === 'M' ? amount * 43200 : 60;
    res.json({ exchange: exchangeId, symbol, timeframe, ...calculateForecast(candles, [1, 4, 12, 24], barMinutes) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

advancedRouter.get('/advanced/orderbook/:exchange/:symbol', async (req, res) => {
  try {
    const exchangeId = req.params.exchange.toLowerCase();
    const symbol = req.params.symbol.toUpperCase().replace('-', '/');
    const limit = clamp(Number.parseInt(req.query.limit || '50', 10) || 50, 5, 100);
    const book = await withExchange(exchangeId, { privateAccess: false }, async (ex) => {
      if (!ex.markets[symbol] || !ex.has?.fetchOrderBook) throw Object.assign(new Error('Order book unavailable for this market.'), { status: 404 });
      return ex.fetchOrderBook(symbol, limit);
    });
    const key = exchangeId + ':' + symbol;
    const result = analyzeOrderBook(book, snapshots.get(key));
    snapshots.set(key, { walls: result.liquidityWalls, sampledAt: result.sampledAt });
    res.json({ exchange: exchangeId, symbol, ...result, note: 'Visible depth only; hidden liquidity and queue position are unknown.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

advancedRouter.get('/advanced/derivatives/:exchange/:symbol', async (req, res) => {
  try {
    const exchangeId = req.params.exchange.toLowerCase();
    const symbol = req.params.symbol.toUpperCase().replace('-', '/');
    const result = await withExchange(exchangeId, { privateAccess: false }, async (ex) => {
      const market = ex.markets[symbol];
      if (!market) throw Object.assign(new Error('Market not found.'), { status: 404 });
      const tasks = {};
      if (market.contract && ex.has?.fetchFundingRate) tasks.funding = ex.fetchFundingRate(symbol).catch((e) => ({ unavailable: e.message }));
      if (market.contract && ex.has?.fetchOpenInterest) tasks.openInterest = ex.fetchOpenInterest(symbol).catch((e) => ({ unavailable: e.message }));
      if (market.contract && ex.has?.fetchTicker) tasks.ticker = ex.fetchTicker(symbol).catch((e) => ({ unavailable: e.message }));
      const entries = await Promise.all(Object.entries(tasks).map(async ([k, p]) => [k, await p]));
      return Object.fromEntries(entries);
    });
    res.json({ exchange: exchangeId, symbol, ...result, liquidationClusters: { status: 'unavailable', reason: 'Requires venue-specific liquidation stream/history; not inferred from candles.' }, basis: result.ticker?.last && result.ticker?.indexPrice ? { value: result.ticker.last - result.ticker.indexPrice, percent: (result.ticker.last / result.ticker.indexPrice - 1) * 100 } : { status: 'unavailable' }, note: 'Only exchange-reported fields are shown. Missing derivatives capabilities remain unavailable.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});

advancedRouter.post('/advanced/council', (req, res) => res.json(buildEvidenceCouncil(req.body || {})));
advancedRouter.post('/advanced/backtest/ema', (req, res) => {
  try {
    const { candles, fast, slow, feeBps } = req.body || {};
    const result = backtestEmaStrategy(candles, fast || 9, slow || 21, feeBps ?? 10);
    res.json(result);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
advancedRouter.post('/advanced/monte-carlo', (req, res) => {
  try { const { returns, paths, steps, seed } = req.body || {}; res.json(monteCarloReturns(returns || [], paths || 500, steps || 100, seed || 17)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
advancedRouter.post('/advanced/portfolio/reconcile', (req, res) => {
  try { requirePrivateApiAuth(req); } catch (e) { return res.status(401).json({ error: e.message }); }
  const { balances = [], openingBalances = [], fills = [] } = req.body || {};
  if (!Array.isArray(balances) || !Array.isArray(openingBalances) || !Array.isArray(fills) || balances.length > 500 || openingBalances.length > 500 || fills.length > 5000) return res.status(400).json({ error: 'Invalid reconciliation payload.' });
  const opening = new Map();
  for (const item of openingBalances) {
    const amount = finite(item.total);
    if (!item.currency || amount == null) return res.status(400).json({ error: 'Opening balances require currency and numeric total.' });
    opening.set(item.currency, amount);
  }
  const delta = new Map();
  const add = (currency, amount) => delta.set(currency, (delta.get(currency) || 0) + amount);
  for (const fill of fills) {
    const qty = finite(fill.quantity), price = finite(fill.price), fee = finite(fill.fee ?? 0);
    if (qty == null || qty <= 0 || price == null || price <= 0 || fee == null || fee < 0 || !['buy', 'sell'].includes(fill.side) || !fill.base || !fill.quote) return res.status(400).json({ error: 'Each fill requires base/quote, buy/sell side, positive quantity and price, and a non-negative fee.' });
    add(fill.base, fill.side === 'buy' ? qty : -qty);
    add(fill.quote, fill.side === 'buy' ? -qty * price : qty * price);
    const feeCurrency = fill.feeCurrency || fill.quote;
    if (fee > 0) add(feeCurrency, -fee);
  }
  const rows = balances.map((b) => {
    const hasOpening = opening.has(b.currency);
    const expected = hasOpening ? opening.get(b.currency) + (delta.get(b.currency) || 0) : null;
    const reported = finite(b.total);
    return { currency: b.currency, reported, openingBalance: hasOpening ? opening.get(b.currency) : null, fillDelta: delta.get(b.currency) || 0, ledgerExpected: expected, difference: expected != null && reported != null ? reported - expected : null, status: expected == null ? 'missing-opening-balance' : reported == null ? 'invalid-reported-balance' : Math.abs(reported - expected) < 1e-8 ? 'matched' : 'variance' };
  });
  res.json({ generatedAt: new Date().toISOString(), balances: rows, unmatchedCurrencies: [...delta.keys()].filter((c) => !balances.some((b) => b.currency === c)), realizedPnl: 'not calculated: requires lot accounting, trade matching and full fee/transfer history', unrealizedPnl: 'not calculated: requires mark prices and position lots', note: 'Opening balances are mandatory for meaningful comparisons. Reconciliation is only as complete as supplied opening balances, fills, fees, transfers and external cash movements. This endpoint does not fetch exchange accounts automatically.' });
});

advancedRouter.post('/advanced/execution/estimate', (req, res) => {
  const { side, quantity, book, feeRate = 0.001 } = req.body || {};
  const qty = finite(quantity), fee = finite(feeRate);
  if (!['buy', 'sell'].includes(side) || !qty || qty <= 0 || !book || !Array.isArray(book[side === 'buy' ? 'asks' : 'bids']) || fee == null || fee < 0 || fee > .05) return res.status(400).json({ error: 'Valid side, quantity, order book and feeRate (0–5%) required.' });
  let remaining = qty, notional = 0, filled = 0;
  for (const [price, amount] of book[side === 'buy' ? 'asks' : 'bids']) {
    const take = Math.min(remaining, Number(amount));
    if (take > 0 && Number(price) > 0) { filled += take; notional += take * Number(price); remaining -= take; }
    if (remaining <= 1e-12) break;
  }
  const mid = book.bids?.[0]?.[0] && book.asks?.[0]?.[0] ? (book.bids[0][0] + book.asks[0][0]) / 2 : null;
  const avg = filled ? notional / filled : null;
  res.json({ side, requestedQuantity: qty, filledQuantity: filled, unfilledQuantity: remaining, averageFillPrice: avg, estimatedNotional: notional, estimatedFee: notional * fee, slippageFromMidPercent: avg && mid ? (side === 'buy' ? avg / mid - 1 : 1 - avg / mid) * 100 : null, feeRate: fee, note: 'Indicative book-walk estimate; excludes queue priority, hidden liquidity, latency, market impact beyond displayed levels and fee-tier discounts.' });
});
