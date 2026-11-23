import { TRADING_SESSIONS, getSessionSnapshot, analyzeSessionCandles } from './session-intelligence.js';

/* Pure, side-effect-free helpers for the JPTI terminal dashboard.
   Nothing here invents market data: every function returns null / '—' when its
   input is missing so the interface can show an honest "unavailable" state. */

export const FIAT = new Set(['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY']);
const STABLE_QUOTES = /^(USDT|USDC|BUSD|FDUSD|TUSD|USD)$/;
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const pad = (n) => String(n).padStart(2, '0');

export function splitSymbol(symbol = '') {
  const [pair] = String(symbol).toUpperCase().split(':');
  const [base = '', quote = ''] = pair.split('/');
  return { base, quote };
}

/** Compact label such as EURUSD / EURUSDT / BTCUSDT. */
export function compactSymbol(symbol = '') {
  const { base, quote } = splitSymbol(symbol);
  return base && quote ? base + quote : String(symbol).replace('/', '');
}

/** Pip / point size and display precision for an instrument. */
export function instrumentProfile(symbol, price) {
  const { base, quote } = splitSymbol(symbol);
  const p = Number(price);
  if (FIAT.has(base)) {
    const jpy = quote === 'JPY' || base === 'JPY';
    return { pip: jpy ? 0.01 : 0.0001, unit: 'pips', digits: jpy ? 3 : 5, fx: true };
  }
  if (base === 'XAU') return { pip: 0.1, unit: 'pips', digits: 2, fx: true };
  if (finite(p) && p >= 1000) return { pip: 1, unit: 'pts', digits: 2, fx: false };
  if (finite(p) && p >= 10) return { pip: 0.01, unit: 'pts', digits: 3, fx: false };
  if (finite(p) && p >= 1) return { pip: 0.001, unit: 'pts', digits: 4, fx: false };
  return { pip: 0.0001, unit: 'pts', digits: 6, fx: false };
}

export function formatPrice(value, profile) {
  if (!finite(value)) return '—';
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: profile?.digits ?? 4, maximumFractionDigits: profile?.digits ?? 4, useGrouping: (profile?.digits ?? 4) <= 3 || Number(value) >= 1000 });
}

export function formatCompact(value) {
  if (!finite(value)) return '—';
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
}

export const toPips = (distance, profile) => (finite(distance) && profile?.pip ? Number(distance) / profile.pip : null);

/* ---------------------------------------------------------------- sessions */

const offsetFormatters = new Map();
function wallClock(ts, timeZone) {
  let f = offsetFormatters.get(timeZone);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); offsetFormatters.set(timeZone, f); }
  const parts = Object.fromEntries(f.formatToParts(new Date(ts)).map((part) => [part.type, part.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}
const minuteOf = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const hhmm = (minute) => { const m = ((Math.round(minute) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ':' + pad(m % 60); };
export const utcMinuteOfDay = (ts) => { const d = new Date(ts); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** DST-aware UTC offset (minutes) of an IANA zone at a timestamp. */
export function zoneOffsetMinutes(ts, timeZone) {
  const diff = wallClock(ts, timeZone) - utcMinuteOfDay(ts);
  return ((diff + 1440 + 720) % 1440) - 720;
}

/** UTC opening window for a trading session (minutes of the UTC day). */
export function sessionUtcWindow(session, ts = Date.now()) {
  const offset = zoneOffsetMinutes(ts, session.timezone);
  const open = (((minuteOf(session.open) - offset) % 1440) + 1440) % 1440;
  const close = (((minuteOf(session.close) - offset) % 1440) + 1440) % 1440;
  return { openMinute: open, closeMinute: close, open: hhmm(open), close: hhmm(close), offsetMinutes: offset };
}

export function inWindow(minute, start, end) {
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Longest run of minutes in which both windows are open. */
export function intersectWindows(a, b) {
  const flags = [];
  for (let m = 0; m < 1440; m += 1) flags.push(inWindow(m, a.openMinute, a.closeMinute) && inWindow(m, b.openMinute, b.closeMinute));
  if (!flags.some(Boolean)) return null;
  const start = flags.findIndex((v, i) => v && !flags[(i + 1439) % 1440]);
  let length = 0;
  while (flags[(start + length) % 1440] && length < 1440) length += 1;
  return { openMinute: start, closeMinute: (start + length) % 1440, minutes: length, open: hhmm(start), close: hhmm((start + length) % 1440) };
}

function windowState(window, ts) {
  const now = utcMinuteOfDay(ts);
  const active = inWindow(now, window.openMinute, window.closeMinute);
  const untilOpen = (((window.openMinute - now) % 1440) + 1440) % 1440;
  const untilClose = (((window.closeMinute - now) % 1440) + 1440) % 1440;
  return { active, startsInMinutes: active ? 0 : untilOpen, remainingMinutes: active ? untilClose : null };
}

export function formatDuration(minutes) {
  if (!finite(minutes) || minutes < 0) return '—';
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60);
  return h ? h + 'h ' + pad(m) + 'm' : m + 'm';
}

export function utcClock(ts = Date.now()) {
  const d = new Date(ts);
  return {
    time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + ' UTC',
    date: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  };
}

const FLAGS = { sydney: '🇦🇺', tokyo: '🇯🇵', london: '🇬🇧', 'new-york': '🇺🇸' };

/** Everything the "Trading Sessions" strip needs. */
export function buildSessionStrip(ts = Date.now()) {
  const snapshot = getSessionSnapshot(ts);
  const sessions = snapshot.sessions.map((session) => {
    const window = sessionUtcWindow(session, ts);
    return { ...session, flag: FLAGS[session.id] || '', utcOpen: window.open, utcClose: window.close, utcWindow: window, utcLabel: window.open + ' – ' + window.close };
  });
  const london = sessions.find((s) => s.id === 'london'), ny = sessions.find((s) => s.id === 'new-york');
  const overlapWin = london && ny ? intersectWindows(london.utcWindow, ny.utcWindow) : null;
  const overlap = overlapWin ? { ...overlapWin, ...windowState(overlapWin, ts), label: overlapWin.open + ' – ' + overlapWin.close } : null;
  return { snapshot, sessions, overlap, killzone: killzoneSchedule(ts), overlapActive: Boolean(overlap?.active) };
}

/* Killzones follow the same local-time definition as session-intelligence.js. */
const KILLZONES = [
  { id: 'london', name: 'London Open', start: '08:00', end: '11:00' },
  { id: 'new-york', name: 'New York Open', start: '08:00', end: '11:00' },
  { id: 'tokyo', name: 'Tokyo Open', start: '09:00', end: '12:00' }
];
export function killzoneSchedule(ts = Date.now()) {
  const list = KILLZONES.map((zone) => {
    const session = TRADING_SESSIONS.find((s) => s.id === zone.id);
    const offset = zoneOffsetMinutes(ts, session.timezone);
    const openMinute = (((minuteOf(zone.start) - offset) % 1440) + 1440) % 1440;
    const closeMinute = (((minuteOf(zone.end) - offset) % 1440) + 1440) % 1440;
    const w = { openMinute, closeMinute };
    return { id: zone.id, name: zone.name, open: hhmm(openMinute), close: hhmm(closeMinute), label: hhmm(openMinute) + ' – ' + hhmm(closeMinute), ...windowState(w, ts) };
  });
  const active = list.find((z) => z.active) || null;
  const next = active ? null : list.slice().sort((a, b) => a.startsInMinutes - b.startsInMinutes)[0] || null;
  return { active, next, all: list };
}

/** Average session range (in pips/points) from multi-day candles. */
export function sessionAnalyticsRows(candles, ts, profile) {
  const analysis = analyzeSessionCandles(candles || [], ts);
  const snapshot = getSessionSnapshot(ts);
  return snapshot.sessions.map((session) => {
    const history = analysis.history?.[session.id];
    const avgRange = history?.averageRange ?? null;
    return {
      id: session.id, name: session.name, active: session.active,
      percent: session.active ? Math.round(session.progressPercent) : 0,
      avg: avgRange == null ? null : toPips(avgRange, profile),
      observations: history?.observations || 0
    };
  });
}

/* ------------------------------------------------------------- volatility */

export function atrValue(candles, period = 14) {
  const rows = (candles || []).filter((c) => Array.isArray(c) && c.length >= 6 && c.slice(1, 6).every(finite)).slice(0, -1);
  if (rows.length < period + 1) return null;
  const tr = rows.slice(1).map((c, i) => Math.max(c[2] - c[3], Math.abs(c[2] - rows[i][4]), Math.abs(c[3] - rows[i][4])));
  const slice = tr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

const RISK_STATES = {
  NORMAL: { label: 'NORMAL', tone: 'ok' },
  RECOVERY: { label: 'RECOVERY', tone: 'warn' },
  CAUTION: { label: 'CAUTION', tone: 'warn' },
  RESTRICTED: { label: 'RESTRICTED', tone: 'bad' },
  HALT_NEW_ENTRIES: { label: 'HALTED', tone: 'bad' }
};

export function feedLive(sources = [], needle) {
  const hit = (sources || []).find((s) => String(s?.name || '').toLowerCase().includes(needle.toLowerCase()));
  return hit ? hit.status === 'live' : false;
}

export function volatilityRiskView({ eventRisk, ticker, candles, profile, sources }) {
  const state = RISK_STATES[eventRisk?.state] || { label: 'UNAVAILABLE', tone: 'idle' };
  const atr = atrValue(candles, 14);
  const spread = finite(ticker?.bid) && finite(ticker?.ask) ? Number(ticker.ask) - Number(ticker.bid) : null;
  const events = eventRisk?.affectedEvents || [];
  const impacts = events.map((e) => e.impact);
  const calendarLive = feedLive(sources, 'Forex Factory');
  const event = !eventRisk ? 'Unavailable' : impacts.includes('high') ? 'High' : impacts.includes('medium') ? 'Medium' : calendarLive ? 'None' : 'Unavailable';
  return {
    state,
    atr, atrPips: toPips(atr, profile),
    spread, spreadPips: toPips(spread, profile),
    relativeVolume: eventRisk?.dynamicVolatility?.relativeVolume ?? null,
    eventRisk: event,
    nextEvent: eventRisk?.nextEvent || null
  };
}

/* -------------------------------------------------------------- liquidity */

export function liquidityRanges(liquidity, price) {
  const p = Number(price ?? liquidity?.referencePrice);
  const pools = liquidity?.pools || [];
  const side = (name, above) => {
    const levels = pools.filter((x) => x.side === name && finite(x.level) && (above ? x.level > p : x.level < p))
      .sort((a, b) => Math.abs(a.level - p) - Math.abs(b.level - p)).slice(0, 2);
    if (!levels.length) return null;
    const prices = levels.map((x) => x.level);
    return { low: Math.min(...prices), high: Math.max(...prices), touches: levels.reduce((s, x) => s + (x.touches || 1), 0), count: levels.length };
  };
  return { buySide: side('buy-side', true), sellSide: side('sell-side', false) };
}

export function imbalanceLabel(pct) {
  if (!finite(pct)) return { text: '—', tone: 'idle' };
  const v = Number(pct);
  return { text: (v > 0 ? '+' : '') + Math.round(v) + '% ' + (v >= 0 ? 'Buy' : 'Sell'), tone: v >= 0 ? 'up' : 'down' };
}

export function fundingLabel(rate) {
  if (!finite(rate)) return '—';
  const pct = Number(rate) * 100;
  return (pct > 0 ? '+' : '') + pct.toFixed(3) + '%';
}

/* ------------------------------------------------------------------ macro */

export function fomcNext(events = [], ts = Date.now()) {
  const next = events.filter((e) => /FOMC|federal open market/i.test(e.title || '') && Date.parse(e.scheduledAt) > ts)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
  return next ? { title: next.title, at: next.scheduledAt, label: new Date(next.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) } : null;
}

export function macroRows(macro, events, ts = Date.now()) {
  const list = macro?.indicators || [];
  const byId = Object.fromEntries(list.map((i) => [i.id, i]));
  const num = (v) => (finite(v) ? Number(v) : null);
  const fed = num(byId.FEDFUNDS?.latest);
  const cpi = num(byId.CPIAUCSL?.yearOverYearPercent);
  const pce = num(byId.PCEPI?.yearOverYearPercent);
  const nfpLatest = num(byId.PAYEMS?.latest), nfpPrev = num(byId.PAYEMS?.previous);
  const nfp = nfpLatest !== null && nfpPrev !== null ? nfpLatest - nfpPrev : null;
  return {
    configured: list.length > 0,
    rows: [
      { id: 'fed', label: 'Fed Funds Rate', value: fed === null ? '—' : fed.toFixed(2) + '%', date: byId.FEDFUNDS?.latestDate || null },
      { id: 'cpi', label: 'CPI (YoY)', value: cpi === null ? '—' : cpi.toFixed(1) + '%', date: byId.CPIAUCSL?.latestDate || null },
      { id: 'pce', label: 'PCE (YoY)', value: pce === null ? '—' : pce.toFixed(1) + '%', date: byId.PCEPI?.latestDate || null },
      { id: 'nfp', label: 'NFP (Latest)', value: nfp === null ? '—' : (nfp > 0 ? '+' : '') + Math.round(nfp) + 'K', date: byId.PAYEMS?.latestDate || null }
    ],
    nextFomc: fomcNext(events, ts)
  };
}

/* --------------------------------------------------------------- calendar */

export function relevantCurrencies(symbol) {
  const { base, quote } = splitSymbol(symbol);
  const set = new Set(['GLOBAL']);
  if (base) set.add(base);
  if (quote) set.add(STABLE_QUOTES.test(quote) ? 'USD' : quote);
  if (base && !FIAT.has(base)) set.add('USD');
  return set;
}

export function upcomingCalendar(events = [], symbol, ts = Date.now(), limit = 3) {
  const currencies = relevantCurrencies(symbol);
  const from = ts - 30 * 60000, to = ts + 36 * 3600000;
  const rank = { high: 0, medium: 1 };
  return events
    .filter((e) => ['high', 'medium'].includes(e.impact) && e.category !== 'central-bank-speaker' && currencies.has(String(e.currency || 'GLOBAL').toUpperCase()))
    .filter((e) => { const t = Date.parse(e.scheduledAt); return t >= from && t <= to; })
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt) || rank[a.impact] - rank[b.impact])
    .slice(0, limit)
    .map((e) => ({ id: e.id, time: hhmm(utcMinuteOfDay(Date.parse(e.scheduledAt))), title: e.title, currency: e.currency, impact: e.impact, forecast: e.forecast ?? null, actual: e.actual ?? null, past: Date.parse(e.scheduledAt) < ts }));
}

export function parseFeedDate(value) {
  if (!value) return null;
  const s = String(value);
  const g = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (g) return Date.UTC(+g[1], +g[2] - 1, +g[3], +g[4], +g[5], +g[6]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function timeAgo(ts, at) {
  if (!finite(at)) return '—';
  const diff = Math.max(0, Math.round((ts - at) / 60000));
  if (diff < 1) return 'now';
  if (diff < 60) return diff + 'm ago';
  if (diff < 1440) return Math.round(diff / 60) + 'h ago';
  return Math.round(diff / 1440) + 'd ago';
}

export function newsAndSpeakers({ news = [], calendar = [] }, ts = Date.now(), limit = 3) {
  const items = [];
  for (const a of news) { const at = parseFeedDate(a.publishedAt); if (a.title && at && at <= ts + 3600000) items.push({ id: a.id || a.url, title: a.title, url: a.url, source: a.domain || 'News', at, kind: 'news' }); }
  for (const e of calendar) {
    const at = Date.parse(e.scheduledAt);
    if (e.category === 'central-bank-speaker' && Number.isFinite(at) && at <= ts && at >= ts - 72 * 3600000) items.push({ id: e.id, title: e.title, url: e.url, source: String(e.provider || '').replace('official:', ''), at, kind: 'speaker' });
  }
  const seen = new Set();
  return items.sort((a, b) => b.at - a.at).filter((i) => { const k = i.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit)
    .map((i) => ({ ...i, ago: timeAgo(ts, i.at) }));
}

export function earningsRows(results = []) {
  const rows = [];
  for (const { symbol, events } of results) {
    const next = (events || []).filter((e) => Number.isFinite(Date.parse(e.scheduledAt))).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0];
    if (!next) continue;
    const timing = String(next.earningsMetrics?.releaseTiming || '').toLowerCase();
    rows.push({ symbol, date: new Date(next.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), timing: timing === 'bmo' ? 'BMO' : timing === 'amc' ? 'AMC' : timing === 'dmh' ? 'DMH' : '', at: next.scheduledAt });
  }
  return rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/* ------------------------------------------------------------ performance */

export function journalPerformance(records = []) {
  const trades = records.filter((r) => ['win', 'loss', 'breakeven'].includes(r?.outcome));
  if (!trades.length) return { trades: 0, winRate: null, profitFactor: null, maxDrawdownR: null, rTrades: 0 };
  const wins = trades.filter((r) => r.outcome === 'win').length;
  const rs = trades.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map((r) => (finite(r.returnR) ? Number(r.returnR) : null)).filter((v) => v !== null);
  const gain = rs.filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(rs.filter((v) => v < 0).reduce((a, b) => a + b, 0));
  let equity = 0, peak = 0, dd = 0;
  for (const r of rs) { equity += r; peak = Math.max(peak, equity); dd = Math.max(dd, peak - equity); }
  return { trades: trades.length, winRate: wins / trades.length * 100, profitFactor: loss > 0 ? gain / loss : null, maxDrawdownR: rs.length ? dd : null, rTrades: rs.length };
}

/* --------------------------------------------------------------- insights */

export function keyInsights({ strip, context, price, profile, symbol }) {
  const out = [];
  const names = strip.snapshot.activeSessionNames;
  const vol = context?.eventRisk?.dynamicVolatility;
  const volText = vol ? (vol.severe ? 'severe volatility' : vol.elevated ? 'increased volatility' : 'normal volatility') : null;
  if (strip.overlapActive) out.push({ tone: 'up', text: 'London–New York overlap active' + (volText ? ' — ' + volText : '') });
  else if (names.length) out.push({ tone: 'up', text: names.join(' + ') + ' session' + (names.length > 1 ? 's' : '') + ' active' + (volText ? ' — ' + volText : '') });
  else out.push({ tone: 'idle', text: 'No major session open' + (strip.killzone.next ? ' — ' + strip.killzone.next.name + ' in ' + formatDuration(strip.killzone.next.startsInMinutes) : '') });
  const r = liquidityRanges(context?.liquidity, price);
  if (r.buySide) out.push({ tone: 'warn', text: 'Buy-side liquidity at ' + formatPrice(r.buySide.low, profile) + (r.buySide.high !== r.buySide.low ? '–' + formatPrice(r.buySide.high, profile) : '') });
  else if (r.sellSide) out.push({ tone: 'warn', text: 'Sell-side liquidity at ' + formatPrice(r.sellSide.high, profile) + (r.sellSide.high !== r.sellSide.low ? '–' + formatPrice(r.sellSide.low, profile) : '') });
  else out.push({ tone: 'idle', text: 'No confirmed liquidity pools for ' + compactSymbol(symbol) + ' yet' });
  const sweeps = context?.liquidity?.sweeps;
  if (sweeps?.recentHighSweep || sweeps?.recentLowSweep) out.push({ tone: 'warn', text: 'Recent ' + (sweeps.recentHighSweep ? 'buy-side' : 'sell-side') + ' sweep detected — watch for reversal or continuation' });
  else if (context) out.push({ tone: 'idle', text: 'Watch for breakout or sweep of nearby liquidity' });
  return out.slice(0, 3);
}

/* ----------------------------------------------------------- trade ticket */

/** Position sizing from risk %, stop distance and equity; no order is created. */
export function sizeTicket({ equity, riskPercent, stopPips, profile, price }) {
  const eq = Number(equity), risk = Number(riskPercent), stop = Number(stopPips), p = Number(price);
  if (![eq, risk, stop, p].every((v) => Number.isFinite(v) && v > 0) || !profile?.pip) return null;
  const riskAmount = eq * risk / 100;
  const stopDistance = stop * profile.pip;
  return { riskAmount, stopDistance, quantity: riskAmount / stopDistance, notional: riskAmount / stopDistance * p };
}

export function ticketLevels({ side, price, stopPips, targetPips, profile }) {
  const p = Number(price);
  if (!Number.isFinite(p) || !profile?.pip) return null;
  const sgn = side === 'buy' ? 1 : -1;
  return { stop: p - sgn * Number(stopPips) * profile.pip, target: p + sgn * Number(targetPips) * profile.pip, rewardRisk: Number(stopPips) > 0 ? Number(targetPips) / Number(stopPips) : null };
}

export function systemStatus({ health, operations, loadError }) {
  if (!health || loadError) return { label: 'API Offline', tone: 'bad', detail: loadError || 'Gateway not reachable' };
  const bad = (operations?.jobs || []).filter((j) => ['error', 'failed', 'degraded', 'unavailable', 'bad'].includes(String(j.status).toLowerCase()));
  if (health.status !== 'ok') return { label: 'Degraded', tone: 'warn', detail: 'Gateway reported ' + health.status };
  if (bad.length) return { label: 'Degraded', tone: 'warn', detail: bad.map((j) => j.label).join(', ') };
  return { label: 'All Systems Operational', tone: 'ok', detail: 'Gateway ' + (health.mode || 'online') };
}
