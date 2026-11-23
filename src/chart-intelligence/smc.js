// Smart-money-concept analytics built on the shared swing/structure primitives. Closed candles only: an item is
// created at the bar that confirms it and never moves afterwards (no repainting). Definitions are in docs/CHART_INTELLIGENCE.md.
import { clamp, atrSeries, findSwings, equalLevels, structureEvents, fairValueGaps } from '../gainz-alpha/indicators.js';

const r8 = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null);
const src = (method, inputs = {}) => ({ module: 'chart-intelligence/smc', method, basis: 'ohlcv', inputs });

export function analyzeSmc(rows, { swingLen = 3, majorLen = 6, maxAgeBars = 220 } = {}) {
  const out = { status: 'insufficient', items: [], liquidity: { pools: [], magnets: [], sweeps: [] }, dealingRange: null, trend: 0 };
  if (rows.length < 40) return out;
  const atrS = atrSeries(rows, 14), atr = atrS[rows.length - 1];
  if (!atr) return out;
  const last = rows.length - 1, start = Math.max(0, last - maxAgeBars);
  const sw = findSwings(rows, swingLen), major = findSwings(rows, majorLen), st = structureEvents(rows, sw);
  const items = [], seenIds = new Set(), add = (it) => { if (seenIds.has(it.id)) return; seenIds.add(it.id); items.push(it); };

  // --- Structure: BOS / CHoCH, and MSS = CHoCH closed with displacement (body >= 1 ATR) ---------------------
  for (const e of st.events) {
    if (e.index < start) continue;
    const c = rows[e.index], disp = Math.abs(c[4] - c[1]) >= (atrS[e.index] || atr);
    const kind = e.kind === 'CHoCH' && disp ? 'MSS' : e.kind;
    add({ id: [kind, e.ts, e.direction].join('|'), layer: 'structure', kind, direction: e.direction, ts: e.ts, price: r8(e.level), label: kind, strength: kind === 'MSS' ? 0.9 : kind === 'CHoCH' ? 0.7 : 0.5, source: src('swing-break-close', { swingLen, displacement: disp }) });
  }

  // --- Order blocks: last opposite candle before the impulse that broke structure ------------------------
  const blocks = [];
  for (const e of st.events) {
    if (e.index < start) continue;
    const bull = e.direction === 'bullish', pool = bull ? sw.lows : sw.highs;
    const origin = [...pool].reverse().find((p) => p.confirmedAt <= e.index && p.index < e.index);
    const from = origin ? origin.index : Math.max(0, e.index - 12);
    let ob = -1;
    for (let i = e.index - 1; i >= from; i--) { if (bull ? rows[i][4] < rows[i][1] : rows[i][4] > rows[i][1]) { ob = i; break; } }
    if (ob < 0) continue;
    blocks.push({ index: ob, direction: e.direction, top: rows[ob][2], bottom: rows[ob][3], formedAt: e.index, kind: e.kind });
  }
  for (const b of blocks) {
    let status = 'active', touchedAt = null, brokeAt = null;
    for (let j = b.formedAt + 1; j <= last; j++) {
      const c = rows[j];
      if (b.direction === 'bullish') { if (c[4] < b.bottom) { status = 'breaker'; brokeAt = j; break; } if (c[3] <= b.top && touchedAt == null) { touchedAt = j; status = 'mitigated'; } }
      else { if (c[4] > b.top) { status = 'breaker'; brokeAt = j; break; } if (c[2] >= b.bottom && touchedAt == null) { touchedAt = j; status = 'mitigated'; } }
    }
    const dir = status === 'breaker' ? (b.direction === 'bullish' ? 'bearish' : 'bullish') : b.direction;
    const kind = status === 'breaker' ? 'BREAKER' : status === 'mitigated' ? 'MITIGATION_BLOCK' : 'ORDER_BLOCK';
    add({ id: [kind, rows[b.index][0], b.direction].join('|'), layer: 'orderBlocks', kind, direction: dir, ts: rows[b.index][0], endTs: brokeAt != null ? rows[brokeAt][0] : null, top: r8(b.top), bottom: r8(b.bottom), price: r8((b.top + b.bottom) / 2), label: kind === 'BREAKER' ? 'Breaker' : kind === 'MITIGATION_BLOCK' ? 'Mitigation' : 'OB', status, strength: status === 'active' ? 0.75 : status === 'mitigated' ? 0.5 : 0.6, source: src('last-opposite-candle-before-structure-break', { origin: b.kind, formedAt: rows[b.formedAt][0] }) });
  }

  // --- FVG / IFVG ---------------------------------------------------------------------------------------
  const gaps = fairValueGaps(rows, atr * 0.1);
  for (const g of gaps) {
    if (g.index < start) continue;
    let inverted = false, invIdx = -1;
    for (let j = g.index + 1; j <= last; j++) { if (g.direction === 'bullish' ? rows[j][4] < g.bottom : rows[j][4] > g.top) { inverted = true; invIdx = j; break; } }
    if (g.status === 'filled' && !inverted) continue;
    const dir = inverted ? (g.direction === 'bullish' ? 'bearish' : 'bullish') : g.direction;
    add({ id: [inverted ? 'IFVG' : 'FVG', g.ts, g.direction].join('|'), layer: 'fvg', kind: inverted ? 'IFVG' : 'FVG', direction: dir, ts: g.ts, endTs: inverted ? rows[invIdx][0] : null, top: r8(g.top), bottom: r8(g.bottom), price: r8((g.top + g.bottom) / 2), label: inverted ? 'IFVG' : 'FVG', status: inverted ? 'inverted' : g.status, fillPct: g.fillPct, strength: inverted ? 0.55 : clamp(0.7 - g.fillPct / 200, 0.3, 0.7), source: src(inverted ? 'fvg-closed-through' : 'three-candle-imbalance', { minGapAtr: 0.1 }) });
  }

  // --- Liquidity: pools, sweeps, magnets ------------------------------------------------------------------
  // Pools are always built from swings CONFIRMED strictly before the bar being judged, so a sweep found at bar j can
  // never change when later bars arrive.
  const majorIdx = new Set([...major.highs, ...major.lows].map((p) => p.index));
  const poolsAt = (j) => {
    const a = atrS[Math.min(j, last)] || atr, tolEq = a * 0.15, pools = [];
    const known = (arr) => arr.filter((p) => p.index >= start && p.confirmedAt < j);
    const add = (kind, side, price, fromIdx, count, method) => pools.push({ kind, side, price, fromIdx, count, method });
    equalLevels(known(sw.highs), tolEq).forEach((p) => add('EQH', 'high', p.price, p.lastIndex, p.members.length, 'equal-highs-within-0.15-atr'));
    equalLevels(known(sw.lows), tolEq).forEach((p) => add('EQL', 'low', p.price, p.lastIndex, p.members.length, 'equal-lows-within-0.15-atr'));
    known(major.highs).forEach((p) => add('EXTERNAL', 'high', p.price, p.index, 1, 'major-swing-high-len-' + majorLen));
    known(major.lows).forEach((p) => add('EXTERNAL', 'low', p.price, p.index, 1, 'major-swing-low-len-' + majorLen));
    known(sw.highs).filter((p) => !majorIdx.has(p.index) && j - p.index <= 60).forEach((p) => add('INTERNAL', 'high', p.price, p.index, 1, 'minor-swing-high-len-' + swingLen));
    known(sw.lows).filter((p) => !majorIdx.has(p.index) && j - p.index <= 60).forEach((p) => add('INTERNAL', 'low', p.price, p.index, 1, 'minor-swing-low-len-' + swingLen));
    return pools;
  };
  const consumedBefore = (p, j) => { for (let k = p.fromIdx + 1; k < j; k++) if (p.side === 'high' ? rows[k][2] > p.price : rows[k][3] < p.price) return true; return false; };
  const rank = (p) => (p.kind === 'EQH' || p.kind === 'EQL' ? 3 : p.kind === 'EXTERNAL' ? 2 : 1);
  const sweeps = [];
  for (let j = Math.max(start + 8, 1); j <= last; j++) {
    const c = rows[j], hits = poolsAt(j).filter((p) => (p.side === 'high' ? c[2] > p.price && c[4] < p.price : c[3] < p.price && c[4] > p.price) && !consumedBefore(p, j));
    for (const side of ['high', 'low']) {
      const best = hits.filter((p) => p.side === side).sort((x, y) => rank(y) - rank(x) || (side === 'high' ? y.price - x.price : x.price - y.price))[0];
      if (!best) continue;
      sweeps.push({ ...best, index: j, sweptAt: c[0] });
      add({ id: ['SWEEP', c[0], side].join('|'), layer: 'sweeps', kind: 'LIQUIDITY_SWEEP', direction: side === 'high' ? 'bearish' : 'bullish', ts: c[0], price: r8(best.price), label: (side === 'high' ? 'BSL' : 'SSL') + ' sweep', strength: rank(best) >= 2 ? 0.8 : 0.55, source: src('wick-beyond-pool-close-back', { pool: best.kind, method: best.method, touches: best.count }) });
    }
  }
  // Unswept liquidity right now (display): nearest pools on each side, capped.
  const price = rows[last][4], live = poolsAt(last + 1).filter((p) => !consumedBefore(p, last + 1));
  const byDist = (side) => live.filter((p) => p.side === side).sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price)).slice(0, 5);
  const pools = [...byDist('high'), ...byDist('low')].map((p) => ({ ...p, swept: false }));
  for (const p of pools) add({ id: ['LIQ', p.kind, p.side, r8(p.price)].join('|'), layer: 'liquidity', kind: p.kind === 'EQH' ? 'EQUAL_HIGHS' : p.kind === 'EQL' ? 'EQUAL_LOWS' : p.kind + '_LIQUIDITY', direction: p.side === 'high' ? 'buy-side' : 'sell-side', ts: rows[p.fromIdx][0], price: r8(p.price), label: (p.side === 'high' ? 'BSL ' : 'SSL ') + (p.kind === 'EQH' || p.kind === 'EQL' ? p.kind : p.kind.toLowerCase()), strength: clamp(0.35 + 0.15 * Math.min(p.count, 4) + (p.kind === 'EXTERNAL' ? 0.15 : 0), 0, 1), count: p.count, source: src(p.method, { touches: p.count }) });
  // Liquidity magnets: nearest unswept pools weighted by size and proximity.
  const magnets = pools.map((p) => { const dist = Math.abs(p.price - price) / atr; const w = (p.kind === 'EXTERNAL' ? 1.2 : 1) * (1 + 0.4 * (p.count - 1)) / (1 + dist); return { price: r8(p.price), side: p.side === 'high' ? 'above' : 'below', kind: p.kind, distanceAtr: r8(dist), pull: r8(w) }; }).sort((a, b) => b.pull - a.pull).slice(0, 4);
  magnets.forEach((m, i) => add({ id: ['MAGNET', m.side, m.price].join('|'), layer: 'liquidity', kind: 'LIQUIDITY_MAGNET', direction: m.side === 'above' ? 'buy-side' : 'sell-side', ts: rows[last][0], price: m.price, label: 'Magnet #' + (i + 1), strength: clamp(m.pull / 2, 0.2, 1), source: src('proximity-weighted-unswept-pools', { distanceAtr: m.distanceAtr, pull: m.pull }) }));

  // --- Inducement: a minor swing swept by a wick that closed back, then a structure break within 8 bars -----
  const minor = findSwings(rows, 1);
  for (const e of st.events.filter((x) => x.index >= start)) {
    const bull = e.direction === 'bullish', pool = (bull ? minor.lows : minor.highs).filter((p) => p.index < e.index && e.index - p.index <= 14);
    for (const p of pool) {
      const j = rows.findIndex((c, k) => k > p.index && k < e.index && (bull ? c[3] < p.price : c[2] > p.price));
      if (j > 0 && (bull ? rows[j][4] > p.price : rows[j][4] < p.price) && e.index - j <= 8) { add({ id: ['INDUCEMENT', rows[j][0], e.direction].join('|'), layer: 'smc', kind: 'INDUCEMENT', direction: e.direction, ts: rows[j][0], price: r8(p.price), label: 'IDM', strength: 0.5, source: src('minor-swing-swept-before-structure-break', { breakKind: e.kind, breakAt: e.ts }) }); break; }
    }
  }

  // --- Premium / discount from the current dealing range (last confirmed major swing high & low) -----------
  const mh = major.highs[major.highs.length - 1], ml = major.lows[major.lows.length - 1];
  if (mh && ml && mh.price > ml.price) {
    const eq = (mh.price + ml.price) / 2, pos = (price - ml.price) / (mh.price - ml.price);
    out.dealingRange = { high: r8(mh.price), low: r8(ml.price), equilibrium: r8(eq), position: r8(pos), zone: pos > 0.55 ? 'premium' : pos < 0.45 ? 'discount' : 'equilibrium' };
    const since = Math.min(mh.index, ml.index);
    add({ id: 'PD|premium', layer: 'smc', kind: 'PREMIUM', direction: 'bearish', ts: rows[since][0], top: r8(mh.price), bottom: r8(eq), price: r8((mh.price + eq) / 2), label: 'Premium', strength: 0.3, source: src('dealing-range-upper-half', { high: mh.ts, low: ml.ts }) });
    add({ id: 'PD|discount', layer: 'smc', kind: 'DISCOUNT', direction: 'bullish', ts: rows[since][0], top: r8(eq), bottom: r8(ml.price), price: r8((eq + ml.price) / 2), label: 'Discount', strength: 0.3, source: src('dealing-range-lower-half', { high: mh.ts, low: ml.ts }) });
    add({ id: 'PD|eq', layer: 'smc', kind: 'EQUILIBRIUM', direction: 'neutral', ts: rows[since][0], price: r8(eq), label: 'EQ', strength: 0.3, source: src('dealing-range-midpoint', { high: mh.ts, low: ml.ts }) });
  }
  out.items = items; out.status = 'ready'; out.trend = st.trend; out.atr = atr;
  out.liquidity = { pools: pools.map((p) => ({ ...p, price: r8(p.price) })), magnets, sweeps: sweeps.map((s) => ({ side: s.side, price: r8(s.price), at: s.sweptAt, kind: s.kind })) };
  return out;
}
