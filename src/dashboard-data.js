// Pure, dependency-free helpers for the JPTI dashboard panels.
// Every function returns null / 'unavailable' states instead of inventing values when input is missing.
// Candle rows follow the JPTI/CCXT format: [timestampMs, open, high, low, close, volume].

export const toNumber = (value) => {
  if (value === null || value === undefined || value === '' || value === '.') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function cleanCandles(candles) {
  return (Array.isArray(candles) ? candles : [])
    .map(row => Array.isArray(row) ? row.map(Number) : [])
    .filter(row => row.length >= 6 && row.slice(0, 6).every(Number.isFinite) && row[2] >= row[3])
    .sort((a, b) => a[0] - b[0]);
}

export function trueRanges(candles) {
  const rows = cleanCandles(candles);
  return rows.map((row, i) => {
    const prevClose = i > 0 ? rows[i - 1][4] : row[4];
    return Math.max(row[2] - row[3], Math.abs(row[2] - prevClose), Math.abs(row[3] - prevClose));
  });
}

// Wilder-smoothed Average True Range of the most recent bar. Needs period + 1 candles.
export function averageTrueRange(candles, period = 14) {
  const tr = trueRanges(candles);
  if (tr.length < period + 1) return null;
  let atr = tr.slice(1, period + 1).reduce((s, v) => s + v, 0) / period;
  for (let i = period + 1; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  return atr;
}

// Current volume relative to the mean of the prior `period` bars (the in-progress bar is excluded from the baseline).
export function relativeVolume(candles, period = 20) {
  const rows = cleanCandles(candles);
  if (rows.length < period + 1) return null;
  const last = rows[rows.length - 1][5];
  const base = rows.slice(-period - 1, -1).reduce((s, r) => s + r[5], 0) / period;
  return base > 0 ? last / base : null;
}

// ATR now versus the mean ATR proxy (mean true range) of the prior bars: >1 means volatility is expanding.
export function atrRatio(candles, period = 14, baselineBars = 50) {
  const atr = averageTrueRange(candles, period);
  const tr = trueRanges(candles);
  if (atr == null || tr.length < baselineBars + 1) return null;
  const base = tr.slice(-baselineBars - 1, -1).reduce((s, v) => s + v, 0) / baselineBars;
  return base > 0 ? atr / base : null;
}

// Resting-liquidity pools: clusters of equal highs (buy-side, stops above) and equal lows (sell-side, stops below).
// Heuristic derived from candles only, it is NOT order-book or stop-order data.
export function liquidityPools(candles, { lookback = 60, tolerancePercent = 0.05 } = {}) {
  const rows = cleanCandles(candles);
  if (rows.length < 10) return { status: 'insufficient', buySide: null, sellSide: null };
  const window = rows.slice(-lookback - 1, -1);
  const tol = tolerancePercent / 100;
  const cluster = (values, pick) => {
    const extreme = pick(...values);
    const members = values.filter(v => Math.abs(v - extreme) / extreme <= tol);
    return { price: extreme, low: Math.min(...members), high: Math.max(...members), touches: members.length };
  };
  const buySide = cluster(window.map(r => r[2]), Math.max);
  const sellSide = cluster(window.map(r => r[3]), Math.min);
  return { status: 'ready', buySide, sellSide, lookback: window.length };
}

export function chartLevelsFromPools(pools) {
  if (!pools || pools.status !== 'ready') return [];
  return [
    { price: pools.buySide.price, label: 'Buy-side liquidity', color: '#ef5350' },
    { price: pools.sellSide.price, label: 'Sell-side liquidity', color: '#26a69a' }
  ];
}

export function formatPrice(value, digits = 6) {
  const n = toNumber(value);
  if (n == null) return '—';
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : digits;
  return n.toLocaleString(undefined, { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d });
}

// Upcoming high/medium impact events from the institutional calendar feed.
export function upcomingEvents(events, now = Date.now(), { limit = 4, windowHours = 48, impacts = ['high', 'medium'] } = {}) {
  return (Array.isArray(events) ? events : [])
    .map(e => ({ ...e, at: Date.parse(e?.scheduledAt) }))
    .filter(e => Number.isFinite(e.at) && e.at >= now - 30 * 60000 && e.at <= now + windowHours * 3600000 && impacts.includes(e.impact))
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
}

export function eventRisk(events, now = Date.now(), withinHours = 4) {
  if (!Array.isArray(events)) return { level: 'unknown', event: null };
  const soon = upcomingEvents(events, now, { limit: 50, windowHours: withinHours, impacts: ['high', 'medium'] });
  const high = soon.find(e => e.impact === 'high');
  if (high) return { level: 'high', event: high };
  if (soon.length) return { level: 'medium', event: soon[0] };
  return { level: 'none', event: null };
}

// Heuristic risk regime; thresholds are documented here and displayed as a heuristic, not a forecast.
export function volatilityRisk({ ratio, eventLevel = 'unknown' }) {
  if (ratio == null) return { level: 'UNAVAILABLE', tone: 'idle' };
  if (ratio >= 1.8 || (eventLevel === 'high' && ratio >= 1.2)) return { level: 'HIGH', tone: 'bad' };
  if (ratio >= 1.3 || eventLevel === 'high') return { level: 'CAUTION', tone: 'warn' };
  if (ratio <= 0.7) return { level: 'LOW', tone: 'good' };
  return { level: 'NORMAL', tone: 'good' };
}

export function spreadPercent(ticker) {
  const bid = toNumber(ticker?.bid), ask = toNumber(ticker?.ask);
  if (bid == null || ask == null || bid <= 0 || ask < bid) return null;
  return (ask - bid) / ((ask + bid) / 2) * 100;
}

// Trading-controls calculator. Percent-based so it works for any asset class. It never places an order.
export function tradePlan({ side = 'buy', entry, riskPercent, stopPercent, targetPercent, equity = null }) {
  const e = toNumber(entry), r = toNumber(riskPercent), s = toNumber(stopPercent), t = toNumber(targetPercent), eq = toNumber(equity);
  if (e == null || e <= 0 || s == null || s <= 0 || t == null || t <= 0 || r == null || r <= 0) return null;
  const dir = side === 'sell' ? -1 : 1;
  const plan = {
    side, entry: e,
    stopPrice: e * (1 - dir * s / 100),
    targetPrice: e * (1 + dir * t / 100),
    rewardRisk: t / s,
    riskAmount: null, notional: null, quantity: null
  };
  if (eq != null && eq > 0) {
    plan.riskAmount = eq * r / 100;
    plan.notional = plan.riskAmount / (s / 100);
    plan.quantity = plan.notional / e;
  }
  return plan;
}

// FRED observations arrive newest-first; '.' marks a missing value.
export function usableObservations(observations) {
  return (Array.isArray(observations) ? observations : [])
    .map(o => ({ date: o?.date, value: toNumber(o?.value) }))
    .filter(o => o.value != null);
}

export const MACRO_SERIES = [
  { id: 'FEDFUNDS', label: 'Fed Funds Rate', mode: 'level' },
  { id: 'CPIAUCSL', label: 'CPI (YoY)', mode: 'yoy' },
  { id: 'PCEPI', label: 'PCE (YoY)', mode: 'yoy' },
  { id: 'PAYEMS', label: 'NFP (Latest)', mode: 'monthlyChange' }
];

export function macroReading(series, observations) {
  const obs = usableObservations(observations);
  if (!obs.length) return null;
  if (series.mode === 'level') return { value: obs[0].value, display: obs[0].value.toFixed(2) + '%', date: obs[0].date };
  if (series.mode === 'yoy') {
    if (obs.length < 13 || obs[12].value === 0) return null;
    const yoy = (obs[0].value / obs[12].value - 1) * 100;
    return { value: yoy, display: yoy.toFixed(1) + '%', date: obs[0].date };
  }
  if (series.mode === 'monthlyChange') {
    if (obs.length < 2) return null;
    const delta = obs[0].value - obs[1].value; // PAYEMS is reported in thousands of persons
    return { value: delta, display: (delta >= 0 ? '+' : '') + Math.round(delta).toLocaleString() + 'K', date: obs[0].date };
  }
  return null;
}

export function nextMatchingEvent(events, pattern, now = Date.now()) {
  return (Array.isArray(events) ? events : [])
    .map(e => ({ ...e, at: Date.parse(e?.scheduledAt) }))
    .filter(e => Number.isFinite(e.at) && e.at >= now && pattern.test(String(e.title || '')))
    .sort((a, b) => a.at - b.at)[0] || null;
}

export function timeAgo(value, now = Date.now()) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.max(0, Math.round((now - t) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  return hours < 48 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago';
}

export function utcClock(now = Date.now()) {
  const d = new Date(now);
  const pad = n => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC',
    date: months[d.getUTCMonth()] + ' ' + pad(d.getUTCDate()) + ', ' + d.getUTCFullYear()
  };
}

// Per-session average range as % of price, scaled against the widest session for bar width.
export function sessionRangeRows(sessions, analytics, lastPrice) {
  const price = toNumber(lastPrice);
  const rows = (sessions || []).map(session => {
    const avg = toNumber(analytics?.history?.[session.id]?.averageRange);
    const percent = avg != null && price ? avg / price * 100 : null;
    return { id: session.id, name: session.name, active: session.active, averageRange: avg, rangePercent: percent, observations: analytics?.history?.[session.id]?.observations || 0 };
  });
  const max = Math.max(0, ...rows.map(r => r.rangePercent || 0));
  return rows.map(r => ({ ...r, barPercent: max > 0 && r.rangePercent != null ? Math.round(r.rangePercent / max * 100) : 0 }));
}

// Summary of the first currency bucket returned by /api/advanced/portfolio/performance.
export function performanceSummary(data) {
  const buckets = Array.isArray(data?.byCurrency) ? data.byCurrency : data?.byCurrency ? Object.values(data.byCurrency) : [];
  const b = buckets.find(x => x?.closedExitExecutions > 0) || buckets[0];
  if (!b) return null;
  return {
    quoteCurrency: b.quoteCurrency,
    closed: b.closedExitExecutions ?? 0,
    winRate: toNumber(b.winRatePercent),
    profitFactor: toNumber(b.profitFactor),
    maxDrawdown: toNumber(b.maxDrawdownCurrency),
    net: toNumber(b.netRealizedPnl)
  };
}

export function systemsStatus({ health, jobs, now = Date.now() }) {
  if (health?.directMode) {
    return { tone: 'warn', label: 'Direct Exchange Mode', detail: 'JPTI API unreachable. Public market data only; ledger, trading and analytics need the API.', updatedAt: now };
  }
  const gateway = health?.status === 'ok';
  const list = Array.isArray(jobs) ? jobs : [];
  const okStates = ['live', 'ok', 'ready', 'registry-checked'];
  const degraded = list.filter(j => !okStates.includes(j?.status));
  if (!gateway) return { tone: 'bad', label: 'API Offline', detail: 'Start the JPTI API service', updatedAt: now };
  if (degraded.length) return { tone: 'warn', label: 'Partially Operational', detail: degraded.length + ' of ' + list.length + ' jobs need attention', updatedAt: now };
  return { tone: 'good', label: 'All Systems Operational', detail: list.length ? list.length + ' jobs healthy' : 'Gateway connected', updatedAt: now };
}

// The API ticker reports last and percentage but no absolute change; derive it (change = last - open, open = last / (1 + pct/100)).
export function priceChange({ last, percentage, change } = {}) {
  const explicit = Number(change);
  if (change != null && change !== '' && Number.isFinite(explicit)) return explicit;
  const l = Number(last); const pct = Number(percentage);
  if (last == null || percentage == null || !Number.isFinite(l) || !Number.isFinite(pct) || pct <= -100) return null;
  return l - l / (1 + pct / 100);
}
