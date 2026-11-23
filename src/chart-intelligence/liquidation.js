// MODELLED liquidation map. No exchange liquidation feed is available in the candle pipeline, so levels are derived from
// isolated-margin liquidation maths applied to likely position entries (swing extremes and high-volume bars), and removed
// once price has traded through them (those positions would already have been liquidated). Always labelled `estimated-model`.
// A measured feed ([{price, side, size}]) can be supplied and takes precedence.
import { clamp, atrSeries, findSwings, relativeVolume } from '../gainz-alpha/indicators.js';

const r8 = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null);
export const DEFAULT_TIERS = [5, 10, 25, 50, 100];
export const DEFAULT_TIER_WEIGHT = { 5: 0.15, 10: 0.3, 25: 0.3, 50: 0.15, 100: 0.1 };

/** Isolated-margin liquidation price. Long: P(1 - 1/L + mmr). Short: P(1 + 1/L - mmr). */
export const liquidationPrice = (entry, leverage, side, mmr = 0.005) => (side === 'long' ? entry * (1 - 1 / leverage + mmr) : entry * (1 + 1 / leverage - mmr));

export function analyzeLiquidation(rows, { feed = null, tiers = DEFAULT_TIERS, mmr = 0.005, lookback = 300 } = {}) {
  const none = { status: 'insufficient', basis: null, items: [], clusters: [], heatmap: [], cascade: null };
  if (rows.length < 40) return none;
  const atrS = atrSeries(rows, 14), atr = atrS[rows.length - 1];
  if (!atr) return none;
  const last = rows.length - 1, price = rows[last][4], from = Math.max(0, rows.length - lookback);
  const raw = [];
  if (Array.isArray(feed) && feed.length) {
    feed.filter((f) => Number.isFinite(f.price) && f.size > 0).forEach((f) => raw.push({ price: f.price, side: f.side, weight: f.size, anchorTs: null, leverage: null }));
  } else {
    const sw = findSwings(rows.slice(from), 3);
    const anchors = [];
    sw.lows.forEach((p) => anchors.push({ i: p.index + from, side: 'long', entry: p.price }));
    sw.highs.forEach((p) => anchors.push({ i: p.index + from, side: 'short', entry: p.price }));
    for (let i = from + 20; i <= last; i++) { const rv = relativeVolume(rows.slice(0, i + 1)); if (rv != null && rv >= 2) anchors.push({ i, side: rows[i][4] >= rows[i][1] ? 'long' : 'short', entry: rows[i][4] }); }
    for (const a of anchors) {
      const recency = Math.exp(-(last - a.i) / 150), rv = relativeVolume(rows.slice(0, a.i + 1)) || 1, base = clamp(rv, 0.5, 3) * recency;
      for (const L of tiers) {
        const lp = liquidationPrice(a.entry, L, a.side, mmr);
        let alive = true;
        for (let j = a.i + 1; j <= last; j++) { if (a.side === 'long' ? rows[j][3] <= lp : rows[j][2] >= lp) { alive = false; break; } }
        if (alive && (a.side === 'long' ? lp < price : lp > price)) raw.push({ price: lp, side: a.side, weight: base * (DEFAULT_TIER_WEIGHT[L] ?? 0.1), anchorTs: rows[a.i][0], leverage: L });
      }
    }
  }
  if (!raw.length) return { ...none, status: 'ready', basis: feed ? 'measured-feed' : 'estimated-model', items: [] };
  const basis = Array.isArray(feed) && feed.length ? 'measured-feed' : 'estimated-model';
  const tol = atr * 0.3, clusters = [];
  for (const side of ['long', 'short']) {
    const pts = raw.filter((x) => x.side === side).sort((a, b) => a.price - b.price);
    let cur = null;
    for (const p of pts) { if (cur && p.price - cur.hi <= tol) { cur.hi = p.price; cur.n++; cur.w += p.weight; cur.pw += p.price * p.weight; } else { if (cur) clusters.push(cur); cur = { side, lo: p.price, hi: p.price, n: 1, w: p.weight, pw: p.price * p.weight }; } }
    if (cur) clusters.push(cur);
  }
  const maxW = Math.max(...clusters.map((c) => c.w)) || 1;
  const out = clusters.map((c) => ({ side: c.side, price: r8(c.pw / c.w), low: r8(c.lo), high: r8(c.hi), weight: r8(c.w), density: r8(c.w / maxW), members: c.n, distanceAtr: r8(Math.abs(c.pw / c.w - price) / atr) })).filter((c) => c.density >= 0.25).sort((a, b) => b.density - a.density).slice(0, 8);
  const items = out.map((c, i) => ({ id: ['LIQN', c.side, c.price].join('|'), layer: 'liquidation', kind: c.side === 'long' ? 'LONG_LIQUIDATION' : 'SHORT_LIQUIDATION', direction: c.side === 'long' ? 'bearish' : 'bullish', ts: rows[Math.max(0, rows.length - 40)][0], top: c.high, bottom: c.low, price: c.price, label: (c.side === 'long' ? 'Long liq ' : 'Short liq ') + (basis === 'estimated-model' ? '(est.)' : ''), strength: c.density, density: c.density, source: { module: 'chart-intelligence/liquidation', method: basis === 'measured-feed' ? 'exchange-liquidation-feed' : 'isolated-margin-model', basis, inputs: { leverageTiers: tiers, maintenanceMarginRate: mmr, members: c.members, rank: i + 1 } } }));
  // Heatmap: weight binned over the visible price range.
  const lo = Math.min(...rows.slice(-120).map((c) => c[3])) - atr * 2, hi = Math.max(...rows.slice(-120).map((c) => c[2])) + atr * 2, bins = 40, size = (hi - lo) / bins, h = new Array(bins).fill(0);
  raw.forEach((p) => { const k = Math.floor((p.price - lo) / size); if (k >= 0 && k < bins) h[k] += p.weight; });
  const hm = Math.max(...h) || 1;
  const heatmap = h.map((w, k) => ({ price: r8(lo + (k + 0.5) * size), low: r8(lo + k * size), high: r8(lo + (k + 1) * size), intensity: r8(w / hm) })).filter((b) => b.intensity > 0.05);
  const near = out.filter((c) => c.distanceAtr <= 2.5), nearLong = near.filter((c) => c.side === 'long'), nearShort = near.filter((c) => c.side === 'short');
  const dom = (arr) => arr.reduce((s, c) => s + c.density, 0);
  const cascadeScore = clamp(Math.max(dom(nearLong), dom(nearShort)) / 1.5, 0, 1);
  const cascade = { score: r8(cascadeScore), level: cascadeScore >= 0.66 ? 'elevated' : cascadeScore >= 0.33 ? 'moderate' : 'low', exposedSide: dom(nearLong) >= dom(nearShort) ? 'long' : 'short', clustersWithin2_5Atr: near.length, basis };
  return { status: 'ready', basis, items, clusters: out, heatmap, cascade };
}
