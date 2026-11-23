// Data-backed price levels computed from candle rows [ts, o, h, l, c, v]. Pure and deterministic.
// Every item carries `source` so a drawn level is traceable to the method and inputs that produced it.
import { clamp, mean, atrSeries, findSwings, utcDayKey, sessionOf, timeframeMs } from '../gainz-alpha/indicators.js';

const r8 = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null);
const src = (method, basis, inputs = {}) => ({ module: 'chart-intelligence/levels', method, basis, inputs });
export const typical = (c) => (c[2] + c[3] + c[4]) / 3;

/** Volume-weighted average price anchored at `anchorIndex`, with volume-weighted standard-deviation bands. */
export function vwap(rows, anchorIndex = 0) {
  let pv = 0, vol = 0, pv2 = 0;
  const series = [];
  for (let i = Math.max(0, anchorIndex); i < rows.length; i++) {
    const p = typical(rows[i]), v = rows[i][5];
    pv += p * v; vol += v; pv2 += p * p * v;
    if (vol > 0) {
      const m = pv / vol, sd = Math.sqrt(Math.max(0, pv2 / vol - m * m));
      series.push({ index: i, ts: rows[i][0], vwap: m, upper1: m + sd, lower1: m - sd, upper2: m + 2 * sd, lower2: m - 2 * sd });
    }
  }
  return series;
}

/** Volume profile: each candle's volume is spread evenly over the price bins its high-low range spans. */
export function volumeProfile(rows, { bins = 48, valueAreaPct = 0.7 } = {}) {
  if (!rows.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const c of rows) { if (c[3] < lo) lo = c[3]; if (c[2] > hi) hi = c[2]; }
  if (!(hi > lo)) return null;
  const size = (hi - lo) / bins, vols = new Array(bins).fill(0);
  for (const c of rows) {
    if (!(c[5] > 0)) continue;
    const a = clamp(Math.floor((c[3] - lo) / size), 0, bins - 1), b = clamp(Math.floor((c[2] - lo) / size), 0, bins - 1);
    const share = c[5] / (b - a + 1);
    for (let k = a; k <= b; k++) vols[k] += share;
  }
  const total = vols.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  let pocIdx = 0;
  for (let k = 1; k < bins; k++) if (vols[k] > vols[pocIdx]) pocIdx = k;
  let L = pocIdx, H = pocIdx, acc = vols[pocIdx];
  while (acc / total < valueAreaPct && (L > 0 || H < bins - 1)) {
    const up = H < bins - 1 ? vols[H + 1] + (H + 2 < bins ? vols[H + 2] : 0) : -1;
    const dn = L > 0 ? vols[L - 1] + (L - 2 >= 0 ? vols[L - 2] : 0) : -1;
    if (up >= dn) { H += 1; acc += vols[H]; } else { L -= 1; acc += vols[L]; }
  }
  const mid = (k) => lo + (k + 0.5) * size;
  return { poc: mid(pocIdx), vah: lo + (H + 1) * size, val: lo + L * size, valueAreaPct: acc / total, binSize: size, totalVolume: total, low: lo, high: hi, bins: vols.map((v, k) => ({ price: mid(k), volume: v })) };
}

/** Session / daily / anchored / developing POC plus VAH/VAL, VWAPs, day & session ranges, and the opening range. */
export function profileLevels(rows, { timeframe, atr, anchors = [] } = {}) {
  const out = [];
  if (rows.length < 10) return out;
  const last = rows[rows.length - 1], dayKey = utcDayKey(last[0]);
  const todayStart = rows.findIndex((c) => utcDayKey(c[0]) === dayKey);
  const prevDay = rows.slice(0, todayStart).filter((c) => utcDayKey(c[0]) === utcDayKey(rows[Math.max(0, todayStart - 1)][0]));
  const today = rows.slice(todayStart);
  const add = (id, kind, price, extra) => { if (Number.isFinite(price)) out.push({ id, layer: 'profile', kind, price: r8(price), ts: extra.ts ?? last[0], ...extra }); };

  const prof = (set, label, method, inputs) => {
    const p = volumeProfile(set);
    if (!p) return;
    const s = src(method, 'ohlcv-distributed', { candles: set.length, from: set[0][0], to: set[set.length - 1][0], ...inputs }), ts = set[0][0];
    add('poc-' + label, label === 'developing' ? 'DEV_POC' : label === 'daily' ? 'PD_POC' : label === 'composite' ? 'POC' : label.toUpperCase() + '_POC', p.poc, { ts, label: label === 'developing' ? 'dPOC' : label === 'daily' ? 'pdPOC' : label === 'composite' ? 'POC' : label + ' POC', strength: 0.8, source: s });
    if (label === 'composite' || label === 'daily') {
      add('vah-' + label, 'VAH', p.vah, { ts, label: label === 'daily' ? 'pdVAH' : 'VAH', strength: 0.6, source: s });
      add('val-' + label, 'VAL', p.val, { ts, label: label === 'daily' ? 'pdVAL' : 'VAL', strength: 0.6, source: s });
    }
    return p;
  };
  prof(rows.slice(-300), 'composite', 'volume-profile-poc', { bins: 48, valueAreaPct: 0.7 });
  if (prevDay.length >= 5) prof(prevDay, 'daily', 'previous-day-profile', {});
  if (today.length >= 5) prof(today, 'developing', 'developing-day-poc', {});
  const sess = sessionOf(last[0]), sessRows = rows.slice(todayStart).filter((c) => sessionOf(c[0]) === sess);
  if (sessRows.length >= 5) prof(sessRows, sess, 'session-profile', { session: sess });
  for (const a of anchors) {
    const idx = rows.findIndex((c) => c[0] === a.ts);
    if (idx >= 0 && rows.length - idx >= 8) prof(rows.slice(idx), 'anchored-' + a.kind, 'anchored-profile', { anchor: a.ts, anchorKind: a.kind });
  }

  if (today.length) {
    const sTs = today[0][0];
    const v = vwap(rows, todayStart), lv = v[v.length - 1];
    if (lv) {
      const s = src('session-vwap', 'ohlcv', { anchor: sTs, candles: today.length });
      add('vwap', 'VWAP', lv.vwap, { ts: sTs, label: 'VWAP', strength: 0.7, source: s, series: v.map((x) => ({ ts: x.ts, v: r8(x.vwap) })) });
      add('vwap-u1', 'VWAP_BAND', lv.upper1, { ts: sTs, label: 'VWAP+1σ', strength: 0.3, source: s });
      add('vwap-l1', 'VWAP_BAND', lv.lower1, { ts: sTs, label: 'VWAP-1σ', strength: 0.3, source: s });
    }
  }
  for (const a of anchors) {
    const idx = rows.findIndex((c) => c[0] === a.ts);
    if (idx < 0 || rows.length - idx < 3) continue;
    const v = vwap(rows, idx), lv = v[v.length - 1];
    if (lv) add('avwap-' + a.kind, 'AVWAP', lv.vwap, { ts: a.ts, label: 'aVWAP ' + a.kind, strength: 0.55, source: src('anchored-vwap', 'ohlcv', { anchor: a.ts, anchorKind: a.kind }), series: v.map((x) => ({ ts: x.ts, v: r8(x.vwap) })) });
  }
  if (prevDay.length) {
    const s = src('previous-day-range', 'ohlcv', { day: utcDayKey(prevDay[0][0]) }), ts = prevDay[0][0];
    add('pdh', 'PDH', Math.max(...prevDay.map((c) => c[2])), { ts, label: 'PDH', strength: 0.75, source: s });
    add('pdl', 'PDL', Math.min(...prevDay.map((c) => c[3])), { ts, label: 'PDL', strength: 0.75, source: s });
  }
  if (today.length >= 2) {
    const s = src('session-range', 'ohlcv', { day: dayKey });
    add('dh', 'DAY_HIGH', Math.max(...today.map((c) => c[2])), { ts: today[0][0], label: 'DH', strength: 0.4, source: s });
    add('dl', 'DAY_LOW', Math.min(...today.map((c) => c[3])), { ts: today[0][0], label: 'DL', strength: 0.4, source: s });
  }
  const tf = timeframeMs(timeframe), orMs = Math.max(30 * 60e3, tf || 0);
  const sessStart = sessRows[0];
  if (sessStart && tf && last[0] + tf >= sessStart[0] + orMs) {
    const win = sessRows.filter((c) => c[0] < sessStart[0] + orMs);
    if (win.length) {
      const s = src('opening-range', 'ohlcv', { session: sess, windowMinutes: orMs / 60e3 });
      add('orh', 'OR_HIGH', Math.max(...win.map((c) => c[2])), { ts: sessStart[0], label: 'OR High', strength: 0.5, source: s });
      add('orl', 'OR_LOW', Math.min(...win.map((c) => c[3])), { ts: sessStart[0], label: 'OR Low', strength: 0.5, source: s });
    }
  }
  return out;
}

/** Support/resistance zones from clustered swing points; strength is measured from touches, reactions and recency. */
export function supportResistance(rows, { atr, lens = [3, 6], maxZones = 8 } = {}) {
  if (rows.length < 30 || !atr) return [];
  const last = rows.length - 1, price = rows[last][4], tol = atr * 0.35, pts = [];
  for (const len of lens) { const s = findSwings(rows, len); [...s.highs.map((p) => ({ ...p, side: 'high', len })), ...s.lows.map((p) => ({ ...p, side: 'low', len }))].forEach((p) => pts.push(p)); }
  pts.sort((a, b) => a.price - b.price);
  const zones = [];
  for (const p of pts) {
    const z = zones.find((q) => Math.abs(q.center - p.price) <= tol);
    if (z) { z.members.push(p); z.center = mean(z.members.map((m) => m.price)); } else zones.push({ center: p.price, members: [p] });
  }
  const out = [];
  for (const z of zones) {
    const uniq = new Map(z.members.map((m) => [m.index, m])), members = [...uniq.values()];
    const top = Math.max(...members.map((m) => m.price)) + atr * 0.05, bottom = Math.min(...members.map((m) => m.price)) - atr * 0.05;
    let touches = 0, held = 0, lastTouch = members[0].index;
    for (let i = Math.min(...members.map((m) => m.index)); i <= last; i++) {
      const c = rows[i], inside = c[3] <= top && c[2] >= bottom;
      const prevInside = i > 0 && rows[i - 1][3] <= top && rows[i - 1][2] >= bottom;
      if (inside && !prevInside) {
        touches++; lastTouch = i;
        const ahead = rows.slice(i + 1, i + 6);
        if (ahead.length === 5) {
          const rise = Math.max(...ahead.map((x) => x[2])) - (z.center), fall = z.center - Math.min(...ahead.map((x) => x[3]));
          const above = rows[i - 1] ? rows[i - 1][4] > z.center : true;
          if ((above && rise >= atr * 0.5) || (!above && fall >= atr * 0.5)) held++;
        }
      }
    }
    if (touches < 2) continue;
    const age = last - lastTouch, recency = Math.exp(-age / 120), holdRate = touches > 1 ? held / touches : 0;
    const strength = clamp(0.35 * Math.min(touches, 6) / 6 + 0.35 * holdRate + 0.2 * recency + 0.1 * Math.min(members.length, 6) / 6, 0, 1);
    const kind = price >= top ? 'support' : price <= bottom ? 'resistance' : 'zone';
    out.push({ id: 'sr|' + r8(z.center), layer: 'sr', kind: kind.toUpperCase(), role: kind, price: r8(z.center), top: r8(top), bottom: r8(bottom), ts: rows[Math.min(...members.map((m) => m.index))][0], label: (strength >= 0.66 ? 'S3 ' : strength >= 0.4 ? 'S2 ' : 'S1 ') + (kind === 'support' ? 'Support' : kind === 'resistance' ? 'Resistance' : 'Zone'), strength: r8(strength), touches, holdRate: r8(holdRate), source: src('swing-cluster-zones', 'ohlcv', { swingLens: lens, tolAtr: 0.35, members: members.length, touches, held }) });
  }
  return out.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price)).slice(0, maxZones);
}
export { atrSeries };

/** Empirical reaction rate of a price level: how often a touch was followed by a >= reactAtr move away within `horizon` bars. */
export function reactionStats(rows, price, atr, { fromIndex = 0, touchTol = 0.15, reactAtr = 0.5, horizon = 5 } = {}) {
  let touches = 0, reactions = 0, prevIn = false;
  for (let i = Math.max(1, fromIndex); i < rows.length - horizon; i++) {
    const c = rows[i], inside = c[3] <= price + atr * touchTol && c[2] >= price - atr * touchTol;
    if (inside && !prevIn) {
      touches++;
      const approachedFromAbove = rows[i - 1][4] >= price, ahead = rows.slice(i + 1, i + 1 + horizon);
      const away = approachedFromAbove ? Math.max(...ahead.map((x) => x[2])) - price : price - Math.min(...ahead.map((x) => x[3]));
      if (away >= atr * reactAtr) reactions++;
    }
    prevIn = inside;
  }
  return { touches, reactions, rate: touches ? reactions / touches : null };
}
