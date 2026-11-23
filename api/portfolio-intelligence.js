import express from 'express';
import { withExchange, listExchangeCatalog } from './exchanges.js';
import { readStoredEvents } from './storage.js';
import { requirePrivateApiAuth } from './policy.js';
import { calculateTradePerformance } from './performance.js';

export const portfolioRouter = express.Router();

const finite = value => value === null || value === undefined || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const keyFor = event => [event.source || 'unknown', event.accountId || 'unknown', event.symbol || ''].join(':');
const add = (map, currency, amount) => {
  if (!currency || !Number.isFinite(amount)) return;
  const code = String(currency).toUpperCase();
  map.set(code, (map.get(code) || 0) + amount);
};

export function calculatePortfolioAccounting(events = [], marks = {}) {
  const fills = events.filter(event => event?.kind === 'ledger-transaction' && event.eventType === 'fill')
    .sort((a, b) => Date.parse(a.occurredAt || 0) - Date.parse(b.occurredAt || 0));
  const books = new Map();
  const movements = new Map();
  const realizedPnlByQuoteCurrency = {};
  const warnings = new Set();
  let invalidFills = 0;

  for (const event of events) {
    if (event?.kind !== 'ledger-transaction') continue;
    const fee = finite(event.fee) ?? 0;
    const feeCurrency = String(event.feeCurrency || '').toUpperCase();
    if (event.eventType === 'fill') {
      const [base, quote] = String(event.symbol || '').toUpperCase().split('/');
      const qty = finite(event.quantity), price = finite(event.price);
      if (!base || !quote || qty == null || qty <= 0 || price == null || price <= 0 || !['buy', 'sell'].includes(event.side)) continue;
      const baseDelta = event.side === 'buy' ? qty : -qty;
      const quoteDelta = event.side === 'buy' ? -qty * price : qty * price;
      add(movements, base, baseDelta - (feeCurrency === base ? fee : 0));
      add(movements, quote, quoteDelta - (feeCurrency === quote ? fee : 0));
      if (fee > 0 && feeCurrency && feeCurrency !== base && feeCurrency !== quote) add(movements, feeCurrency, -fee);
    } else if (['deposit', 'withdrawal'].includes(event.eventType)) {
      const currency = String(event.currency || '').toUpperCase(), qty = finite(event.quantity);
      if (currency && qty != null) {
        add(movements, currency, event.eventType === 'deposit' ? qty : -qty);
        if (fee > 0) add(movements, feeCurrency || currency, -fee);
      }
    } else if (event.eventType === 'fee' && fee > 0 && feeCurrency) add(movements, feeCurrency, -fee);
    else if (['transfer', 'adjustment', 'funding', 'interest', 'borrow', 'rebate'].includes(event.eventType)) {
      const currency = String(event.currency || '').toUpperCase(), qty = finite(event.quantity);
      const direction = String(event.metadata?.direction || '').toLowerCase();
      if (currency && qty != null && ['in','credit','deposit','positive','out','debit','withdrawal','negative'].includes(direction)) {
        add(movements, currency, ['in','credit','deposit','positive'].includes(direction) ? qty : -qty);
      } else warnings.add('Some non-trade ledger movements lack a supported currency, amount or direction.');
    }
  }

  for (const event of fills) {
    const [base, quote] = String(event.symbol || '').toUpperCase().split('/');
    const qty = finite(event.quantity), price = finite(event.price), fee = finite(event.fee ?? 0);
    const feeCurrency = String(event.feeCurrency || quote || '').toUpperCase();
    if (!base || !quote || !['buy','sell'].includes(event.side) || qty == null || qty <= 0 || price == null || price <= 0 || fee == null || fee < 0) {
      invalidFills++; continue;
    }
    const key = keyFor(event);
    const book = books.get(key) || { exchange:event.source || 'unknown', accountId:event.accountId || 'unknown', symbol:event.symbol, base, quote, quantity:0, averageCost:0 };
    if (event.side === 'buy') {
      const acquired = Math.max(0, qty - (feeCurrency === base ? fee : 0));
      const cost = qty * price + (feeCurrency === quote ? fee : 0);
      const nextQuantity = book.quantity + acquired;
      if (nextQuantity > 1e-12) book.averageCost = (book.quantity * book.averageCost + cost) / nextQuantity;
      book.quantity = nextQuantity;
    } else {
      const disposed = qty + (feeCurrency === base ? fee : 0);
      const matched = Math.min(book.quantity, disposed);
      const proceeds = qty * price - (feeCurrency === quote ? fee : 0);
      if (matched > 1e-12) realizedPnlByQuoteCurrency[quote] = (realizedPnlByQuoteCurrency[quote] || 0) + proceeds * (matched / disposed) - book.averageCost * matched;
      if (disposed - matched > 1e-10) warnings.add('Unmatched sell quantity exists; missing opening inventory prevents full cost-basis attribution.');
      book.quantity = Math.max(0, book.quantity - matched);
      if (book.quantity <= 1e-12) { book.quantity = 0; book.averageCost = 0; }
    }
    books.set(key, book);
  }

  const positions = [...books.values()].filter(book => book.quantity > 1e-12).map(book => {
    const mark = finite(marks[book.exchange + ':' + book.symbol]);
    const marketValue = mark == null ? null : book.quantity * mark;
    return { ...book, marketPrice:mark, marketValue, unrealizedPnl:mark == null ? null : (mark - book.averageCost) * book.quantity,
      quoteCurrency:book.quote, markStatus:mark == null ? 'unavailable' : 'live' };
  }).sort((a,b) => (b.marketValue || 0) - (a.marketValue || 0));
  const assetMovements = [...movements].map(([currency, netMovement]) => ({ currency, netMovement })).sort((a,b) => a.currency.localeCompare(b.currency));
  return { generatedAt:new Date().toISOString(), positions, assetMovements, realizedPnlByQuoteCurrency,
    invalidFills, warnings:[...warnings], fillCount:fills.length,
    reconciliationNote:'Positions and realized PnL are derived from the append-only fill ledger using weighted-average cost per exchange/account/market. Marks are public exchange ticker observations when available.',
    limitations:[
      'Balances are read-only exchange snapshots and may include assets not represented in the ledger.',
      'Third-currency fees are recorded as movements but are not converted into the trade quote currency.',
      'Unmatched sell quantities are not assigned a guessed cost basis; missing history can understate or overstate portfolio completeness.',
      'Derivative contracts, liabilities, funding, borrow costs and cross-currency FX conversion are not included in spot fill-based positions.'
    ] };
}

export function percentile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function calculatePortfolioRisk({ positions = [], returnSeries = {}, shockPercent = 10 } = {}) {
  const grouped = new Map();
  for (const position of positions) {
    if (!(position.marketValue > 0) || !position.quoteCurrency) continue;
    const rows = grouped.get(position.quoteCurrency) || [];
    rows.push(position); grouped.set(position.quoteCurrency, rows);
  }
  const portfolios = [...grouped].map(([quoteCurrency, rows]) => {
    const grossExposure = rows.reduce((sum, row) => sum + row.marketValue, 0);
    const weights = rows.map(row => ({ ...row, weight:row.marketValue / grossExposure }));
    const timestamps = weights.map(row => new Set(Object.keys(returnSeries[row.exchange + ':' + row.symbol] || {})));
    const common = timestamps.length ? [...timestamps[0]].filter(timestamp => timestamps.every(set => set.has(timestamp))).sort((a,b) => Number(a)-Number(b)) : [];
    const portfolioReturns = common.map(timestamp => weights.reduce((sum,row) => sum + row.weight * Number(returnSeries[row.exchange + ':' + row.symbol][timestamp]), 0)).filter(Number.isFinite);
    const q05 = percentile(portfolioReturns, .05), q01 = percentile(portfolioReturns, .01);
    const tail05 = q05 == null ? [] : portfolioReturns.filter(value => value <= q05);
    const tail01 = q01 == null ? [] : portfolioReturns.filter(value => value <= q01);
    const largest = Math.max(...weights.map(row => row.weight));
    const hhi = weights.reduce((sum,row) => sum + row.weight ** 2, 0);
    const effective = hhi > 0 ? 1 / hhi : 0;
    const requestedShock = Number(shockPercent);
    const shock = Number.isFinite(requestedShock) ? Math.max(0, Math.min(100, requestedShock)) : 10;
    return { quoteCurrency, grossExposure,
      positions:weights.map(row => ({ exchange:row.exchange, symbol:row.symbol, marketValue:row.marketValue, weightPercent:row.weight*100 })),
      concentration:{ largestPositionWeightPercent:largest*100, effectivePositions:effective },
      historical:{ observations:portfolioReturns.length, var95Percent:q05 == null || portfolioReturns.length < 30 ? null : Math.max(0,-q05*100),
        expectedShortfall95Percent:q05 == null || portfolioReturns.length < 30 || !tail05.length ? null : Math.max(0,-tail05.reduce((s,v)=>s+v,0)/tail05.length*100),
        var99Percent:q01 == null || portfolioReturns.length < 100 ? null : Math.max(0,-q01*100),
        expectedShortfall99Percent:q01 == null || portfolioReturns.length < 100 || !tail01.length ? null : Math.max(0,-tail01.reduce((s,v)=>s+v,0)/tail01.length*100) },
      stress:{ shockPercent:shock, estimatedLoss:grossExposure*shock/100 } };
  }).sort((a,b) => b.grossExposure-a.grossExposure);
  const warnings = [];
  for (const portfolio of portfolios) {
    if (portfolio.concentration.largestPositionWeightPercent >= 40) warnings.push({severity:'warning',quoteCurrency:portfolio.quoteCurrency,message:'A single position represents at least 40% of this quote-currency exposure.'});
    if (portfolio.historical.observations < 30) warnings.push({severity:'info',quoteCurrency:portfolio.quoteCurrency,message:'Insufficient aligned daily price history for a 95% historical VaR estimate (30 observations required).'});
    if (portfolio.historical.observations < 100) warnings.push({severity:'info',quoteCurrency:portfolio.quoteCurrency,message:'Insufficient aligned daily price history for a 99% historical VaR estimate (100 observations required).'});
  }
  return { generatedAt:new Date().toISOString(), portfolios, warnings,
    methodology:'Long-only spot exposure is grouped by quote currency. Historical VaR and expected shortfall use timestamp-aligned daily close-to-close returns, weighted by current marked exposure. Stress loss applies a parallel adverse price shock.',
    limitations:[
      'VaR and expected shortfall are available only when at least 30 aligned daily observations exist; 99% metrics require at least 100 observations.',
      'Historical estimates are not maximum-loss guarantees and may not capture regime changes, gaps or liquidity shocks.',
      'Only ledger-derived spot positions with a valid public mark are included. Exchange balances not mapped to positions, derivatives, liabilities, leverage, funding and borrow are excluded.',
      'Quote currencies are never combined. USDT, USD, BTC and other quote units are separate portfolios; no FX conversion is inferred.'
    ] };
}

async function loadLedger() {
  return readStoredEvents(Number.MAX_SAFE_INTEGER, 'ledger-transaction');
}

async function loadMarksAndHistory(positions, includeHistory = false) {
  const marks = {}, returnSeries = {}, errors = [];
  const maximumPositions = includeHistory ? 50 : 100;
  const selectedPositions = positions.slice(0, maximumPositions);
  if (positions.length > selectedPositions.length) errors.push('Market data sampling capped at '+maximumPositions+' positions; '+(positions.length-selectedPositions.length)+' additional position(s) were not marked or included in historical risk.');
  const byExchange = new Map();
  for (const position of selectedPositions) {
    const list = byExchange.get(position.exchange) || [];
    list.push(position); byExchange.set(position.exchange, list);
  }
  await Promise.all([...byExchange].map(async ([exchange, rows]) => {
    try {
      await withExchange(exchange, { privateAccess:false }, async ex => {
        for (const position of rows) {
          try {
            const market = ex.markets[position.symbol];
            if (!market || !ex.has?.fetchTicker) { errors.push(exchange+' '+position.symbol+': ticker unavailable'); continue; }
            const ticker = await ex.fetchTicker(position.symbol);
            const mark = finite(ticker.last ?? ticker.close);
            if (mark != null && mark > 0) marks[exchange+':'+position.symbol] = mark;
            if (includeHistory) {
              if (!ex.has?.fetchOHLCV || (ex.timeframes && !ex.timeframes['1d'])) continue;
              const candles = await ex.fetchOHLCV(position.symbol, '1d', undefined, 400);
              const series = {};
              for (let i=1;i<candles.length;i++) {
                const previous=finite(candles[i-1]?.[4]), close=finite(candles[i]?.[4]), timestamp=finite(candles[i]?.[0]);
                if (previous>0 && close>0 && timestamp!=null) series[String(timestamp)] = close/previous-1;
              }
              returnSeries[exchange+':'+position.symbol] = series;
            }
          } catch (error) { errors.push(exchange+' '+position.symbol+': '+String(error.message || error).slice(0,180)); }
        }
      });
    } catch (error) { errors.push(exchange+': '+String(error.message || error).slice(0,180)); }
  }));
  return { marks, returnSeries, errors };
}

async function loadExchangeBalances() {
  const configured = listExchangeCatalog().filter(item => item.configured && item.capabilities.balance).slice(0,10);
  return Promise.all(configured.map(async item => {
    try {
      const balance = await withExchange(item.id, { privateAccess:true }, async ex => ex.fetchBalance());
      return { exchange:item.id, status:'ok', free:balance.free || {}, used:balance.used || {}, total:balance.total || {} };
    } catch (error) { return { exchange:item.id, status:'error', error:String(error.message || error).slice(0,240) }; }
  }));
}

function authorize(req, res) {
  try { requirePrivateApiAuth(req); return true; }
  catch (error) { res.status(error.status || 401).json({error:error.message}); return false; }
}

portfolioRouter.get('/advanced/portfolio/accounting', async (req,res) => {
  if (!authorize(req,res)) return;
  try {
    const events = await loadLedger();
    const raw = calculatePortfolioAccounting(events);
    const { marks, errors } = await loadMarksAndHistory(raw.positions, false);
    const accounting = calculatePortfolioAccounting(events, marks);
    const exchangeBalances = await loadExchangeBalances();
    res.set('Cache-Control','no-store').json({ ...accounting, exchangeBalances, balanceErrors:errors });
  } catch (error) { res.status(503).json({error:error.message || 'Portfolio accounting unavailable.'}); }
});

portfolioRouter.get('/advanced/portfolio/performance', async (req,res) => {
  if (!authorize(req,res)) return;
  try {
    const events = await loadLedger();
    res.set('Cache-Control','no-store').json(calculateTradePerformance(events));
  } catch (error) { res.status(503).json({error:error.message || 'Trade performance unavailable.'}); }
});

portfolioRouter.get('/advanced/portfolio/risk', async (req,res) => {
  if (!authorize(req,res)) return;
  try {
    const events = await loadLedger();
    const base = calculatePortfolioAccounting(events);
    const { marks, returnSeries, errors } = await loadMarksAndHistory(base.positions, true);
    const accounting = calculatePortfolioAccounting(events, marks);
    const shockPercent = finite(process.env.JPTI_PORTFOLIO_STRESS_SHOCK_PERCENT) ?? 10;
    const risk = calculatePortfolioRisk({positions:accounting.positions,returnSeries,shockPercent});
    res.set('Cache-Control','no-store').json({...risk, dataQuality:{invalidFills:accounting.invalidFills,warnings:accounting.warnings,marketDataErrors:errors}});
  } catch (error) { res.status(503).json({error:error.message || 'Portfolio risk analysis unavailable.'}); }
});
