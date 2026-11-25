// Regime detection, directional confluence scoring, conflict detection and setup grading. Pure functions.
import { clamp, emaSeries, findSwings, structureEvents, normalizeCandles, splitClosed, timeframeMs } from '../gainz-alpha/indicators.js';

const r3 = (v) => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

/** Kaufman efficiency ratio + ATR percentile -> market regime. */
export function detectRegime(rows, atrS) {
  const n = Math.min(30, rows.length - 1);
  if (n < 10) return { state: 'unknown', er: null, atrRank: null };
  const closes = rows.map((c) => c[4]), net = Math.abs(closes[closes.length - 1] - closes[closes.length - 1 - n]);
  let path = 0; for (let i = closes.length - n; i < closes.length; i++) path += Math.abs(closes[i] - closes[i - 1]);
  const er = path > 0 ? net / path : 0;
  const recent = atrS.filter((v) => v != null).slice(-100), cur = recent[recent.length - 1];
  const sorted = [...recent].sort((x, y) => x - y), med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const atrRatio = med ? cur / med : 1, atrRank = recent.length ? recent.filter((v) => v <= cur).length / recent.length : 0.5;
  const dir = closes[closes.length - 1] >= closes[closes.length - 1 - n] ? 'up' : 'down';
  const state = atrRatio >= 1.8 ? 'volatile' : atrRatio <= 0.55 ? 'compressed' : er >= 0.4 ? 'trending-' + dir : er <= 0.22 ? 'ranging' : 'transitional';
  return { state, er: r3(er), atrRatio: r3(atrRatio), atrRank: r3(atrRank), direction: dir };
}

/** Adaptive minimum |score| and per-regime weight multipliers (trend factors dominate in trends, location factors in ranges). */
export function adaptiveConfig(regime) {
  const s = regime.state;
  const minScore = s.startsWith('trending') ? 0.26 : s === 'ranging' ? 0.36 : s === 'volatile' ? 0.42 : s === 'compressed' ? 0.4 : 0.3;
  const w = { structure: 1, location: 1, levels: 1, flow: 1, liquidity: 1, blocks: 1, mtf: 1, liquidation: 0.6 };
  if (s.startsWith('trending')) { w.structure = 1.4; w.mtf = 1.4; w.location = 0.6; }
  if (s === 'ranging') { w.location = 1.5; w.levels = 1.4; w.liquidity = 1.2; w.structure = 0.7; w.mtf = 0.7; }
  if (s === 'volatile') { w.flow = 0.7; w.levels = 0.8; w.liquidity = 1.2; }
  return { minScore, weights: w };
}

/** Multi-timeframe bias from fresh higher-timeframe candles (EMA stack + structure trend). */
export function mtfBias(inputs, now) {
  return (inputs || []).map((h) => {
    const { closed } = splitClosed(normalizeCandles(h.candles), h.timeframe, now);
    if (closed.length < 40) return { timeframe: h.timeframe, status: 'insufficient', bias: 0 };
    const tf = timeframeMs(h.timeframe), lastTs = closed[closed.length - 1][0];
    if (tf && now - (lastTs + tf) > 2 * tf) return { timeframe: h.timeframe, status: 'stale', bias: 0 };
    const closes = closed.map((c) => c[4]), e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50), n = closes.length - 1;
    const st = structureEvents(closed, findSwings(closed, 3));
    const bias = clamp(((closes[n] > e20[n] ? 1 : -1) + (e20[n] > e50[n] ? 1 : -1) + st.trend) / 3, -1, 1);
    return { timeframe: h.timeframe, status: 'fresh', bias: r3(bias), structureTrend: st.trend };
  });
}

const near = (it, price, atr, k) => Math.abs((it.price ?? 0) - price) <= atr * k;

/** Directional components in [-1, 1]; each one is derived from a concrete layer so the score is traceable. */
export function scoreComponents({ price, atr, smc, levels, sr, flow, liq, mtf, institutional = null, chainDex = null, sessionContext = null, fvgLiquidityScore = null, regimeCfg }) {
  const comp = {};
  const recent = (it, ts) => it.ts >= ts;
  const lastTs = smc.items.length ? Math.max(...smc.items.map((i) => i.ts)) : 0;
  const ev = smc.items.filter((i) => i.layer === 'structure').slice(-3), lastEv = ev[ev.length - 1];
  comp.structure = smc.trend * (lastEv ? (lastEv.kind === 'MSS' ? 1 : lastEv.kind === 'CHoCH' ? 0.85 : 0.65) : 0.3);
  comp.location = smc.dealingRange ? clamp((0.5 - smc.dealingRange.position) * 2, -1, 1) : 0;
  const vw = levels.find((l) => l.kind === 'VWAP'), poc = levels.find((l) => l.kind === 'POC');
  let lv = 0;
  if (vw) lv += clamp((price - vw.price) / (atr * 2), -1, 1) * 0.35;
  if (poc) lv += clamp((price - poc.price) / (atr * 3), -1, 1) * 0.25;
  for (const z of sr) { const d = (price - z.price) / atr; if (Math.abs(d) <= 1.2) lv += (z.role === 'support' ? 1 : z.role === 'resistance' ? -1 : 0) * z.strength * (1.2 - Math.abs(d)) * 0.5; }
  comp.levels = clamp(lv, -1, 1);
  comp.flow = flow && flow.status === 'ready' ? clamp(flow.summary.pressure * 2 + flow.items.filter((i) => i.ts >= (flow.series?.[flow.series.length - 6]?.ts ?? 0)).reduce((s, i) => s + (i.direction === 'bullish' ? 0.25 : -0.25) * i.strength, 0), -1, 1) * (flow.basis === 'measured-aggressor' ? 1 : 0.6) : 0;
  const sw = smc.items.filter((i) => i.kind === 'LIQUIDITY_SWEEP').slice(-2), swScore = sw.reduce((s, i) => s + (i.direction === 'bullish' ? 1 : -1) * i.strength, 0);
  const mg = smc.items.filter((i) => i.kind === 'LIQUIDITY_MAGNET'), pull = mg.reduce((s, i) => s + (i.direction === 'buy-side' ? 1 : -1) * i.strength, 0);
  comp.liquidity = clamp(swScore * 0.6 + pull * 0.3, -1, 1);
  const blocks = smc.items.filter((i) => (i.layer === 'orderBlocks' || i.layer === 'fvg') && i.status !== 'filled' && near(i, price, atr, 1.5) && i.top != null && price >= i.bottom - atr * 0.3 && price <= i.top + atr * 0.3);
  comp.blocks = clamp(blocks.reduce((s, i) => s + (i.direction === 'bullish' ? 1 : -1) * i.strength, 0), -1, 1);
  const fresh = (mtf || []).filter((m) => m.status === 'fresh');
  comp.mtf = fresh.length ? clamp(fresh.reduce((s, m) => s + m.bias, 0) / fresh.length, -1, 1) : 0;
  const ls = liq && liq.status === 'ready' ? liq.clusters : [];
  comp.liquidation = clamp(ls.filter((c) => c.distanceAtr <= 4).reduce((s, c) => s + (c.side === 'short' ? 1 : -1) * c.density / (1 + c.distanceAtr), 0), -1, 1);
  comp.institutional = institutional && institutional.status === 'ready' ? clamp(institutional.score, -1, 1) : 0;
  comp.chainDex = chainDex && chainDex.status === 'ready' ? clamp(chainDex.score, -1, 1) : 0;
  comp.session = sessionContext && sessionContext.status === 'ready' && Number.isFinite(sessionContext.directionalBias) ? clamp(sessionContext.directionalBias, -1, 1) : 0;
  comp.fvgLiquidity = fvgLiquidityScore?.available ? clamp(fvgLiquidityScore.value, -1, 1) : 0;
  const w = regimeCfg.weights;
  const base = { structure: 0.13984, location: 0.06992, levels: 0.10488, flow: 0.083904, liquidity: 0.10488, blocks: 0.06992, mtf: 0.097888, liquidation: 0.027968, institutional: 0.1104, chainDex: 0.0736, session: 0.0368, fvgLiquidity: 0.08 };
  const order = ['structure', 'location', 'levels', 'flow', 'liquidity', 'blocks', 'mtf', 'liquidation', 'institutional', 'chainDex', 'session', 'fvgLiquidity'];
  const rows = order.map((k) => { const weight = base[k] * (['institutional', 'chainDex', 'session', 'fvgLiquidity'].includes(k) ? 1 : (w[k] ?? 1)); return { key: k, value: r3(comp[k]), weight: r3(weight), contribution: r3(weight * comp[k]), available: k === 'flow' ? !!(flow && flow.status === 'ready') : k === 'mtf' ? fresh.length > 0 : k === 'liquidation' ? ls.length > 0 : k === 'institutional' ? !!(institutional && institutional.status === 'ready') : k === 'chainDex' ? !!(chainDex && chainDex.status === 'ready') : k === 'session' ? !!(sessionContext && sessionContext.status === 'ready') : k === 'fvgLiquidity' ? !!fvgLiquidityScore?.available : true }; });
  const used = rows.filter((r) => r.available), wSum = used.reduce((s, r) => s + r.weight, 0) || 1;
  const score = used.reduce((s, r) => s + r.contribution, 0) / wSum;
  return { score: r3(score), components: rows };
}

/** Compare independent sources against the signal direction. Returns conflicts with severities. */
export function detectConflicts({ signalDir, score, minScore, mtf, flow, dealing, external, institutional, chainDex, fvgLiquidity, eventRisk }) {
  const out = [];
  if (!signalDir) return { conflicts: out, severity: 0 };
  const name = (d) => (d > 0 ? 'bullish' : 'bearish');
  if (Math.abs(score) >= minScore && Math.sign(score) !== signalDir) out.push({ id: 'confluence-opposes', severity: 2, detail: 'Confluence score is ' + name(Math.sign(score)) + ' (' + score + ') against the ' + name(signalDir) + ' signal' });
  const fresh = (mtf || []).filter((m) => m.status === 'fresh'), opp = fresh.filter((m) => m.bias * signalDir < -0.3);
  if (opp.length) out.push({ id: 'mtf-opposes', severity: opp.length >= 2 || fresh.length === 1 ? 2 : 1, detail: opp.map((m) => m.timeframe).join(', ') + ' trend opposes the signal' });
  if (flow && flow.status === 'ready' && flow.summary.pressure * signalDir < -0.25) out.push({ id: 'flow-opposes', severity: flow.basis === 'measured-aggressor' ? 2 : 1, detail: 'Order flow shows ' + flow.summary.bias + ' pressure (' + flow.basis.replace('-', ' ') + ')' });
  if (dealing && ((signalDir > 0 && dealing.position > 0.8) || (signalDir < 0 && dealing.position < 0.2))) out.push({ id: 'location-extreme', severity: 1, detail: (signalDir > 0 ? 'Buying in deep premium' : 'Selling in deep discount') + ' of the dealing range' });
  if (external && external.direction && external.direction !== signalDir) out.push({ id: 'alpha-levels-oppose', severity: 2, detail: 'Alpha Signal Engine levels point ' + name(external.direction) + ' while the chart signal is ' + name(signalDir) });
  if (institutional && institutional.status === 'ready' && institutional.confidence >= 0.45 && Math.abs(institutional.score) >= 0.35 && Math.sign(institutional.score) !== signalDir) out.push({ id: 'institutional-context-opposes', severity: institutional.confidence >= 0.8 ? 3 : institutional.confidence >= 0.7 ? 2 : 1, detail: 'Timestamped cross-domain institutional evidence is ' + name(Math.sign(institutional.score)) + ' and conflicts with the chart signal' });
  if (chainDex && chainDex.status === 'ready' && chainDex.confidence >= 0.55 && Math.abs(chainDex.score) >= 0.35 && Math.sign(chainDex.score) !== signalDir) out.push({ id: 'chain-dex-flow-opposes', severity: chainDex.confidence >= 0.82 ? 2 : 1, detail: 'DEX pool and swap flow is ' + name(Math.sign(chainDex.score)) + ' and opposes the chart signal' });
  const linked = (fvgLiquidity?.setups || []).filter(s => s.score >= 70 && ['awaiting-retest','retest-observed','retest-in-zone'].includes(s.state));
  if (linked.some(s => (s.direction === 'bullish' ? 1 : -1) !== signalDir)) out.push({ id: 'fvg-liquidity-opposes', severity: linked.some(s => s.score >= 85) ? 2 : 1, detail: 'A high-quality sweep-to-FVG setup points against the chart signal' });
  if (eventRisk && eventRisk.active) out.push({ id: 'macro-event-risk', severity: eventRisk.severity >= 2 ? 2 : 1, detail: 'Recent high-impact geopolitical or financial news is active; reduce exposure and wait for post-event price confirmation' });
  return { conflicts: out, severity: out.reduce((s, c) => s + c.severity, 0) };
}

/** Setup grade from confluence quality. This is NOT a win probability; calibration lives in expectancy. */
export function gradeSetup({ score, agreeing, total, mtf, conflictSeverity, confidence, expectancy }) {
  const fresh = (mtf || []).filter((m) => m.status === 'fresh');
  const mtfPts = !fresh.length ? 7 : clamp(7.5 + (fresh.reduce((s, m) => s + m.bias * Math.sign(score || 1), 0) / fresh.length) * 7.5, 0, 15);
  const expPts = expectancy && expectancy.reliable ? (expectancy.expectancy > 0.2 ? 10 : expectancy.expectancy >= 0 ? 6 : 0) : 5;
  const pts = clamp(Math.abs(score) / 0.7, 0, 1) * 40 + (total ? agreeing / total : 0) * 25 + mtfPts + expPts + clamp((confidence || 0) / 100, 0, 1) * 10 - conflictSeverity * 8;
  const p = Math.round(clamp(pts, 0, 100));
  return { points: p, grade: p >= 85 ? 'A+' : p >= 75 ? 'A' : p >= 62 ? 'B' : p >= 50 ? 'C' : 'D', note: 'Confluence-quality grade; not a win probability.' };
}
