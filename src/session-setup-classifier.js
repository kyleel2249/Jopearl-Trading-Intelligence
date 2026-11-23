import { TRADING_SESSIONS } from './session-intelligence.js';

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const windows = {
  sydney: { start: '08:30', end: '11:30' },
  tokyo: { start: '09:00', end: '12:00' },
  london: { start: '08:00', end: '11:00' },
  'new-york': { start: '08:30', end: '11:30' }
};
const formatterCache = new Map();
function localParts(timestamp, zone) {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    formatterCache.set(zone, formatter);
  }
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(p => [p.type, p.value]));
}
const minutes = value => {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
};
function normalize(candles) {
  if (!Array.isArray(candles)) return [];
  return candles.map(c => Array.isArray(c)
    ? c.slice(0, 6)
    : [c?.timestamp, c?.open, c?.high, c?.low, c?.close, c?.volume])
    .filter(c => c.length === 6 && c.every(v => Number.isFinite(Number(v))) &&
      Number(c[0]) > 0 && Number(c[1]) > 0 &&
      Number(c[2]) >= Math.max(Number(c[1]), Number(c[3]), Number(c[4])) &&
      Number(c[3]) <= Math.min(Number(c[1]), Number(c[2]), Number(c[4])) && Number(c[5]) >= 0)
    .map(c => c.map(Number)).sort((a, b) => a[0] - b[0]);
}
const normalizeSetup = r => String(r.setupId || r.setupType || r.strategy || '').toLowerCase().replaceAll('_', '-');
function matchesHistorical(r, { symbol, session, direction, setupId }) {
  return String(r.symbol || '').toUpperCase() === String(symbol || '').toUpperCase() &&
    String(r.session || '').toLowerCase().split('+').map(s => s.trim()).includes(session.toLowerCase()) &&
    (!direction || String(r.direction || '').toLowerCase() === direction.toLowerCase()) &&
    normalizeSetup(r).includes(setupId.toLowerCase()) &&
    ['win', 'loss', 'breakeven'].includes(String(r.outcome || '').toLowerCase());
}
function expectancyFor(records, filters) {
  const rows = (Array.isArray(records) ? records : []).filter(r => matchesHistorical(r, filters));
  const returns = rows.map(r => Number(r.returnR ?? r.rMultiple)).filter(Number.isFinite);
  const wins = rows.filter(r => String(r.outcome).toLowerCase() === 'win').length;
  const losses = rows.filter(r => String(r.outcome).toLowerCase() === 'loss').length;
  const breakevens = rows.filter(r => String(r.outcome).toLowerCase() === 'breakeven').length;
  const winRate = rows.length ? wins / rows.length : null;
  const averageR = returns.length ? mean(returns) : null;
  const ready = rows.length >= 5 && returns.length >= 5;
  return { sampleCount: rows.length, returnSamples: returns.length, wins, losses, breakevens,
    winRate: winRate === null ? null : Number((winRate * 100).toFixed(2)),
    averageR: averageR === null ? null : Number(averageR.toFixed(3)),
    expectancy: ready ? Number(averageR.toFixed(3)) : null, status: ready ? 'ready' : 'insufficient' };
}
function historicalFalseSweepRate(records, symbol, session) {
  const rows = (Array.isArray(records) ? records : []).filter(r =>
    String(r.symbol || '').toUpperCase() === String(symbol || '').toUpperCase() &&
    String(r.session || '').toLowerCase().split('+').map(s => s.trim()).includes(session.toLowerCase()) &&
    normalizeSetup(r).includes('sweep-reclaim-displacement'));
  const falseCount = rows.filter(r => r.falseSweep === true || r.classification === 'failed-reclaim' ||
    String(r.outcome || '').toLowerCase() === 'false-sweep').length;
  return rows.length ? falseCount / rows.length : 0;
}
export function classifySessionSetups(candles, {
  now = Date.now(), symbol = 'unknown', historicalOutcomes = [],
  confirmationBars = 6, baseDisplacementThreshold = .5
} = {}) {
  const rows = normalize(candles), events = [], sessionSummaries = {};
  if (rows.length < 3) return { status: 'insufficient', events, selected: null, sessionSummaries,
    method: 'closed-candle session sweep → reclaim → displacement classifier' };
  const maxBars = clamp(Math.floor(Number(confirmationBars) || 6), 2, 12);
  const baseThreshold = clamp(Number(baseDisplacementThreshold) || .5, .35, .8);
  const historicalFalseRates = [], adaptiveThresholds = [];
  for (const session of TRADING_SESSIONS) {
    const days = new Map();
    for (const candle of rows) {
      const p = localParts(candle[0], session.timezone), minute = Number(p.hour) * 60 + Number(p.minute);
      if (minute < minutes(session.open) || minute >= minutes(session.close)) continue;
      const date = p.year + '-' + p.month + '-' + p.day;
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(candle);
    }
    const ordered = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    let falseSweeps = 0, totalSweeps = 0;
    const historicalFalseRate = historicalFalseSweepRate(historicalOutcomes, symbol, session.name);
    const adaptiveThreshold = clamp(baseThreshold + historicalFalseRate * .2, .4, .8);
    const win = windows[session.id] || { start: session.open, end: session.close };
    historicalFalseRates.push(historicalFalseRate); adaptiveThresholds.push(adaptiveThreshold);
    for (let d = 1; d < ordered.length; d++) {
      const [date, current] = ordered[d], prior = ordered[d - 1][1];
      if (!current.length || !prior.length) continue;
      const priorHigh = Math.max(...prior.map(c => c[2])), priorLow = Math.min(...prior.map(c => c[3]));
      const candidates = [];
      for (const [side, level] of [['buy-side', priorHigh], ['sell-side', priorLow]]) {
        let used = false;
        for (let i = 0; i < current.length - 1; i++) {
          const c = current[i], minuteParts = localParts(c[0], session.timezone), minute = Number(minuteParts.hour) * 60 + Number(minuteParts.minute);
          const previous = current[i - 1];
          // First candle has no same-session predecessor, so use the prior completed session boundary.
          const priorHighForCross = previous ? previous[2] : priorHigh;
          const priorLowForCross = previous ? previous[3] : priorLow;
          const crossed = side === 'buy-side' ? c[2] > level && priorHighForCross <= level : c[3] < level && priorLowForCross >= level;
          if (!crossed || used) continue;
          used = true; totalSweeps++;
          const direction = side === 'buy-side' ? 'bearish' : 'bullish';
          const entryWindowOpen = minute >= minutes(win.start) && minute < minutes(win.end);
          let reclaimIndex = -1;
          for (let j = i; j <= Math.min(current.length - 1, i + maxBars); j++) {
            if (side === 'buy-side' ? current[j][4] < level : current[j][4] > level) { reclaimIndex = j; break; }
          }
          if (reclaimIndex < 0) {
            falseSweeps++;
            events.push({ id: [session.id, date, side, i].join(':'), session: session.name, sessionId: session.id,
              date, side, level, phase: 'false-sweep', classification: 'failed-reclaim', direction,
              sweepTimestamp: c[0], entryWindowOpen, barsToReclaim: null, displacementThreshold: adaptiveThreshold });
            continue;
          }
          const reclaim = current[reclaimIndex];
          let displacementIndex = -1, bodyRatio = 0;
          for (let k = reclaimIndex + 1; k <= Math.min(current.length - 1, reclaimIndex + maxBars); k++) {
            const follow = current[k], range = follow[2] - follow[3], body = Math.abs(follow[4] - follow[1]);
            bodyRatio = range > 0 ? body / range : 0;
            const displacement = side === 'buy-side'
              ? follow[4] < reclaim[3] && follow[4] < follow[1]
              : follow[4] > reclaim[2] && follow[4] > follow[1];
            if (displacement && bodyRatio >= adaptiveThreshold) { displacementIndex = k; break; }
          }
          const expectancy = expectancyFor(historicalOutcomes, { symbol, session: session.name, direction,
            setupId: 'sweep-reclaim-displacement' });
          const falseRate = totalSweeps ? falseSweeps / totalSweeps : 0;
          if (displacementIndex >= 0) {
            const displacement = current[displacementIndex];
            const expectancyLift = expectancy.status === 'ready' ? clamp((expectancy.expectancy || 0) * .025, -.04, .06) : 0;
            const modelWeight = Number(clamp(.05 + expectancyLift + (expectancy.status === 'ready' && expectancy.expectancy > 0 ? .03 : 0), .02, .12).toFixed(3));
            candidates.push({ id: [session.id, date, side, i].join(':'), session: session.name, sessionId: session.id,
              date, side, level, phase: 'displacement-confirmed', classification: 'sweep-reclaim-displacement', direction,
              sweepTimestamp: c[0], reclaimTimestamp: reclaim[0], displacementTimestamp: displacement[0],
              barsToReclaim: reclaimIndex - i, barsToDisplacement: displacementIndex - reclaimIndex,
              bodyRatio: Number(bodyRatio.toFixed(3)), displacementThreshold: adaptiveThreshold, entryWindowOpen,
              entryWindow: win, expectancy, modelWeight, falseSweepRate: Number(falseRate.toFixed(3)) });
          } else {
            candidates.push({ id: [session.id, date, side, i].join(':'), session: session.name, sessionId: session.id,
              date, side, level, phase: 'reclaim-only', classification: 'displacement-unconfirmed', direction,
              sweepTimestamp: c[0], reclaimTimestamp: reclaim[0], barsToReclaim: reclaimIndex - i,
              entryWindowOpen, entryWindow: win, displacementThreshold: adaptiveThreshold, expectancy,
              modelWeight: 0, falseSweepRate: Number(falseRate.toFixed(3)) });
          }
        }
      }
      events.push(...candidates);
    }
    sessionSummaries[session.id] = { session: session.name, entryWindow: win, sweeps: totalSweeps, falseSweeps,
      falseSweepRate: totalSweeps ? Number((falseSweeps / totalSweeps).toFixed(3)) : null,
      historicalFalseSweepRate: historicalFalseRate, adaptiveDisplacementThreshold: adaptiveThreshold };
  }
  const confirmed = events.filter(e => e.phase === 'displacement-confirmed' && e.entryWindowOpen)
    .sort((a, b) => b.displacementTimestamp - a.displacementTimestamp);
  const selected = confirmed[0] || null;
  return { status: 'ready', symbol, checkedAt: new Date(now).toISOString(), candleCount: rows.length,
    confirmationWindowBars: maxBars, baseDisplacementThreshold: baseThreshold, events: events.slice(-100),
    selected, sessionSummaries,
    adaptivePolicy: { minimumExpectancySample: 5, thresholdBase: baseThreshold,
      historicalFalseSweepRate: mean(historicalFalseRates) || 0, thresholdUsed: mean(adaptiveThresholds) || baseThreshold,
      thresholdAdjustment: 'Historical session false-sweep rate raises the minimum displacement body/range threshold, capped at 0.80.',
      modelWeightRange: [.02, .12] },
    method: 'Closed candles only. Sweeps use completed prior session range, reclaim closes through the swept level, and displacement closes directionally beyond the reclaim candle with an adaptive body/range threshold. First-candle sweeps are compared against the prior session boundary; setups outside session entry windows are never selected.' };
}
