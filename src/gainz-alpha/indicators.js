// Pure, deterministic indicator and market-structure primitives for the GainzAlpha core.
// Candle row format everywhere: [timestamp(ms), open, high, low, close, volume].

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

const TF_UNITS = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3, M: 2592000e3 };
export function timeframeMs(tf) {
  const m = /^(\d+)([mhdwM])$/.exec(String(tf || ''));
  return m ? Number(m[1]) * TF_UNITS[m[2]] : null;
}

export function normalizeCandles(input) {
  const rows = (Array.isArray(input) ? input : [])
    .map((c) => (Array.isArray(c) ? c.slice(0, 6) : [c?.timestamp, c?.open, c?.high, c?.low, c?.close, c?.volume]))
    .filter((c) => c.length === 6 && c.every((v) => v !== null && v !== '' && Number.isFinite(Number(v))))
    .map((c) => c.map(Number))
    .filter((c) => c[0] > 0 && c[1] > 0 && c[2] >= Math.max(c[1], c[3], c[4]) && c[3] <= Math.min(c[1], c[2], c[4]) && c[3] > 0 && c[5] >= 0)
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rows) { if (out.length && out[out.length - 1][0] === r[0]) out[out.length - 1] = r; else out.push(r); }
  return out;
}

/** Splits candles into exchange-closed bars and the still-forming bar. */
export function splitClosed(rows, timeframe, now) {
  const tf = timeframeMs(timeframe);
  if (!tf) return { closed: rows.slice(0, -1), forming: rows.length ? rows[rows.length - 1] : null, tfKnown: false };
  const closed = rows.filter((c) => c[0] + tf <= now);
  const forming = rows.find((c) => c[0] + tf > now && c[0] <= now) || null;
  return { closed, forming, tfKnown: true };
}

export function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let prev = values[0];
  return values.map((v, i) => (prev = i ? v * k + prev * (1 - k) : v));
}

export function rsiValue(values, period = 14) {
  if (values.length <= period) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  let ag = g / period, al = l / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** Wilder ATR series aligned with rows (index 0 is null). */
export function atrSeries(rows, period = 14) {
  const out = new Array(rows.length).fill(null);
  if (rows.length <= period) return out;
  const tr = (i) => Math.max(rows[i][2] - rows[i][3], Math.abs(rows[i][2] - rows[i - 1][4]), Math.abs(rows[i][3] - rows[i - 1][4]));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr(i);
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < rows.length; i++) { a = (a * (period - 1) + tr(i)) / period; out[i] = a; }
  return out;
}

export function macdValue(values) {
  if (values.length < 35) return null;
  const f = emaSeries(values, 12), s = emaSeries(values, 26);
  const line = f.map((v, i) => v - s[i]);
  const sig = emaSeries(line, 9);
  const n = line.length - 1;
  return { line: line[n], signal: sig[n], histogram: line[n] - sig[n], prevHistogram: line[n - 1] - sig[n - 1] };
}

export function relativeVolume(rows, lookback = 20) {
  if (rows.length < lookback + 1) return null;
  const base = mean(rows.slice(-lookback - 1, -1).map((c) => c[5]));
  return base > 0 ? rows[rows.length - 1][5] / base : null;
}

/** Confirmed pivots only: a pivot at i is known once `len` later bars exist (no lookahead). */
export function findSwings(rows, len = 3) {
  const highs = [], lows = [];
  for (let i = len; i < rows.length - len; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= len; j++) {
      if (rows[i][2] <= rows[i - j][2] || rows[i][2] <= rows[i + j][2]) isH = false;
      if (rows[i][3] >= rows[i - j][3] || rows[i][3] >= rows[i + j][3]) isL = false;
    }
    if (isH) highs.push({ index: i, price: rows[i][2], ts: rows[i][0], confirmedAt: i + len });
    if (isL) lows.push({ index: i, price: rows[i][3], ts: rows[i][0], confirmedAt: i + len });
  }
  return { highs, lows };
}

/** Clusters of swing points within `tol` of one another (equal highs / equal lows = liquidity pools). */
export function equalLevels(points, tol) {
  const pools = [];
  for (const p of points) {
    const pool = pools.find((q) => Math.abs(q.price - p.price) <= tol);
    if (pool) { pool.members.push(p); pool.price = mean(pool.members.map((m) => m.price)); pool.lastIndex = Math.max(pool.lastIndex, p.index); pool.confirmedAt = Math.max(pool.confirmedAt, p.confirmedAt); }
    else pools.push({ price: p.price, members: [p], lastIndex: p.index, confirmedAt: p.confirmedAt });
  }
  return pools.filter((q) => q.members.length >= 2);
}

/** Structure events (BOS / CHoCH) derived from confirmed swings, scanning closes. */
export function structureEvents(rows, swings) {
  const events = [];
  let trend = 0;
  const hs = swings.highs, ls = swings.lows;
  const used = new Set();
  for (let i = 1; i < rows.length; i++) {
    const lastH = [...hs].reverse().find((s) => s.confirmedAt <= i && !used.has('h' + s.index));
    const lastL = [...ls].reverse().find((s) => s.confirmedAt <= i && !used.has('l' + s.index));
    if (lastH && rows[i][4] > lastH.price && rows[i - 1][4] <= lastH.price) {
      events.push({ kind: trend < 0 ? 'CHoCH' : 'BOS', direction: 'bullish', index: i, level: lastH.price, ts: rows[i][0] });
      used.add('h' + lastH.index); trend = 1;
    } else if (lastL && rows[i][4] < lastL.price && rows[i - 1][4] >= lastL.price) {
      events.push({ kind: trend > 0 ? 'CHoCH' : 'BOS', direction: 'bearish', index: i, level: lastL.price, ts: rows[i][0] });
      used.add('l' + lastL.index); trend = -1;
    }
  }
  return { events, trend };
}

/** Fair value gaps with mitigation and fill percentage, computed on closed candles only. */
export function fairValueGaps(rows, minSize = 0) {
  const gaps = [];
  for (let i = 2; i < rows.length; i++) {
    const a = rows[i - 2], c = rows[i];
    if (c[3] - a[2] > minSize) gaps.push({ direction: 'bullish', bottom: a[2], top: c[3], index: i, ts: rows[i][0] });
    if (a[3] - c[2] > minSize) gaps.push({ direction: 'bearish', bottom: c[2], top: a[3], index: i, ts: rows[i][0] });
  }
  for (const g of gaps) {
    let fill = 0;
    for (let j = g.index + 1; j < rows.length; j++) {
      const depth = g.direction === 'bullish' ? g.top - rows[j][3] : rows[j][2] - g.bottom;
      fill = Math.max(fill, clamp(depth / (g.top - g.bottom), 0, 1));
    }
    g.fillPct = Number((fill * 100).toFixed(1));
    g.status = fill >= 1 ? 'filled' : fill > 0 ? 'mitigated' : 'active';
  }
  return gaps;
}

export function utcDayKey(ts) { return new Date(ts).toISOString().slice(0, 10); }
export function sessionOf(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 13 && h < 16) return 'london-new-york';
  if (h >= 7 && h < 13) return 'london';
  if (h >= 16 && h < 21) return 'new-york';
  if (h >= 0 && h < 7) return 'asia';
  return 'off-hours';
}
