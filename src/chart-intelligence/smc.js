// Smart-money-concept analytics built on the shared swing/structure primitives. Closed candles only: an item is
// created at the bar that confirms it and never moves afterwards (no repainting). Definitions are in docs/CHART_INTELLIGENCE.md.
import { clamp, atrSeries, findSwings, equalLevels, structureEvents, fairValueGaps, relativeVolume } from '../gainz-alpha/indicators.js';

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
    const impulse = rows[e.index], impulseAtr = (atrS[e.index] || atr), impulseBodyAtr = Math.abs(impulse[4] - impulse[1]) / impulseAtr, impulseVolume = relativeVolume(rows.slice(0, e.index + 1));
    blocks.push({ index: ob, direction: e.direction, top: rows[ob][2], bottom: rows[ob][3], formedAt: e.index, kind: e.kind, impulseBodyAtr, impulseVolume });
  }
  for (const b of blocks) {
    let status = 'active', touchedAt = null, brokeAt = null, mitigationTouches = 0, deepestMitigation = 0;
    for (let j = b.formedAt + 1; j <= last; j++) {
      const c = rows[j];
      const touched = b.direction === 'bullish' ? c[3] <= b.top && c[2] >= b.bottom : c[2] >= b.bottom && c[3] <= b.top;
      if (touched) { mitigationTouches++; const depth = b.direction === 'bullish' ? clamp((b.top - c[3]) / Math.max(1e-12, b.top - b.bottom), 0, 1) : clamp((c[2] - b.bottom) / Math.max(1e-12, b.top - b.bottom), 0, 1); deepestMitigation = Math.max(deepestMitigation, depth); if (touchedAt == null) touchedAt = j; }
      if (b.direction === 'bullish') { if (c[4] < b.bottom) { status = 'breaker'; brokeAt = j; break; } if (touchedAt != null) status = 'mitigated'; }
      else { if (c[4] > b.top) { status = 'breaker'; brokeAt = j; break; } if (touchedAt != null) status = 'mitigated'; }
    }
    const dir = status === 'breaker' ? (b.direction === 'bullish' ? 'bearish' : 'bullish') : b.direction;
    const kind = status === 'breaker' ? 'BREAKER' : status === 'mitigated' ? 'MITIGATION_BLOCK' : 'ORDER_BLOCK';
    const impulseQuality = clamp((b.impulseBodyAtr / 2) * 0.55 + (b.impulseVolume == null ? 0.1 : clamp((b.impulseVolume - 0.8) / 2, 0, 1) * 0.3) + (b.kind === 'CHoCH' ? 0.15 : 0.1), 0, 1);
    const mitigationPenalty = Math.min(0.35, mitigationTouches * 0.08 + deepestMitigation * 0.12);
    const blockQuality = clamp(impulseQuality - mitigationPenalty + (status === 'active' ? 0.12 : 0), 0.15, 1);
    add({ id: [kind, rows[b.index][0], b.direction].join('|'), layer: 'orderBlocks', kind, direction: dir, ts: rows[b.index][0], endTs: brokeAt != null ? rows[brokeAt][0] : null, top: r8(b.top), bottom: r8(b.bottom), price: r8((b.top + b.bottom) / 2), label: kind === 'BREAKER' ? 'Breaker' : kind === 'MITIGATION_BLOCK' ? 'Mitigation' : 'OB', status, strength: r8(blockQuality), quality: r8(blockQuality), mitigationTouches, deepestMitigation: r8(deepestMitigation), impulseBodyAtr: r8(b.impulseBodyAtr), relativeVolume: r8(b.impulseVolume), source: src('last-opposite-candle-before-structure-break-quality-scored', { origin: b.kind, formedAt: rows[b.formedAt][0], impulseBodyAtr: r8(b.impulseBodyAtr), relativeVolume: r8(b.impulseVolume), mitigationTouches, deepestMitigation: r8(deepestMitigation) }) });
  }

  // --- FVG / IFVG ---------------------------------------------------------------------------------------
  const gaps = fairValueGaps(rows, atr * 0.1);
  for (const g of gaps) {
    if (g.index < start) continue;
    let inverted = false, invIdx = -1;
    for (let j = g.index + 1; j <= last; j++) { if (g.direction === 'bullish' ? rows[j][4] < g.bottom : rows[j][4] > g.top) { inverted = true; invIdx = j; break; } }
    // Preserve the immutable FVG formation and record a separate IFVG event if a later close invalidates it.
    add({ id: ['FVG', g.ts, g.direction].join('|'), layer: 'fvg', kind: 'FVG', direction: g.direction, ts: g.ts, top: r8(g.top), bottom: r8(g.bottom), price: r8((g.top + g.bottom) / 2), label: 'FVG', status: g.status, fillPct: g.fillPct, strength: clamp(0.7 - g.fillPct / 200, 0.3, 0.7), source: src('three-candle-imbalance', { minGapAtr: 0.1, fillPct: g.fillPct }) });
    if (inverted) add({ id: ['IFVG', rows[invIdx][0], g.direction].join('|'), layer: 'fvg', kind: 'IFVG', direction: g.direction === 'bullish' ? 'bearish' : 'bullish', ts: rows[invIdx][0], top: r8(g.top), bottom: r8(g.bottom), price: r8((g.top + g.bottom) / 2), label: 'IFVG', status: 'active', fillPct: g.fillPct, strength: 0.55, source: src('fvg-closed-through', { originalFvg: g.ts, inversionAt: rows[invIdx][0] }) });
  }

  // --- Displacement: closed-candle impulse with range/body and relative-volume evidence -------------------
  const displacement = [];
  for (let i = Math.max(start + 1, 21); i <= last; i++) {
    const c = rows[i], a = atrS[i] || atr, range = c[2] - c[3], body = Math.abs(c[4] - c[1]);
    if (!(range > 0) || body < a * 1.2) continue;
    const closeLocation = (c[4] - c[3]) / range, rv = relativeVolume(rows.slice(0, i + 1));
    if (rv != null && rv < 1.35) continue;
    const bullish = c[4] > c[1] && closeLocation >= 0.8;
    const bearish = c[4] < c[1] && closeLocation <= 0.2;
    if (!bullish && !bearish) continue;
    displacement.push({ index: i, direction: bullish ? 'bullish' : 'bearish', bodyAtr: body / a, relVolume: rv });
  }
  displacement.slice(-12).forEach((d) => add({
    id: ['DISPLACEMENT', rows[d.index][0], d.direction].join('|'),
    layer: 'smc', kind: 'DISPLACEMENT', direction: d.direction, ts: rows[d.index][0],
    price: r8(rows[d.index][4]), label: d.direction === 'bullish' ? 'Bull displacement' : 'Bear displacement',
    strength: clamp((d.bodyAtr / 2) * (d.relVolume == null ? 0.65 : Math.min(d.relVolume / 2, 1)), 0.35, 1),
    source: src('closed-impulse-body-close-location-relative-volume', { bodyAtr: r8(d.bodyAtr), relativeVolume: r8(d.relVolume) })
  }));

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
      const atrAtSweep = atrS[j] || atr, penetrationAtr = Math.abs((side === 'high' ? c[2] : c[3]) - best.price) / atrAtSweep;
      const reclaimAtr = Math.abs(c[4] - best.price) / atrAtSweep;
      const rvAtSweep = relativeVolume(rows.slice(0, j + 1));
      const sweepQuality = clamp((rank(best) >= 2 ? 0.35 : 0.2) + Math.min(penetrationAtr, 1) * 0.2 + Math.min(reclaimAtr, 1) * 0.2 + (rvAtSweep == null ? 0.05 : clamp((rvAtSweep - 1) / 3, 0, 1) * 0.25), 0, 1);
      add({ id: ['SWEEP', c[0], side].join('|'), layer: 'sweeps', kind: 'LIQUIDITY_SWEEP', direction: side === 'high' ? 'bearish' : 'bullish', ts: c[0], price: r8(best.price), label: (side === 'high' ? 'BSL' : 'SSL') + ' sweep', strength: r8(sweepQuality), quality: r8(sweepQuality), penetrationAtr: r8(penetrationAtr), reclaimAtr: r8(reclaimAtr), relativeVolume: r8(rvAtSweep), poolType: best.kind, source: src('wick-beyond-pool-close-back-quality-scored', { pool: best.kind, method: best.method, touches: best.count, penetrationAtr: r8(penetrationAtr), reclaimAtr: r8(reclaimAtr), relativeVolume: r8(rvAtSweep) }) });
    }
  }
  // Unswept liquidity right now (display): nearest pools on each side, capped.
  const price = rows[last][4], live = poolsAt(last + 1).filter((p) => !consumedBefore(p, last + 1));
  const byDist = (side) => live.filter((p) => p.side === side).sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price)).slice(0, 5);
  const pools = [...byDist('high'), ...byDist('low')].map((p) => { const distanceAtr = Math.abs(p.price - price) / atr, ageBars = Math.max(0, last - (p.toIdx ?? p.fromIdx)), role = p.kind === 'EXTERNAL' ? 'external' : (p.kind === 'EQH' || p.kind === 'EQL' ? 'equal-level' : 'internal'), quality = clamp(0.3 + 0.12 * Math.min(p.count, 4) + (role === 'external' ? 0.2 : role === 'equal-level' ? 0.12 : 0) - Math.min(distanceAtr, 10) * 0.025 - Math.min(ageBars, 220) / 220 * 0.1, 0.1, 1); return { ...p, swept: false, distanceAtr: r8(distanceAtr), ageBars, role, quality: r8(quality) }; });
  for (const p of pools) add({ id: ['LIQ', p.kind, p.side, r8(p.price)].join('|'), layer: 'liquidity', kind: p.kind === 'EQH' ? 'EQUAL_HIGHS' : p.kind === 'EQL' ? 'EQUAL_LOWS' : p.kind + '_LIQUIDITY', direction: p.side === 'high' ? 'buy-side' : 'sell-side', ts: rows[p.fromIdx][0], price: r8(p.price), label: (p.side === 'high' ? 'BSL ' : 'SSL ') + (p.kind === 'EQH' || p.kind === 'EQL' ? p.kind : p.kind.toLowerCase()), strength: p.quality, quality: p.quality, count: p.count, distanceAtr: p.distanceAtr, ageBars: p.ageBars, role: p.role, source: src(p.method, { touches: p.count, distanceAtr: p.distanceAtr, ageBars: p.ageBars, role: p.role, quality: p.quality }) });
  // Liquidity magnets: nearest unswept pools weighted by external/internal hierarchy, touch count and proximity.
  const magnets = pools.map((p) => { const dist = p.distanceAtr, w = (p.role === 'external' ? 1.2 : 1) * (1 + 0.4 * (p.count - 1)) * p.quality / (1 + dist); return { price: r8(p.price), side: p.side === 'high' ? 'above' : 'below', kind: p.kind, role: p.role, quality: p.quality, distanceAtr: r8(dist), pull: r8(w) }; }).sort((a, b) => b.pull - a.pull).slice(0, 4);
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
    const span = mh.price - ml.price;
    const bullOte = { top: mh.price - span * 0.62, bottom: mh.price - span * 0.79 };
    const bearOte = { top: ml.price + span * 0.79, bottom: ml.price + span * 0.62 };
    add({ id: 'OTE|bullish', layer: 'smc', kind: 'OTE_BULLISH', direction: 'bullish', ts: rows[since][0], top: r8(bullOte.top), bottom: r8(bullOte.bottom), price: r8((bullOte.top + bullOte.bottom) / 2), label: 'Bull OTE 62–79%', strength: 0.4, source: src('dealing-range-fibonacci-retracement', { retracement: [0.62, 0.79], swingHigh: mh.ts, swingLow: ml.ts }) });
    add({ id: 'OTE|bearish', layer: 'smc', kind: 'OTE_BEARISH', direction: 'bearish', ts: rows[since][0], top: r8(bearOte.top), bottom: r8(bearOte.bottom), price: r8((bearOte.top + bearOte.bottom) / 2), label: 'Bear OTE 62–79%', strength: 0.4, source: src('dealing-range-fibonacci-retracement', { retracement: [0.62, 0.79], swingHigh: mh.ts, swingLow: ml.ts }) });
  }
  out.items = items; out.status = 'ready'; out.trend = st.trend; out.atr = atr;
  out.liquidity = { pools: pools.map((p) => ({ ...p, price: r8(p.price) })), magnets, sweeps: sweeps.map((s) => ({ side: s.side, price: r8(s.price), at: s.sweptAt, kind: s.kind })) };
  return out;
}
