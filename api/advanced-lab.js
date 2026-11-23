import express from 'express';
import { withExchange } from './exchanges.js';
import { requirePrivateApiAuth } from './policy.js';
import { ingestLedgerEvent, getLedgerTransactions } from './operations.js';
import { analyzeOrderBook } from './advanced-intelligence.js';
import { calculateTradePerformance } from './performance.js';

export const labRouter = express.Router();
const finite = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function ema(values, period) {
  const alpha = 2 / (period + 1), out = Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  return out;
}
function metrics(returns) {
  let equity = 1, peak = 1, maxDrawdown = 0, wins = 0, losses = 0;
  const curve = [];
  for (const r of returns) {
    equity *= Math.max(1e-9, 1 + r);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if (r > 0) wins++; else if (r < 0) losses++;
    curve.push(equity);
  }
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1) : 0;
  return { totalReturnPercent: (equity - 1) * 100, endingEquityMultiple: equity, maxDrawdownPercent: maxDrawdown * 100,
    observations: returns.length, positiveBars: wins, negativeBars: losses, winBarRatePercent: returns.length ? wins / returns.length * 100 : null,
    volatilityPerBarPercent: Math.sqrt(variance) * 100, equityCurve: curve };
}
function runEma(candles, fast, slow, feeBps = 10) {
  const closes = candles.map((c) => Number(c[4]));
  const a = ema(closes, fast), b = ema(closes, slow);
  let position = 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    // A signal formed at candle i-1 is applied to candle i: no same-close look-ahead.
    const prior = i - 1;
    const nextPosition = a[prior] > b[prior] ? 1 : 0;
    const turnover = Math.abs(nextPosition - position);
    const gross = (closes[i] / closes[i - 1] - 1) * position;
    returns.push(gross - turnover * feeBps / 10000);
    position = nextPosition;
  }
  return returns;
}
function rsiSeries(closes, period) {
  const out = Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const change = closes[j] - closes[j - 1];
      if (change > 0) gains += change; else losses -= change;
    }
    const avgGain = gains / period, avgLoss = losses / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}
function runStrategy(candles, strategy, params, feeBps = 10) {
  if (strategy === 'ema') return runEma(candles, params.fast, params.slow, feeBps);
  const closes = candles.map(c => Number(c[4]));
  const rsi = strategy === 'rsi' ? rsiSeries(closes, params.period) : null;
  let position = 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prior = i - 1;
    let nextPosition = position;
    if (strategy === 'rsi' && rsi[prior] != null) {
      if (rsi[prior] <= params.oversold) nextPosition = 1;
      else if (rsi[prior] >= params.overbought) nextPosition = 0;
    } else if (strategy === 'donchian' && prior >= params.lookback) {
      const window = candles.slice(prior - params.lookback, prior);
      const upper = Math.max(...window.map(c => Number(c[2])));
      const lower = Math.min(...window.map(c => Number(c[3])));
      if (closes[prior] > upper) nextPosition = 1;
      else if (closes[prior] < lower) nextPosition = 0;
    }
    const gross = (closes[i] / closes[i - 1] - 1) * position;
    returns.push(gross - Math.abs(nextPosition - position) * feeBps / 10000);
    position = nextPosition;
  }
  return returns;
}
function validateCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 100 || candles.some(c => !Array.isArray(c) || !Number.isFinite(Number(c[4])) || Number(c[4]) <= 0)) {
    throw new Error('At least 100 valid OHLCV candles with positive closes are required.');
  }
}
export function runWalkForward(candles, options = {}) {
  validateCandles(candles);
  const trainBars = clamp(Number(options.trainBars || 500), 100, 5000);
  const testBars = clamp(Number(options.testBars || 100), 20, 2000);
  const stepBars = clamp(Number(options.stepBars || testBars), 20, 2000);
  const feeBps = clamp(Number(options.feeBps ?? 10), 0, 500);
  const strategy = String(options.strategy || 'ema').toLowerCase();
  let grid;
  if (strategy === 'ema') {
    const fastPeriods = [...new Set((options.fastPeriods || [5, 9, 12, 20]).map(Number).filter(x => Number.isInteger(x) && x >= 2 && x <= 100))];
    const slowPeriods = [...new Set((options.slowPeriods || [21, 30, 50, 100]).map(Number).filter(x => Number.isInteger(x) && x >= 3 && x <= 200))];
    grid = fastPeriods.flatMap(fast => slowPeriods.filter(slow => slow > fast).map(slow => ({ fast, slow })));
  } else if (strategy === 'rsi') {
    const periods = [...new Set((options.rsiPeriods || [7, 14, 21]).map(Number).filter(x => Number.isInteger(x) && x >= 3 && x <= 50))];
    const oversold = [...new Set((options.oversoldLevels || [20, 25, 30]).map(Number).filter(x => x >= 5 && x <= 45))];
    const overbought = [...new Set((options.overboughtLevels || [65, 70, 80]).map(Number).filter(x => x >= 55 && x <= 95))];
    grid = periods.flatMap(period => oversold.flatMap(low => overbought.filter(high => high > low).map(high => ({ period, oversold: low, overbought: high }))));
  } else if (strategy === 'donchian') {
    const lookbacks = [...new Set((options.lookbacks || [10, 20, 30, 50]).map(Number).filter(x => Number.isInteger(x) && x >= 5 && x <= 100))];
    grid = lookbacks.map(lookback => ({ lookback }));
  } else throw new Error('Unsupported strategy. Choose ema, rsi or donchian.');
  const maxWarmup = Math.max(30, ...grid.map(p => p.slow || p.period || p.lookback));
  if (!grid.length || trainBars < maxWarmup + 5) throw new Error('Invalid parameter grid or training window.');
  const folds = [];
  let testStart = trainBars;
  while (testStart + testBars <= candles.length && folds.length < 50) {
    const training = candles.slice(testStart - trainBars, testStart);
    const testing = candles.slice(testStart - maxWarmup - 1, testStart + testBars);
    let best = null;
    for (const p of grid) {
      const score = metrics(runStrategy(training, strategy, p, feeBps));
      const objective = score.totalReturnPercent - score.maxDrawdownPercent * 0.5;
      if (!best || objective > best.objective) best = { ...p, objective, trainingReturnPercent: score.totalReturnPercent, trainingMaxDrawdownPercent: score.maxDrawdownPercent };
    }
    const testReturns = runStrategy(testing, strategy, best, feeBps).slice(maxWarmup);
    folds.push({ fold: folds.length + 1, trainStart: training[0][0], trainEnd: training.at(-1)[0], testStart: candles[testStart][0], testEnd: candles[Math.min(testStart + testBars - 1, candles.length - 1)][0],
      selectedParameters: Object.fromEntries(Object.entries(best).filter(([key]) => !['objective','trainingReturnPercent','trainingMaxDrawdownPercent'].includes(key))),
      trainingReturnPercent: best.trainingReturnPercent, trainingMaxDrawdownPercent: best.trainingMaxDrawdownPercent,
      outOfSample: { ...metrics(testReturns), returns: testReturns } });
    testStart += stepBars;
  }
  if (!folds.length) throw new Error('Not enough candles for one complete walk-forward fold. Increase history or reduce trainBars/testBars.');
  const allOos = folds.flatMap(f => f.outOfSample.returns);
  const oosMetrics = metrics(allOos);
  return { method: 'rolling parameter selection on prior training windows with subsequent untouched out-of-sample test windows',
    strategy, config: { trainBars, testBars, stepBars, feeBps, parameterCombinations: grid.length },
    folds: folds.map(f => ({ ...f, outOfSample: (({ returns, ...stats }) => stats)(f.outOfSample) })), aggregateOutOfSample: { ...oosMetrics, equityCurve: undefined },
    caveats: ['Research baselines only; parameter selection can overfit the training windows.', 'Fees are modeled; spread, funding, borrow, market impact, latency, partial fills and taxes are not.', 'Use venue-specific data quality checks and additional untouched holdout data before deployment.'] };
}
export function calculatePortfolioRisk(positions, history = {}, scenarios = {}) {
  const open = positions.filter(p => finite(p.quantity) > 0 && finite(p.marketPrice) > 0);
  const groups = new Map();
  for (const p of open) {
    const value = p.quantity * p.marketPrice;
    const key = p.quote || 'UNKNOWN';
    const g = groups.get(key) || [];
    g.push({ exchange: p.exchange, symbol: p.symbol, value, quantity: p.quantity, mark: p.marketPrice });
    groups.set(key, g);
  }
  const portfolios = [];
  for (const [currency, rows] of groups) {
    const gross = rows.reduce((s, p) => s + p.value, 0);
    const weights = rows.map(p => ({ ...p, weight: p.value / gross }));
    const hhi = weights.reduce((s, p) => s + p.weight ** 2, 0);
    const returnsByDate = new Map();
    for (const p of weights) {
      const candles = history[p.exchange + ':' + p.symbol] || [];
      for (let i = 1; i < candles.length; i++) {
        const prev = Number(candles[i - 1][4]), close = Number(candles[i][4]);
        if (prev > 0 && close > 0) {
          const date = candles[i][0];
          const row = returnsByDate.get(date) || { pnlReturn: 0, coveredWeight: 0 };
          row.pnlReturn += p.weight * (close / prev - 1);
          row.coveredWeight += p.weight;
          returnsByDate.set(date, row);
        }
      }
    }
    const chronologicalReturns = [...returnsByDate.entries()].sort((a,b) => Number(a[0]) - Number(b[0]))
      .filter(([,r]) => r.coveredWeight >= 0.8)
      .map(([date,r]) => ({ date, value: r.pnlReturn / r.coveredWeight }));
    const daily = chronologicalReturns.map(r => r.value);
    const returns = [...daily].sort((a,b) => a-b);
    const meanDaily = daily.length ? daily.reduce((s,r)=>s+r,0)/daily.length : 0;
    const dailyVariance = daily.length > 1 ? daily.reduce((s,r)=>s+(r-meanDaily)**2,0)/(daily.length-1) : 0;
    const dailyVolatility = Math.sqrt(dailyVariance);
    let equity = 1, peak = 1, maxDrawdown = 0, worstDay = null, bestDay = null;
    for (const point of chronologicalReturns) {
      equity *= Math.max(1e-9, 1 + point.value);
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, (peak-equity)/peak);
      if (!worstDay || point.value < worstDay.return) worstDay = { date: point.date, return: point.value };
      if (!bestDay || point.value > bestDay.return) bestDay = { date: point.date, return: point.value };
    }
    const downside = daily.filter(r=>r<0);
    const downsideDeviation = daily.length ? Math.sqrt(downside.reduce((s,r)=>s+r*r,0)/daily.length) : 0;
    let worstRolling20DayReturn = null;
    for (let i=19;i<daily.length;i++) {
      const value = daily.slice(i-19,i+1).reduce((e,r)=>e*Math.max(1e-9,1+r),1)-1;
      if (worstRolling20DayReturn === null || value < worstRolling20DayReturn) worstRolling20DayReturn = value;
    }
    const quantile = q => returns.length ? returns[Math.max(0, Math.ceil(q * returns.length) - 1)] : null;
    const var95 = quantile(0.05), var99 = quantile(0.01);
    const tail95 = returns.filter(r => r <= (var95 ?? -Infinity));
    const tail99 = returns.filter(r => r <= (var99 ?? -Infinity));
    const defaultShock = currency === 'USDT' || currency === 'USDC' || currency === 'DAI' ? -0.01 : -0.15;
    const stressShock = finite(scenarios[currency]) ?? defaultShock;
    portfolios.push({
      quoteCurrency: currency, grossExposure: gross,
      concentration: { hhi, effectivePositions: hhi > 0 ? 1 / hhi : 0, largestPositionWeightPercent: Math.max(...weights.map(p => p.weight)) * 100 },
      historical: { observations: returns.length, var95Percent: var95 == null ? null : -var95 * 100, expectedShortfall95Percent: tail95.length ? -tail95.reduce((s,r)=>s+r,0)/tail95.length*100 : null, var99Percent: var99 == null ? null : -var99 * 100, expectedShortfall99Percent: tail99.length ? -tail99.reduce((s,r)=>s+r,0)/tail99.length*100 : null, method: 'Historical one-day close-to-close returns, current-notional weights; requires at least 20 aligned observations.',
        diagnostics: { annualizedVolatilityPercent: dailyVolatility * Math.sqrt(365) * 100, sharpeRatioAnnualized: dailyVolatility > 0 ? meanDaily / dailyVolatility * Math.sqrt(365) : null,
          sortinoRatioAnnualized: downsideDeviation > 0 ? meanDaily / downsideDeviation * Math.sqrt(365) : null,
          maxHistoricalDrawdownPercent: maxDrawdown * 100, worstDay: worstDay ? { ...worstDay, returnPercent: worstDay.return * 100 } : null,
          bestDay: bestDay ? { ...bestDay, returnPercent: bestDay.return * 100 } : null,
          worstRolling20DayReturnPercent: worstRolling20DayReturn == null ? null : worstRolling20DayReturn * 100,
          coverageWarning: returns.length < 20 ? 'Insufficient observations for a stable risk estimate.' : null } },
      stress: { shockPercent: stressShock * 100, estimatedLoss: gross * Math.max(0, -stressShock), stressedExposure: gross * (1 + stressShock) },
      positions: weights.map(({exchange,symbol,value,weight})=>({exchange,symbol,marketValue:value,weightPercent:weight*100}))
    });
  }
  return { generatedAt: new Date().toISOString(), methodology: 'Quote-currency portfolios are kept separate; historical VaR is not aggregated across currencies. Current holdings are weighted by current marked notional. Historical estimates do not predict maximum loss.', portfolios,
    limitations: ['No FX conversion across quote currencies.', 'Historical VaR uses available daily OHLCV and excludes gaps, intraday liquidation, leverage, derivatives Greeks, funding, borrow, fees and market impact.', 'Missing histories and holdings below 80% coverage are excluded from each historical observation.', 'Stress scenario is a simple parallel price shock, not a full correlation or liquidity shock.', 'Sharpe and Sortino are annualized from daily historical returns using a zero risk-free rate and 365 crypto-market days; they are descriptive, not forecasts.'] };
}

export function calculatePortfolioAccounting(events, marks = {}) {
  const ordered = [...events].sort((a,b) => new Date(a.occurredAt) - new Date(b.occurredAt));
  const positions = new Map(), realizedByQuote = {}, feesByCurrency = {}, movementMap = new Map();
  const movement = (e, currency, amount) => {
    if (!currency || !Number.isFinite(amount) || amount === 0) return;
    const key = e.accountId + ':' + e.source + ':' + currency;
    const row = movementMap.get(key) || { accountId: e.accountId, exchange: e.source, currency, netMovement: 0 };
    row.netMovement += amount;
    movementMap.set(key, row);
  };
  for (const e of ordered) {
    if (e.eventType === 'fill') {
      const [base, quote] = String(e.symbol || '').split('/');
      const qty = finite(e.quantity), price = finite(e.price), fee = finite(e.fee || 0);
      if (base && quote && qty != null && price != null && qty > 0 && price > 0) {
        const baseDelta = e.side === 'buy' ? qty : e.side === 'sell' ? -qty : 0;
        const quoteDelta = e.side === 'buy' ? -qty * price : e.side === 'sell' ? qty * price : 0;
        movement(e, base, baseDelta);
        movement(e, quote, quoteDelta);
        if (fee > 0) movement(e, e.feeCurrency || quote, -fee);
      }
    } else if (e.eventType === 'deposit' && e.currency) movement(e, e.currency, finite(e.quantity) || 0);
    else if (e.eventType === 'withdrawal' && e.currency) movement(e, e.currency, -(finite(e.quantity) || 0));
    else if (e.eventType === 'fee' && e.currency) { movement(e, e.currency, -(finite(e.quantity) || 0)); feesByCurrency[e.currency] = (feesByCurrency[e.currency] || 0) + (finite(e.quantity) || 0); }
    else if (['funding', 'interest', 'borrow', 'rebate'].includes(e.eventType) && e.currency) {
      const signed = finite(e.metadata?.signedAmount);
      const amount = signed ?? (e.eventType === 'rebate' ? (finite(e.quantity) || 0) : -(finite(e.quantity) || 0));
      movement(e, e.currency, amount);
    }
    else if (e.eventType === 'adjustment' && e.currency) movement(e, e.currency, finite(e.metadata?.signedAmount) ?? (finite(e.quantity) || 0));
    else if (e.eventType === 'transfer') {
      const fromAmount = finite(e.metadata?.fromAmount), toAmount = finite(e.metadata?.toAmount);
      if (e.metadata?.fromCurrency && fromAmount != null) movement(e, e.metadata.fromCurrency, -fromAmount);
      if (e.metadata?.toCurrency && toAmount != null) movement(e, e.metadata.toCurrency, toAmount);
    }
  }
  const assetMovements = [...movementMap.values()];
  const fillEvents = ordered.filter(e => e.eventType === 'fill');
  for (const e of fillEvents) {
    const [base, quote] = String(e.symbol || '').split('/');
    const qty = finite(e.quantity), price = finite(e.price), fee = finite(e.fee || 0);
    if (!base || !quote || qty == null || price == null || qty <= 0 || price <= 0) continue;
    const key = e.accountId + ':' + e.source + ':' + e.symbol;
    const p = positions.get(key) || { accountId: e.accountId, exchange: e.source, symbol: e.symbol, base, quote, quantity: 0, averageCost: 0, realizedPnl: 0, totalBought: 0, totalSold: 0, unmatchedSellQuantity: 0, unmatchedSellCount: 0 };
    const feeCurrency = e.feeCurrency || quote;
    if (fee > 0) feesByCurrency[feeCurrency] = (feesByCurrency[feeCurrency] || 0) + fee;
    if (e.side === 'buy') {
      const baseFee = feeCurrency === base ? fee : 0;
      const quoteFee = feeCurrency === quote ? fee : 0;
      const acquired = Math.max(0, qty - baseFee);
      const cost = qty * price + quoteFee;
      p.averageCost = (p.quantity * p.averageCost + cost) / Math.max(1e-12, p.quantity + acquired);
      p.quantity += acquired; p.totalBought += acquired;
    } else if (e.side === 'sell') {
      const disposed = qty + (feeCurrency === base ? fee : 0);
      const proceeds = qty * price - (feeCurrency === quote ? fee : 0);
      const matched = Math.min(p.quantity, disposed);
      if (disposed > matched) { p.unmatchedSellQuantity += disposed - matched; p.unmatchedSellCount++; }
      p.realizedPnl += proceeds * (matched / disposed) - p.averageCost * matched;
      p.quantity -= matched; p.totalSold += matched;
      if (p.quantity <= 1e-12) { p.quantity = 0; p.averageCost = 0; }
    }
    positions.set(key, p);
    realizedByQuote[quote] = (realizedByQuote[quote] || 0) + p.realizedPnl - (p._reportedRealized || 0);
    p._reportedRealized = p.realizedPnl;
  }
  const rows = [...positions.values()].map(p => {
    const mark = finite(marks[p.exchange + ':' + p.symbol] ?? marks[p.symbol]);
    return { ...p, marketPrice: mark, unrealizedPnl: mark == null ? null : (mark - p.averageCost) * p.quantity,
      marketValue: mark == null ? null : mark * p.quantity, costBasis: p.averageCost * p.quantity,
      valuationStatus: mark == null ? 'mark-price-unavailable' : 'marked-from-supplied-price' };
  }).map(({ _reportedRealized, ...p }) => p);
  return { generatedAt: new Date().toISOString(), positions: rows, assetMovements, realizedPnlByQuoteCurrency: realizedByQuote, feesByCurrency,
    accountingMethod: 'weighted-average cost per exchange/account/symbol; FIFO is not implied',
    limitations: ['Asset movements include only explicitly ingested deposits, withdrawals, fees, adjustments and transfers with from/to metadata. Missing opening balances mean these are net ledger movements, not verified exchange balances.',
      'Realized PnL is quote-currency denominated and should not be summed across currencies without FX conversion. Fees paid in a third token are reported separately and are not FX-converted into realized PnL.',
      'Unmatched sell quantity indicates missing opening inventory or incomplete fill history; its cost basis and realized PnL are not guessed.',
      'Unrealized PnL is reported only where a current mark price is supplied. This is not a tax statement.'] };
}

labRouter.get('/advanced/lab/walk-forward/:exchange/:symbol', async (req, res) => {
  try {
    const exchangeId = req.params.exchange.toLowerCase();
    const symbol = req.params.symbol.toUpperCase().replace('-', '/');
    const timeframe = String(req.query.timeframe || '1h');
    const limit = clamp(Number.parseInt(req.query.limit || '1000', 10) || 1000, 100, 2000);
    const candles = await withExchange(exchangeId, { privateAccess: false }, async ex => {
      if (!ex.markets[symbol] || !ex.has?.fetchOHLCV) throw Object.assign(new Error('Market or OHLCV capability unavailable.'), { status: 404 });
      if (ex.timeframes && !ex.timeframes[timeframe]) throw Object.assign(new Error('Unsupported timeframe.'), { status: 400 });
      return ex.fetchOHLCV(symbol, timeframe, undefined, limit);
    });
    res.json({ exchange: exchangeId, symbol, timeframe, ...runWalkForward(candles, {
      trainBars: req.query.trainBars, testBars: req.query.testBars, stepBars: req.query.stepBars, feeBps: req.query.feeBps
    }) });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
labRouter.post('/advanced/lab/walk-forward', (req, res) => {
  try { res.json(runWalkForward(req.body?.candles, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
labRouter.get('/advanced/portfolio/performance', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const events = await getLedgerTransactions();
    const report = calculateTradePerformance(events);
    res.set('Cache-Control', 'no-store').json(report);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || 'Trade performance analytics unavailable.' });
  }
});

labRouter.get('/advanced/portfolio/risk', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const events = await getLedgerTransactions();
    const instruments = [...new Map(events.filter(e => e.eventType === 'fill' && e.symbol).map(e => [e.source + ':' + e.symbol, { exchange: e.source, symbol: e.symbol }])).values()].slice(0, 30);
    const marks = {}, history = {};
    await Promise.all(instruments.map(async ({ exchange, symbol }) => {
      try {
        const data = await withExchange(exchange, { privateAccess: false }, async ex => {
          if (!ex.markets[symbol]) return null;
          const jobs = [];
          if (ex.has?.fetchTicker) jobs.push(ex.fetchTicker(symbol).then(t => ({ type: 'mark', value: t.last })).catch(()=>null));
          if (ex.has?.fetchOHLCV) jobs.push(ex.fetchOHLCV(symbol, '1d', undefined, 120).then(value => ({ type: 'history', value })).catch(()=>null));
          return Promise.all(jobs);
        });
        for (const item of data || []) if (item) {
          if (item.type === 'mark' && finite(item.value) > 0) marks[exchange + ':' + symbol] = item.value;
          if (item.type === 'history') history[exchange + ':' + symbol] = item.value;
        }
      } catch {}
    }));
    const accounting = calculatePortfolioAccounting(events, marks);
    const scenarios = req.query.shocks ? JSON.parse(String(req.query.shocks)) : {};
    res.json(calculatePortfolioRisk(accounting.positions, history, scenarios));
  } catch (error) { res.status(error.status || 400).json({ error: error.message }); }
});
labRouter.get('/advanced/portfolio/accounting', async (req, res) => {
  try {
    requirePrivateApiAuth(req);
    const events = await getLedgerTransactions();
    const marks = {};
    const instruments = [...new Map(events.filter(e => e.eventType === 'fill' && e.symbol).map(e => [e.source + ':' + e.symbol, { exchange: e.source, symbol: e.symbol }])).values()].slice(0, 30);
    await Promise.all(instruments.map(async ({ exchange, symbol }) => {
      try {
        const price = await withExchange(exchange, { privateAccess: false }, async ex => ex.markets[symbol] && ex.has?.fetchTicker ? (await ex.fetchTicker(symbol)).last : null);
        if (finite(price) != null) marks[exchange + ':' + symbol] = price;
      } catch {}
    }));
    const exchangeIds = [...new Set(events.map(e => e.source))].slice(0, 20);
    const exchangeBalances = await Promise.all(exchangeIds.map(async exchange => {
      try {
        return await withExchange(exchange, { privateAccess: true }, async ex => {
          if (!ex.has?.fetchBalance) return { exchange, status: 'unsupported' };
          const balance = await ex.fetchBalance();
          return { exchange, status: 'ok', fetchedAt: new Date().toISOString(), free: balance.free, used: balance.used, total: balance.total };
        });
      } catch (error) { return { exchange, status: 'unavailable', error: error.message }; }
    }));
    res.json({ ...calculatePortfolioAccounting(events, marks), exchangeBalances,
      reconciliationNote: 'Exchange balances are current read-only snapshots. Ledger net movements are not a verified reconciliation unless complete opening balances and all deposits, withdrawals, transfers, fees and fills are present.' });
  } catch (e) { res.status(e.status || 401).json({ error: e.message }); }
});
labRouter.post('/advanced/fills/sync/:exchange', async (req, res) => {
  try { requirePrivateApiAuth(req); } catch (e) { return res.status(401).json({ error: e.message }); }
  const exchangeId = req.params.exchange.toLowerCase();
  const since = finite(req.body?.since) ?? Date.now() - 24 * 60 * 60 * 1000;
  const symbol = req.body?.symbol ? String(req.body.symbol).toUpperCase() : undefined;
  try {
    const trades = await withExchange(exchangeId, { privateAccess: true }, async ex => {
      if (!ex.has?.fetchMyTrades) throw Object.assign(new Error('This exchange adapter does not expose fetchMyTrades.'), { status: 501 });
      if (symbol && !ex.markets[symbol]) throw Object.assign(new Error('Unknown market symbol.'), { status: 404 });
      return ex.fetchMyTrades(symbol, since, 100);
    });
    const results = [];
    for (const t of trades) {
      if (!t.id || !t.symbol || !['buy','sell'].includes(t.side) || !(t.amount > 0) || !(t.price > 0)) continue;
      const [base, quote] = t.symbol.split('/');
      const fee = t.fee || {};
      const saved = await ingestLedgerEvent({ source: exchangeId, eventType: 'fill', externalId: String(t.id), accountId: exchangeId,
        symbol: t.symbol, side: t.side, quantity: Number(t.amount), price: Number(t.price), fee: Number(fee.cost || 0),
        feeCurrency: fee.currency || quote, occurredAt: new Date(Number(t.timestamp) || Date.parse(t.datetime) || Date.now()).toISOString(),
        metadata: { base, quote, orderId: String(t.order || ''), tradeId: String(t.id), takerOrMaker: String(t.takerOrMaker || '') } });
      results.push({ id: t.id, duplicate: saved.duplicate });
    }
    res.json({ exchange: exchangeId, fetched: trades.length, ingested: results.filter(x => !x.duplicate).length,
      duplicates: results.filter(x => x.duplicate).length, since: new Date(since).toISOString(),
      note: 'Read-only private trade-history ingestion. Venue history limits and pagination vary; repeat with a later since cursor for older history.' });
  } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
labRouter.get('/advanced/stream/:exchange/:symbol', async (req, res) => {
  const exchangeId = req.params.exchange.toLowerCase(), symbol = req.params.symbol.toUpperCase().replace('-', '/');
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  let busy = false, closed = false, timer = null;
  res.on('close', () => { closed = true; if (timer) clearInterval(timer); });
  const publish = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      const snapshot = await withExchange(exchangeId, { privateAccess: false }, async ex => {
        const market = ex.markets[symbol];
        if (!market) throw Object.assign(new Error('Market not found.'), { status: 404 });
        const jobs = {};
        if (ex.has?.fetchOrderBook) jobs.orderBook = ex.fetchOrderBook(symbol, 50).catch(error => ({ unavailable: error.message }));
        if (market.contract && ex.has?.fetchFundingRate) jobs.funding = ex.fetchFundingRate(symbol).catch(error => ({ unavailable: error.message }));
        if (market.contract && ex.has?.fetchOpenInterest) jobs.openInterest = ex.fetchOpenInterest(symbol).catch(error => ({ unavailable: error.message }));
        if (market.contract && ex.has?.fetchLiquidations) jobs.liquidations = ex.fetchLiquidations(symbol, undefined, 50).catch(error => ({ unavailable: error.message }));
        if (market.contract && ex.has?.fetchFundingRateHistory) jobs.fundingHistory = ex.fetchFundingRateHistory(symbol, undefined, 20).catch(error => ({ unavailable: error.message }));
        if (market.contract && ex.has?.fetchOpenInterestHistory) jobs.openInterestHistory = ex.fetchOpenInterestHistory(symbol, '1h', undefined, 20).catch(error => ({ unavailable: error.message }));
        if (ex.has?.fetchTicker) jobs.ticker = ex.fetchTicker(symbol).catch(error => ({ unavailable: error.message }));
        const pairs = await Promise.all(Object.entries(jobs).map(async ([k,p]) => [k, await p]));
        return Object.fromEntries(pairs);
      });
      const payload = { exchange: exchangeId, symbol, sampledAt: new Date().toISOString(), ...snapshot,
        orderBookAnalysis: snapshot.orderBook && !snapshot.orderBook.unavailable ? analyzeOrderBook(snapshot.orderBook) : { status: 'unavailable' },
        transport: 'server-sent events over polling; venue websocket capability is not assumed' };
      if (!closed) res.write('event: intelligence\ndata: ' + JSON.stringify(payload) + '\n\n');
    } catch (e) {
      if (!closed) res.write('event: error\ndata: ' + JSON.stringify({ exchange: exchangeId, symbol, error: e.message, sampledAt: new Date().toISOString() }) + '\n\n');
    } finally { busy = false; }
  };
  await publish();
  if (!closed) timer = setInterval(publish, clamp(Number(req.query.intervalMs || 2000), 1000, 15000));
});
