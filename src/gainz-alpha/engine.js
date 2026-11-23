// GainzAlpha signal + setup engine: V2-style confluence scoring and Alpha-style sweep -> reclaim -> displacement.
// Pure and deterministic: same inputs always give the same output. Closed candles drive confirmed results.
import {
  clamp, mean, timeframeMs, normalizeCandles, splitClosed, emaSeries, rsiValue, atrSeries, macdValue, relativeVolume,
  findSwings, equalLevels, structureEvents, fairValueGaps, utcDayKey, sessionOf
} from './indicators.js';
import { resolvePreset, MODEL_VERSION } from './presets.js';
import { summarize, calibrate, calibrationTable } from './learning.js';

export const STATES = ['IDLE', 'LIQUIDITY_IDENTIFIED', 'SWEEP_DETECTED', 'RECLAIM_PENDING', 'RECLAIM_CONFIRMED', 'DISPLACEMENT_PENDING', 'DISPLACEMENT_CONFIRMED', 'ENTRY_READY', 'ACTIVE', 'INVALIDATED', 'EXPIRED', 'COMPLETED'];
const T = {
  IDLE: ['LIQUIDITY_IDENTIFIED'],
  LIQUIDITY_IDENTIFIED: ['SWEEP_DETECTED', 'IDLE', 'EXPIRED'],
  SWEEP_DETECTED: ['RECLAIM_PENDING', 'RECLAIM_CONFIRMED', 'INVALIDATED', 'EXPIRED'],
  RECLAIM_PENDING: ['RECLAIM_CONFIRMED', 'INVALIDATED', 'EXPIRED'],
  RECLAIM_CONFIRMED: ['DISPLACEMENT_PENDING', 'DISPLACEMENT_CONFIRMED', 'INVALIDATED', 'EXPIRED'],
  DISPLACEMENT_PENDING: ['DISPLACEMENT_CONFIRMED', 'INVALIDATED', 'EXPIRED'],
  DISPLACEMENT_CONFIRMED: ['ENTRY_READY', 'INVALIDATED', 'EXPIRED'],
  ENTRY_READY: ['ACTIVE', 'INVALIDATED', 'EXPIRED'],
  ACTIVE: ['COMPLETED', 'INVALIDATED'],
  INVALIDATED: [], EXPIRED: [], COMPLETED: []
};
export const canTransition = (from, to) => (T[from] || []).includes(to);
export function advance(from, to) {
  if (!canTransition(from, to)) throw new Error('Illegal setup transition ' + from + ' -> ' + to);
  return to;
}
const RANK = Object.fromEntries(STATES.map((s, i) => [s, i]));
const STAGE_LIQ = { SWEEP_DETECTED: 0.15, RECLAIM_PENDING: 0.15, RECLAIM_CONFIRMED: 0.35, DISPLACEMENT_PENDING: 0.35, DISPLACEMENT_CONFIRMED: 1, ENTRY_READY: 1, ACTIVE: 1 };

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function insufficient(ctx, why, count) {
  return { status: 'insufficient', reason: why, symbol: ctx.symbol, exchange: ctx.exchange, timeframe: ctx.timeframe, preset: ctx.cfg.id, modelVersion: MODEL_VERSION, candleCount: count, signal: 'WAIT', direction: 0, confirmed: false, provisional: ctx.provisional, confidence: 0, score: 0, setup: null, factors: [], explanation: { positives: [], negatives: [why] }, blockers: [why], riskPlan: null };
}

function buildLevels(work, swings, pools, atr, tf) {
  const levels = [];
  const add = (side, price, type, confirmedAt) => levels.push({ side, price, type, confirmedAt });
  swings.highs.forEach((s) => add('buy-side', s.price, 'swing-high', s.confirmedAt));
  swings.lows.forEach((s) => add('sell-side', s.price, 'swing-low', s.confirmedAt));
  pools.highs.forEach((p) => add('buy-side', p.price, 'equal-high', p.confirmedAt));
  pools.lows.forEach((p) => add('sell-side', p.price, 'equal-low', p.confirmedAt));
  // Previous UTC day high/low become known from the first bar of the following day (intraday timeframes only).
  if (tf && tf < 86400e3) {
    const days = new Map();
    work.forEach((c, i) => { const k = utcDayKey(c[0]); const d = days.get(k) || { hi: -Infinity, lo: Infinity, first: i }; d.hi = Math.max(d.hi, c[2]); d.lo = Math.min(d.lo, c[3]); days.set(k, d); });
    const keys = [...days.keys()];
    for (let k = 1; k < keys.length; k++) { const prev = days.get(keys[k - 1]), cur = days.get(keys[k]); add('buy-side', prev.hi, 'prev-day-high', cur.first); add('sell-side', prev.lo, 'prev-day-low', cur.first); }
  }
  return levels;
}

function scanSetup(work, levels, atrS, cfg, thr, symbol, timeframe, tfMs) {
  const last = work.length - 1, scanFrom = Math.max(21, last - (cfg.expireBars + cfg.reclaimWindow + cfg.dispWindow + 2));
  const prio = { 'equal-high': 4, 'equal-low': 4, 'prev-day-high': 3, 'prev-day-low': 3, 'swing-high': 2, 'swing-low': 2, 'range-high': 1, 'range-low': 1 };
  const found = [];
  for (let i = scanFrom; i <= last; i++) {
    const c = work[i], a = atrS[i] || atrS[i - 1];
    if (!a) continue;
    const rangeHi = Math.max(...work.slice(i - 20, i).map((x) => x[2])), rangeLo = Math.min(...work.slice(i - 20, i).map((x) => x[3]));
    const cands = [...levels.filter((l) => l.confirmedAt < i), { side: 'buy-side', price: rangeHi, type: 'range-high', confirmedAt: 0 }, { side: 'sell-side', price: rangeLo, type: 'range-low', confirmedAt: 0 }];
    const minDepth = (cfg.minSweepDepthAtr ?? 0.2) * a;
    const hits = cands.filter((l) => (l.side === 'buy-side' ? c[2] - l.price >= minDepth && c[2] > l.price && work[i - 1][2] <= l.price : l.price - c[3] >= minDepth && c[3] < l.price && work[i - 1][3] >= l.price));
    if (!hits.length) continue;
    hits.sort((x, y) => prio[y.type] - prio[x.type] || (x.side === 'buy-side' ? x.price - y.price : y.price - x.price));
    found.push({ i, level: hits[0] });
  }
  const built = [];
  for (const f of found.sort((x, y) => y.i - x.i).slice(0, 8)) {
    const { i, level } = f, c = work[i], a = atrS[i] || atrS[i - 1], bear = level.side === 'buy-side', dir = bear ? -1 : 1;
    const range = Math.max(c[2] - c[3], 1e-12);
    const sweep = { index: i, ts: c[0], level: level.price, levelType: level.type, side: level.side, direction: dir, extreme: bear ? c[2] : c[3], depthAtr: round((bear ? c[2] - level.price : level.price - c[3]) / a, 3), rejection: round((bear ? c[2] - Math.max(c[1], c[4]) : Math.min(c[1], c[4]) - c[3]) / range, 3), volume: c[5], atr: a, session: sessionOf(c[0]) };
    const trace = [{ state: 'IDLE', index: i }];
    let state = 'IDLE';
    const go = (to, index, note) => { state = advance(state, to); trace.push({ state, index, note }); };
    go('LIQUIDITY_IDENTIFIED', i); go('SWEEP_DETECTED', i);
    let reclaim = -1;
    for (let j = i; j <= Math.min(last, i + cfg.reclaimWindow); j++) {
      const r = work[j], rr = Math.max(r[2] - r[3], 1e-12), inside = bear ? r[4] < level.price : r[4] > level.price;
      const strong = Math.abs(r[4] - r[1]) / rr >= 0.3 || Math.abs(r[4] - level.price) >= 0.1 * a;
      if (inside && strong) { reclaim = j; break; }
    }
    let invalidReason = null, disp = -1, dispBar = null;
    if (reclaim < 0) {
      if (i + cfg.reclaimWindow > last) go('RECLAIM_PENDING', last); else { invalidReason = 'breakout-not-sweep'; go('INVALIDATED', last, invalidReason); }
    } else {
      go('RECLAIM_CONFIRMED', reclaim);
      for (let k = reclaim + 1; k <= Math.min(last, reclaim + cfg.dispWindow); k++) {
        const d = work[k], r = Math.max(d[2] - d[3], 1e-12), body = Math.abs(d[4] - d[1]), ak = atrS[k] || a;
        const dirOk = bear ? d[4] < d[1] && d[4] < work[reclaim][3] : d[4] > d[1] && d[4] > work[reclaim][2];
        if (dirOk && body / r >= thr && body >= ak * cfg.dispAtrMult) { disp = k; dispBar = { bodyRatio: round(body / r, 3), bodyAtr: round(body / ak, 3), rangeAtr: round(r / ak, 3), index: k, ts: d[0], volume: d[5] }; break; }
      }
      if (disp < 0) {
        if (reclaim + cfg.dispWindow > last) go('DISPLACEMENT_PENDING', last); else { invalidReason = 'no-displacement'; go('DISPLACEMENT_PENDING', last); go('INVALIDATED', last, invalidReason); }
      } else {
        go('DISPLACEMENT_CONFIRMED', disp);
        const broken = work.slice(disp + 1).some((x) => (bear ? x[4] > sweep.extreme : x[4] < sweep.extreme));
        if (broken) { invalidReason = 'closed-beyond-sweep-extreme'; go('INVALIDATED', last, invalidReason); }
      }
    }
    if (!['INVALIDATED', 'EXPIRED'].includes(state) && last - i > cfg.expireBars) { go('EXPIRED', last, 'setup-expired'); }
    built.push({ id: [symbol, timeframe, dir, sweep.ts, level.type].join('|'), type: 'sweep-reclaim-displacement', direction: dir, state, trace, sweep, reclaimIndex: reclaim, reclaimTs: reclaim >= 0 ? work[reclaim][0] : null, displacementIndex: disp, displacement: dispBar, invalidReason, ageBars: last - i, expiresInBars: Math.max(0, cfg.expireBars - (last - i)), tfMs });
  }
  const live = built.filter((b) => !['INVALIDATED', 'EXPIRED'].includes(b.state));
  const rankOf = (b) => STATES.indexOf(b.state);
  if (live.length) return live.sort((a, b) => rankOf(b) - rankOf(a) || a.ageBars - b.ageBars)[0];
  return built.sort((a, b) => a.ageBars - b.ageBars)[0] || null;
}

function htfBias(rows, timeframe, now) {
  const { closed } = splitClosed(normalizeCandles(rows), timeframe, now);
  if (closed.length < 30) return { timeframe, status: 'insufficient', bias: 0 };
  const tf = timeframeMs(timeframe), closes = closed.map((c) => c[4]), e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const lastTs = closed[closed.length - 1][0];
  if (tf && now - (lastTs + tf) > 2 * tf) return { timeframe, status: 'stale', bias: 0 };
  const sw = findSwings(closed, 3), st = structureEvents(closed, sw), n = closes.length - 1;
  const bias = clamp(((closes[n] > e20[n] ? 1 : -1) + (e20[n] > e50[n] ? 1 : -1) + st.trend) / 3, -1, 1);
  return { timeframe, status: 'fresh', bias: round(bias, 3), structureTrend: st.trend };
}

export function analyzeGainzAlpha(candles, opts = {}) {
  const { symbol = 'unknown', exchange = 'unknown', timeframe = 'unknown', now = Date.now(), mode = 'confirmed', outcomes = [], model = null, recentSignals = [], higherTimeframes = [], equity = null } = opts;
  const cfg = resolvePreset(opts.preset, opts.overrides);
  const provisional = mode === 'preview';
  const ctx = { symbol, exchange, timeframe, cfg, provisional };
  const rows = normalizeCandles(candles);
  const split = splitClosed(rows, timeframe, now);
  const work = provisional && split.forming ? [...split.closed, split.forming] : split.closed;
  if (work.length < cfg.minBars) return insufficient(ctx, 'Need ' + cfg.minBars + ' candles, have ' + work.length, work.length);
  const tf = timeframeMs(timeframe), last = work.length - 1, c = work[last], prev = work[last - 1];
  const closes = work.map((x) => x[4]), atrS = atrSeries(work, 14), atr = atrS[last];
  if (!atr) return insufficient(ctx, 'ATR unavailable', work.length);
  const sw = findSwings(work, cfg.swingLen), st = structureEvents(work, sw);
  const pools = { highs: equalLevels(sw.highs.slice(-12), atr * 0.25), lows: equalLevels(sw.lows.slice(-12), atr * 0.25) };
  const gaps = fairValueGaps(work, atr * 0.1);

  // Volatility regime from ATR% percentile over the available history.
  const atrPcts = atrS.map((a, i) => (a ? a / work[i][4] : null)).filter((v) => v != null), cur = atrPcts[atrPcts.length - 1];
  const rank = atrPcts.filter((v) => v <= cur).length / atrPcts.length;
  const volRegime = rank > 0.85 ? 'high' : rank < 0.2 ? 'low' : 'normal';
  const atrTrend = mean(atrS.slice(-5)) / (mean(atrS.slice(-20, -5)) || atr);

  // --- Factors (-1..+1) -----------------------------------------------------------------
  const e = (p) => emaSeries(closes, p), e9 = e(9), e20 = e(20), e50 = e(50), e100 = closes.length >= 100 ? e(100) : null, e200 = closes.length >= 200 ? e(200) : null;
  let trendRaw = (c[4] > e20[last] ? 1 : -1) + (e20[last] > e50[last] ? 1 : -1) + (e9[last] > e20[last] ? 0.5 : -0.5);
  let trendN = 2.5;
  if (e100) { trendRaw += e50[last] > e100[last] ? 0.5 : -0.5; trendN += 0.5; }
  if (e200) { trendRaw += e100 && e100[last] > e200[last] ? 0.5 : -0.5; trendN += 0.5; }
  const slope = (e20[last] - e20[last - 5]) / atr;
  let trend = clamp(trendRaw / trendN + clamp(slope, -1, 1) * 0.25, -1, 1);
  const stretch = (c[4] - e20[last]) / atr, exhausted = Math.abs(stretch) > 3.2;
  if (exhausted) trend *= 0.5;
  const rsi = rsiValue(closes), macd = macdValue(closes), roc = closes[last] / closes[last - 10] - 1;
  const accel = macd ? Math.sign(macd.histogram - macd.prevHistogram) : 0;
  const momentum = clamp((((rsi ?? 50) - 50) / 25) * 0.4 + (macd ? Math.sign(macd.histogram) * 0.3 + accel * 0.1 : 0) + clamp(roc / ((atr / c[4]) * 5), -1, 1) * 0.2, -1, 1);
  const rv = relativeVolume(work), candleDir = Math.sign(c[4] - c[1]);
  const volume = rv == null ? 0 : candleDir * clamp((rv - 1) / 1, 0, 1);
  const recentEv = st.events.filter((x) => last - x.index <= 25), lastEv = recentEv[recentEv.length - 1];
  const structure = st.trend * (lastEv ? (lastEv.kind === 'CHoCH' ? 1 : 0.8) : 0.4);
  const swingHi = sw.highs[sw.highs.length - 1], swingLo = sw.lows[sw.lows.length - 1];
  const dealing = swingHi && swingLo && swingHi.price > swingLo.price ? (c[4] - swingLo.price) / (swingHi.price - swingLo.price) : 0.5;
  const location = clamp((0.5 - dealing) * 2, -1, 1);

  const thr = clamp(cfg.dispBase + (volRegime === 'high' ? 0.05 : volRegime === 'low' ? -0.03 : 0) + (model?.dispAdjust || 0), 0.4, 0.8);
  const ctxFilter = { symbol, timeframe };
  const levels = buildLevels(work, sw, pools, atr, tf);
  const setup = scanSetup(work, levels, atrS, cfg, thr, symbol, timeframe, tf);
  const sDir = setup ? setup.direction : 0, sRank = setup ? RANK[setup.state] : 0;
  const liquidity = setup ? sDir * (STAGE_LIQ[setup.state] ?? 0) : 0;
  const dQuality = setup?.displacement ? clamp(setup.displacement.bodyRatio / thr * 0.6 + setup.displacement.bodyAtr / 2 * 0.4, 0, 1.2) / 1.2 : 0;
  const displacement = setup && sRank >= RANK.DISPLACEMENT_CONFIRMED && sRank <= RANK.ACTIVE ? sDir * clamp(dQuality, 0, 1) : 0;
  const fresh = gaps.filter((g) => g.status !== 'filled' && last - g.index <= 30);
  const dirGap = fresh.filter((g) => (sDir ? (sDir > 0) === (g.direction === 'bullish') : (st.trend >= 0) === (g.direction === 'bullish'))).slice(-1)[0];
  const fvg = dirGap ? (dirGap.direction === 'bullish' ? 1 : -1) * (1 - dirGap.fillPct / 100) * (sDir || st.trend ? 1 : 0.5) : 0;

  const wMul = model?.weights || {};
  const raw = { trend, momentum, volume, structure, liquidity, displacement, fvg, location };
  const factors = Object.entries(raw).map(([key, value]) => {
    const weight = (cfg.weights[key] ?? 0) * (wMul[key] ?? 1);
    return { key, value: round(value, 3), weight: round(weight, 4), contribution: round(weight * value, 4) };
  });
  const wSum = factors.reduce((s, f) => s + f.weight, 0) || 1;
  const score = round(factors.reduce((s, f) => s + f.contribution, 0) / wSum, 4);

  // --- Higher timeframe -----------------------------------------------------------------
  const htfInputs = (higherTimeframes || []).filter((h) => !cfg.htf.length || cfg.htf.includes(h.timeframe));
  const htf = htfInputs.map((h) => htfBias(h.candles, h.timeframe, now));
  const fresh_htf = htf.filter((h) => h.status === 'fresh');

  // --- Expectancy / false-signal memory (scoped by symbol + timeframe + preset) ---------
  const scope = { symbol, timeframe, preset: cfg.id };
  const stats = summarize(outcomes, scope);
  const statsSetup = summarize(outcomes, { ...scope, setupType: setup?.type || 'confluence' });
  const calib = calibrationTable(outcomes.filter((r) => r.symbol === symbol && r.timeframe === timeframe));

  // --- Gating -----------------------------------------------------------------------------
  const dir = Math.abs(score) >= cfg.minScore ? Math.sign(score) : 0;
  const aligned = (k) => (dir ? raw[k] * dir >= 0.25 : false);
  const confirmations = factors.filter((f) => aligned(f.key)).map((f) => f.key);
  const blockers = [], missing = [];
  const need = (flag, ok, label) => { if (flag && !ok) { blockers.push(label); missing.push(label); } };
  const setupLive = setup && dir && setup.direction === dir && RANK[setup.state] >= RANK.RECLAIM_CONFIRMED && !['INVALIDATED', 'EXPIRED'].includes(setup.state);
  need(cfg.requireTrend, aligned('trend'), 'trend alignment');
  need(cfg.requireMomentum, aligned('momentum'), 'momentum alignment');
  need(cfg.requireVolume, aligned('volume') || (rv != null && rv >= cfg.volMin && candleDir === dir), 'volume confirmation');
  need(cfg.requireSweep, setupLive, 'liquidity sweep + reclaim');
  need(cfg.requireDisplacement, setupLive && RANK[setup.state] >= RANK.DISPLACEMENT_CONFIRMED, 'displacement');
  if (dir && confirmations.length < cfg.minConfluence) blockers.push('confluence ' + confirmations.length + '/' + cfg.minConfluence);
  const opposing = fresh_htf.filter((h) => h.bias * dir < -0.2), agreeing = fresh_htf.filter((h) => h.bias * dir > 0.2);
  if (dir && cfg.requireHtf && (!fresh_htf.length || opposing.length)) blockers.push(!fresh_htf.length ? 'higher-timeframe data missing or stale' : 'higher timeframe opposes');
  if (dir && cfg.sessions && !cfg.sessions.includes(sessionOf(c[0]))) blockers.push('outside allowed session');
  if (dir && setup && setup.direction !== dir && RANK[setup.state] >= RANK.RECLAIM_CONFIRMED && !['INVALIDATED', 'EXPIRED'].includes(setup.state)) blockers.push('active setup opposes score direction');
  if (dir && cfg.requirePositiveExpectancy && stats.reliable && stats.expectancy < 0) blockers.push('negative historical expectancy');
  if (dir && cfg.maxFalseRate != null && stats.reliable && stats.falseRate > cfg.maxFalseRate) blockers.push('false-signal rate too high');
  const setupId = setupLive ? setup.id : [symbol, timeframe, dir, c[0], 'confluence'].join('|');
  if (dir && recentSignals.some((s) => s.setupId === setupId && s.direction === (dir > 0 ? 'BUY' : 'SELL'))) blockers.push('duplicate setup already signalled');
  else if (dir && tf && recentSignals.some((s) => s.symbol === symbol && s.timeframe === timeframe && s.direction === (dir > 0 ? 'BUY' : 'SELL') && c[0] - s.candleTs < cfg.cooldownBars * tf && c[0] > s.candleTs)) blockers.push('signal cooldown');

  // --- Risk plan --------------------------------------------------------------------------
  let riskPlan = null;
  if (dir) {
    const cost = c[4] * (cfg.costs.spreadPct + cfg.costs.slippagePct);
    const swingStop = dir > 0 ? (swingLo ? swingLo.price : c[4] - atr * cfg.stopAtr) : (swingHi ? swingHi.price : c[4] + atr * cfg.stopAtr);
    let stop = c[4] - dir * atr * cfg.stopAtr;
    if (setupLive) stop = setup.sweep.extreme - dir * 0.25 * atr;
    else if ((dir > 0 && swingStop < c[4] && swingStop > c[4] - atr * cfg.maxStopAtr) || (dir < 0 && swingStop > c[4] && swingStop < c[4] + atr * cfg.maxStopAtr)) stop = dir > 0 ? Math.min(stop, swingStop - 0.1 * atr) : Math.max(stop, swingStop + 0.1 * atr);
    stop -= dir * cost;
    let risk = (c[4] - stop) * dir;
    if (risk < atr * 0.5) { stop = c[4] - dir * atr * 0.5; risk = atr * 0.5; }
    const pts = dir > 0 ? [...sw.highs.map((s) => s.price), ...pools.highs.map((p) => p.price)].filter((p) => p > c[4]).sort((a, b) => a - b) : [...sw.lows.map((s) => s.price), ...pools.lows.map((p) => p.price)].filter((p) => p < c[4]).sort((a, b) => b - a);
    const rr = (p) => ((p - c[4]) * dir) / risk;
    const liqTp = pts.find((p) => rr(p) >= cfg.minRR);
    const tp1 = liqTp ?? c[4] + dir * risk * cfg.minRR, tp1Src = liqTp != null ? 'liquidity' : 'atr-multiple';
    const tp2 = pts.find((p) => (p - tp1) * dir > risk * 0.5) ?? c[4] + dir * risk * (rr(tp1) + 1);
    const tp3 = cfg.tp3 ? c[4] + dir * risk * Math.max(rr(tp2) + 1, 4) : null;
    riskPlan = { entry: round(c[4], 8), entryModel: 'next-open-after-close', stopLoss: round(stop, 8), takeProfit1: round(tp1, 8), takeProfit2: round(tp2, 8), takeProfit3: tp3 == null ? null : round(tp3, 8), tp1Source: tp1Src, riskPerUnit: round(risk, 8), riskAtr: round(risk / atr, 2), rr1: round(rr(tp1), 2), rr2: round(rr(tp2), 2), invalidation: setupLive ? round(setup.sweep.extreme, 8) : round(stop, 8), costs: cfg.costs, suggestedUnits: equity ? round((equity * 0.01) / risk, 6) : null, authorizesOrder: false };
    if (risk > atr * cfg.maxStopAtr) { blockers.push('stop too wide (' + round(risk / atr, 1) + ' ATR)'); }
    if (riskPlan.rr1 < cfg.minRR) blockers.push('risk/reward below ' + cfg.minRR);
  }

  // --- Confidence (heuristic; NOT a win probability unless calibrated from outcomes) ------
  const setupQuality = setupLive ? clamp((sRank / RANK.ENTRY_READY) * 0.5 + (setup.sweep.rejection || 0) * 0.3 + dQuality * 0.2, 0, 1) : 0;
  let confidence = 38 + Math.abs(score) * 30 + Math.min(confirmations.length, 6) * 3 + setupQuality * 12 + agreeingBonus(agreeing, opposing);
  if (statsSetup.reliable) confidence += clamp(statsSetup.expectancy * 4, -8, 8);
  if (stats.reliable && stats.falseRate != null) confidence -= stats.falseRate * 15;
  if (volRegime === 'high') confidence -= 4;
  if (setup && setup.expiresInBars <= 2) confidence -= 5;
  confidence = Math.round(clamp(confidence, 0, 95));
  const calibration = calibrate(confidence, calib);

  // --- Final signal -----------------------------------------------------------------------
  let signal = 'WAIT';
  const confOk = confidence >= cfg.minConfidence;
  if (dir && !confOk) blockers.push('confidence ' + confidence + ' < ' + cfg.minConfidence);
  if (dir && !blockers.length) signal = dir > 0 ? 'BUY' : 'SELL';
  else if (!dir && setup && setup.state === 'INVALIDATED' && setup.ageBars <= cfg.expireBars) signal = 'INVALIDATED';
  else if (!dir && Math.abs(score) < cfg.minScore * 0.5) signal = 'NEUTRAL';
  let stage = setup ? setup.state : 'IDLE';
  if (signal !== 'BUY' && signal !== 'SELL' && stage === 'DISPLACEMENT_CONFIRMED') stage = 'DISPLACEMENT_CONFIRMED';
  if ((signal === 'BUY' || signal === 'SELL') && setupLive && RANK[setup.state] >= RANK.DISPLACEMENT_CONFIRMED) stage = 'ENTRY_READY';
  const finalSetup = setup ? { ...setup, state: stage === 'ENTRY_READY' && setup.state === 'DISPLACEMENT_CONFIRMED' ? 'ENTRY_READY' : setup.state } : null;
  if (finalSetup && finalSetup.state === 'ENTRY_READY' && setup.state === 'DISPLACEMENT_CONFIRMED') finalSetup.trace = [...setup.trace, { state: advance('DISPLACEMENT_CONFIRMED', 'ENTRY_READY'), index: last, note: 'confluence gates passed' }];

  const dirName = dir > 0 ? 'bullish' : 'bearish';
  const positives = [], negatives = [];
  if (setup && !['INVALIDATED', 'EXPIRED'].includes(setup.state)) {
    positives.push((setup.side === 'sell-side' ? 'Sell-side' : 'Buy-side') + ' liquidity swept at ' + round(setup.sweep.level, 6) + ' (' + setup.sweep.levelType + ')');
    if (setup.reclaimIndex >= 0) positives.push('Price reclaimed the swept level');
    if (setup.displacement) positives.push((setup.direction > 0 ? 'Bullish' : 'Bearish') + ' displacement: body ' + (setup.displacement.bodyRatio * 100).toFixed(0) + '% of range, ' + setup.displacement.bodyAtr + ' ATR');
  }
  if (setup && ['INVALIDATED', 'EXPIRED'].includes(setup.state)) negatives.push('Latest setup ' + setup.state.toLowerCase() + (setup.invalidReason ? ' (' + setup.invalidReason + ')' : ''));
  if (setup && setup.state === 'RECLAIM_PENDING') negatives.push('Sweep not yet reclaimed');
  if (setup && setup.state === 'DISPLACEMENT_PENDING') negatives.push('Awaiting displacement candle');
  if (dir) {
    if (aligned('trend')) positives.push('Trend aligned ' + dirName); else negatives.push('Trend not aligned');
    if (aligned('momentum')) positives.push('Momentum supports ' + dirName + ' move'); else negatives.push('Momentum not confirming');
    if (rv != null && rv >= cfg.volMin) positives.push('Volume ' + round(rv, 2) + 'x recent average'); else negatives.push('Volume confirmation missing');
    if (aligned('structure')) positives.push((lastEv ? lastEv.kind : 'Structure') + ' ' + dirName);
    if (aligned('fvg') && dirGap) positives.push(dirGap.direction + ' FVG active (' + dirGap.fillPct + '% filled)');
    agreeing.forEach((h) => positives.push(h.timeframe + ' trend aligned'));
    opposing.forEach((h) => negatives.push(h.timeframe + ' trend opposes'));
    if (exhausted) negatives.push('Price stretched ' + round(Math.abs(stretch), 1) + ' ATR from EMA20 (exhaustion risk)');
    if (volRegime === 'high') negatives.push('High volatility regime');
    if (statsSetup.reliable) (statsSetup.expectancy >= 0 ? positives : negatives).push('Historical expectancy ' + statsSetup.expectancy + 'R over ' + statsSetup.n + ' outcomes');
    else negatives.push('Historical sample too small (' + statsSetup.n + '/' + statsSetup.minSample + ')');
    blockers.forEach((b) => negatives.push('Blocked: ' + b));
  }

  return {
    status: 'ready', symbol, exchange, timeframe, preset: cfg.id, modelVersion: MODEL_VERSION, modelRevision: model?.version ?? 0,
    asOf: c[0], asOfIso: new Date(c[0]).toISOString(), candleCount: work.length,
    provisional, confirmed: !provisional, forming: split.forming ? split.forming[0] : null,
    signal, direction: dir, signalKind: signal === 'BUY' || signal === 'SELL' ? (setupLive ? 'sweep-reclaim-displacement' : 'confluence') : null,
    score, confidence, confidenceNote: calibration.calibrated ? 'calibrated from ' + calibration.n + ' recorded outcomes' : 'heuristic; not a win probability', calibration,
    strength: round(Math.abs(score), 3), setupQuality: round(setupQuality, 3), confluence: { count: confirmations.length, required: cfg.minConfluence, confirmations, missing },
    directionalAgreement: round(factors.filter((f) => f.value * (dir || 1) > 0).length / factors.length, 2),
    stage, setup: finalSetup, setupId, blockers, factors, htf,
    market: { volRegime, atr: round(atr, 8), atrPct: round((atr / c[4]) * 100, 3), atrTrend: round(atrTrend, 2), regime: st.trend > 0 ? 'uptrend' : st.trend < 0 ? 'downtrend' : 'range', session: sessionOf(c[0]), rsi: round(rsi, 1), macdHistogram: round(macd?.histogram, 6), relVolume: round(rv, 2), emaStack: { e9: round(e9[last], 6), e20: round(e20[last], 6), e50: round(e50[last], 6), e100: e100 ? round(e100[last], 6) : null, e200: e200 ? round(e200[last], 6) : null } },
    structure: { trend: st.trend, events: st.events.slice(-12), swingHighs: sw.highs.slice(-10), swingLows: sw.lows.slice(-10), equalHighs: pools.highs.slice(-4).map((p) => ({ price: round(p.price, 8), count: p.members.length })), equalLows: pools.lows.slice(-4).map((p) => ({ price: round(p.price, 8), count: p.members.length })), dealingPosition: round(dealing, 3) },
    fvg: gaps.filter((g) => last - g.index <= 60).slice(-12), riskPlan,
    expectancy: stats, setupExpectancy: statsSetup, explanation: { positives, negatives },
    thresholds: { displacement: round(thr, 3), minScore: cfg.minScore, minConfidence: cfg.minConfidence },
    method: 'Original multi-factor confluence + sweep/reclaim/displacement classifier on ' + (provisional ? 'a PROVISIONAL forming candle' : 'closed candles') + '. Research signal only: it never authorizes an order.'
  };
}
function agreeingBonus(a, o) { return a.length * 4 - o.length * 8; }

/** Structured evidence for the JPTI Alpha ensemble. Pure mapping; Alpha decides how to weight it. */
export function toAlphaEvidence(r) {
  if (!r || r.status !== 'ready') return { source: 'gainz-alpha', available: false, reason: r?.reason || 'unavailable' };
  const dir = r.signal === 'BUY' ? 1 : r.signal === 'SELL' ? -1 : 0;
  const ex = r.setupExpectancy?.reliable ? r.setupExpectancy : null;
  let weight = 0.1 * (r.confirmed ? 1 : 0.3);
  if (ex) weight *= ex.expectancy > 0.2 ? 1.3 : ex.expectancy < 0 ? 0.5 : 1;
  if (r.signal === 'INVALIDATED') weight = 0;
  return { source: 'gainz-alpha', available: true, version: r.modelVersion, direction: dir, signal: r.signal, stage: r.stage, setupQuality: r.setupQuality, confidence: r.confidence, confluence: r.confluence.count, expectancy: ex ? ex.expectancy : null, sampleSize: r.setupExpectancy?.n ?? 0, falseRate: r.expectancy?.falseRate ?? null, regime: r.market.regime, volRegime: r.market.volRegime, htfAgreement: r.htf.filter((h) => h.status === 'fresh').map((h) => ({ timeframe: h.timeframe, bias: h.bias })), riskReward: r.riskPlan?.rr1 ?? null, invalidation: r.riskPlan?.invalidation ?? null, provisional: r.provisional, suppress: r.signal === 'INVALIDATED' || Boolean(ex && ex.expectancy < 0 && ex.n >= ex.minSample * 2), suggestedWeight: Number(weight.toFixed(3)) };
}
