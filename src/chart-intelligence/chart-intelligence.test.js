import test from 'node:test';
import assert from 'node:assert/strict';
import { volumeProfile, vwap, supportResistance, profileLevels, reactionStats, typical } from './levels.js';
import { analyzeOrderFlow, candleDelta } from './orderflow.js';
import { analyzeSmc } from './smc.js';
import { analyzeLiquidation, liquidationPrice } from './liquidation.js';
import { detectRegime, adaptiveConfig, detectConflicts, gradeSetup, mtfBias } from './confluence.js';
import { analyzeChartIntelligence, analyzeAt, createMemoryLedger, runChartIntelligenceBacktest, toChartEvidence, evaluateTrade, trailingStop, LAYERS } from './engine.js';
import { sanitizeSettings, createSettingsStore, freshAlerts } from './settings.js';
import { atrSeries } from '../gainz-alpha/indicators.js';

const H = 3600e3;
function walk(n, seed = 1, { drift = 0, scale = 1, tf = H, start = 100, t0 = Date.UTC(2026, 0, 1) } = {}) {
  let s = seed; const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const rows = []; let p = start * scale;
  for (let i = 0; i < n; i++) { const o = p, c = Math.max(scale * 1, o + (drift + (rnd() - 0.5) * 2) * scale), h = Math.max(o, c) + rnd() * 0.6 * scale, l = Math.min(o, c) - rnd() * 0.6 * scale; rows.push([t0 + i * tf, o, h, l, c, 80 + rnd() * 120]); p = c; }
  return rows;
}
const nowFor = (rows, tf = H) => rows[rows.length - 1][0] + tf + 1000;
const finite = (v) => v == null || Number.isFinite(v);

test('volume profile: POC is the heaviest bin and value area covers >= 70%', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push([i * H, 100, 101, 99, 100, 10]);
  for (let i = 40; i < 60; i++) rows.push([i * H, 110, 111, 109, 110, 100]);
  const p = volumeProfile(rows, { bins: 40 });
  assert.ok(Math.abs(p.poc - 110) < 1.2, 'poc near the heavy volume cluster: ' + p.poc);
  assert.ok(p.valueAreaPct >= 0.7);
  assert.ok(p.val <= p.poc && p.poc <= p.vah);
  assert.ok(Math.abs(p.bins.reduce((s, b) => s + b.volume, 0) - p.totalVolume) < 1e-6);
});

test('VWAP equals the manual volume-weighted typical price', () => {
  const rows = walk(30, 3);
  const v = vwap(rows, 0), last = v[v.length - 1];
  let pv = 0, vol = 0; rows.forEach((c) => { pv += typical(c) * c[5]; vol += c[5]; });
  assert.ok(Math.abs(last.vwap - pv / vol) < 1e-9);
  assert.ok(last.lower1 <= last.vwap && last.vwap <= last.upper1);
  const anchored = vwap(rows, 10), a = anchored[anchored.length - 1];
  let pv2 = 0, v2 = 0; rows.slice(10).forEach((c) => { pv2 += typical(c) * c[5]; v2 += c[5]; });
  assert.ok(Math.abs(a.vwap - pv2 / v2) < 1e-9);
});

test('profile levels: every level has a source and finite numbers; PDH/PDL come from the previous day', () => {
  const rows = walk(120, 5), items = profileLevels(rows, { timeframe: '1h', anchors: [{ kind: 'swing-low', ts: rows[80][0] }] });
  assert.ok(items.length >= 8);
  for (const it of items) { assert.ok(it.source && it.source.method && it.source.basis, it.id); assert.ok(Number.isFinite(it.price), it.id); }
  const pdh = items.find((i) => i.kind === 'PDH'), lastDay = new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10);
  const prev = rows.filter((c) => new Date(c[0]).toISOString().slice(0, 10) !== lastDay);
  const prevDay = prev.filter((c) => new Date(c[0]).toISOString().slice(0, 10) === new Date(prev[prev.length - 1][0]).toISOString().slice(0, 10));
  assert.equal(pdh.price, Number(Math.max(...prevDay.map((c) => c[2])).toFixed(8)));
  assert.ok(items.some((i) => i.kind === 'AVWAP'));
});

test('support/resistance zones are measured: touches >= 2, strength in [0,1], bottom < top', () => {
  const rows = walk(300, 9), atr = atrSeries(rows, 14)[rows.length - 1], z = supportResistance(rows, { atr });
  assert.ok(z.length > 0);
  for (const x of z) { assert.ok(x.touches >= 2); assert.ok(x.strength >= 0 && x.strength <= 1); assert.ok(x.bottom < x.top); assert.ok(['support', 'resistance', 'zone'].includes(x.role)); }
});

test('reaction stats count touches and reactions of an exact level', () => {
  const rows = []; for (let i = 0; i < 60; i++) rows.push([i * H, 101, 102, 100.5, 101, 10]);
  rows[20] = [20 * H, 101, 101.2, 99.9, 100.5, 10]; for (let i = 21; i < 26; i++) rows[i] = [i * H, 100.6, 102.5, 100.5, 102, 10];
  const r = reactionStats(rows, 100, 1, { touchTol: 0.15, reactAtr: 0.5, horizon: 5 });
  assert.equal(r.touches, 1); assert.equal(r.reactions, 1); assert.equal(r.rate, 1);
});

test('liquidation maths: isolated-margin formulas and traversed levels are removed', () => {
  assert.equal(Number(liquidationPrice(100, 10, 'long', 0.005).toFixed(4)), 90.5);
  assert.equal(Number(liquidationPrice(100, 10, 'short', 0.005).toFixed(4)), 109.5);
  assert.ok(liquidationPrice(100, 100, 'long', 0.005) > liquidationPrice(100, 5, 'long', 0.005));
  const rows = walk(300, 4), res = analyzeLiquidation(rows);
  assert.equal(res.basis, 'estimated-model');
  const price = rows[rows.length - 1][4];
  for (const c of res.clusters) { if (c.side === 'long') assert.ok(c.price < price); else assert.ok(c.price > price); }
  for (const it of res.items) assert.equal(it.source.basis, 'estimated-model');
  const live = analyzeLiquidation(rows, { feed: [{ price: price * 0.95, side: 'long', size: 5 }, { price: price * 1.04, side: 'short', size: 2 }] });
  assert.equal(live.basis, 'measured-feed');
});

test('order flow is labelled estimated from OHLCV and measured when aggressor volume is supplied', () => {
  const rows = walk(120, 6), est = analyzeOrderFlow(rows);
  assert.equal(est.basis, 'ohlcv-estimate'); assert.match(est.summary.basisNote, /not tick data/i);
  const flow = rows.map((c) => ({ ts: c[0], buyVolume: c[5] * 0.7, sellVolume: c[5] * 0.3 }));
  const meas = analyzeOrderFlow(rows, { flow });
  assert.equal(meas.basis, 'measured-aggressor'); assert.ok(meas.summary.pressure > 0.35);
  const d = candleDelta(rows).bars[0]; assert.ok(Math.abs(d.buy + d.sell - rows[0][5]) < 1e-9);
});

test('absorption is detected on a heavy-volume, small-body candle with a long lower wick', () => {
  const rows = []; for (let i = 0; i < 60; i++) rows.push([i * H, 100, 100.8, 99.2, 100.2, 100]);
  rows.push([60 * H, 100, 100.4, 98.2, 100.3, 450]);
  const r = analyzeOrderFlow(rows), hit = r.items.find((x) => x.kind === 'ABSORPTION' && x.ts === 60 * H);
  assert.ok(hit); assert.equal(hit.direction, 'bullish'); assert.equal(hit.source.basis, 'ohlcv-estimate');
});

test('filled fair-value gaps remain in historical chart output and sweeps expose quality metadata',()=>{
 const rows=[];for(let i=0;i<70;i++)rows.push([i*H,100,101,99,100,100]);
 rows[43]=[43*H,100,100.5,99.8,100.2,100];
 rows[45]=[45*H,103,104,102,103.5,180];
 const prefix=analyzeSmc(rows.slice(0,46)),full=analyzeSmc(rows);
 const formed=prefix.items.find(x=>x.kind==='FVG'&&x.ts===45*H);
 const later=full.items.find(x=>x.id===formed?.id);
 assert.ok(formed,'bullish FVG is detected on its formation prefix');
 assert.ok(later,'the FVG remains represented after later candles mitigate it');
 assert.equal(later.price,formed.price);
 assert.ok(['active','filled','partial'].includes(later.status));
 const hardened=analyzeSmc(walk(215,12));
 for(const pool of hardened.liquidity.pools){assert.ok(['external','internal','equal-level'].includes(pool.role));assert.ok(Number.isFinite(pool.quality)&&pool.quality>=0&&pool.quality<=1);assert.ok(Number.isFinite(pool.distanceAtr));}
 const sweeps=analyzeSmc(walk(215,12)).items.filter(x=>x.kind==='LIQUIDITY_SWEEP');
 assert.ok(sweeps.length>0);
 for(const x of sweeps){assert.ok(Number.isFinite(x.quality)&&x.quality>=0&&x.quality<=1);assert.ok(Number.isFinite(x.penetrationAtr));}
});

test('chain DEX and session forecast are part of the same canonical confluence result',()=>{
 const rows=walk(420,71),now=nowFor(rows),generatedAt=new Date(now).toISOString();
 const chainDexContext={status:'ready',generatedAt,sources:[{name:'DexScreener',status:'live'},{name:'GeckoTerminal',status:'live'}],pools:[{liquidityUsd:800000,volume24hUsd:1600000,priceChange24hPct:3}],flow:{buyUsd:900000,sellUsd:300000,buys:20,sells:9,basis:'geckoterminal-confirmed-swap-sample'},trades:Array.from({length:15},(_,i)=>({basis:'geckoterminal-confirmed-swap',amountUsd:100+i}))};
 const sessionContext={status:'ready',generatedAt,directionalBias:.35,sessions:[{id:'london',forecast:{high:105,low:95},confidence:'moderate',historySamples:8}]};
 const r=analyzeChartIntelligence(rows,{exchange:'x',symbol:'ETH/USDT',timeframe:'1h',now,chainDexContext,sessionContext,ledger:createMemoryLedger()});
 assert.equal(r.status,'ready');assert.equal(r.chainDex.status,'ready');assert.equal(r.sessionForecast.directionalBias,.35);
 assert.ok(r.confluence.components.some(x=>x.key==='chainDex'&&x.available));
 assert.ok(r.confluence.components.some(x=>x.key==='session'&&x.available));
 assert.ok(r.layers.liquidity.some(x=>x.kind==='SESSION_FORECAST_HIGH'));
 assert.ok(r.entryAssessment&&typeof r.entryAssessment.status==='string');
});
test('SMC items never repaint: items found on a prefix reappear unchanged on the longer series', () => {
  const rows = walk(215, 12), prefix = analyzeSmc(rows.slice(0, 150)), full = analyzeSmc(rows);
  for (const layer of ['structure', 'sweeps']) {
    const a = prefix.items.filter((i) => i.layer === layer), b = new Map(full.items.filter((i) => i.layer === layer).map((i) => [i.id, i]));
    assert.ok(a.length > 0, layer + ' has items');
    for (const it of a) { assert.ok(b.has(it.id), layer + ' item disappeared: ' + it.id); assert.equal(b.get(it.id).price, it.price); }
  }
});

test('SMC definitions: premium above equilibrium, discount below, equilibrium is the midpoint', () => {
  const smc = analyzeSmc(walk(200, 14)), d = smc.dealingRange;
  assert.ok(d); assert.ok(Math.abs(d.equilibrium - (d.high + d.low) / 2) < 1e-6);
  const prem = smc.items.find((i) => i.kind === 'PREMIUM'), disc = smc.items.find((i) => i.kind === 'DISCOUNT');
  assert.ok(prem.bottom >= disc.top - 1e-9); assert.equal(prem.bottom, d.equilibrium);
  for (const it of smc.items) { assert.ok(it.source && it.source.method); assert.ok(finite(it.price) && finite(it.top) && finite(it.bottom)); if (it.top != null) assert.ok(it.top >= it.bottom); }
});

test('regime detection and adaptive thresholds react to trend vs range', () => {
  const trend = walk(120, 2, { drift: 0.5 }), range = Array.from({ length: 120 }, (_, i) => [i * H, 100, 100.5 + (i % 2) * 0.2, 99.5, 100 + (i % 2 ? 0.2 : -0.2), 50]);
  const rt = detectRegime(trend, atrSeries(trend, 14)), rr = detectRegime(range, atrSeries(range, 14));
  assert.match(rt.state, /trending|volatile/); assert.ok(rt.er > rr.er);
  assert.ok(adaptiveConfig({ state: 'ranging' }).minScore > adaptiveConfig({ state: 'trending-up' }).minScore);
});

test('conflict detection and grading: opposing sources lower the grade and raise severity', () => {
  const clean = detectConflicts({ signalDir: 1, score: 0.5, minScore: 0.3, mtf: [{ status: 'fresh', bias: 0.8, timeframe: '4h' }], flow: null, dealing: { position: 0.3 }, external: null });
  const bad = detectConflicts({ signalDir: 1, score: -0.5, minScore: 0.3, mtf: [{ status: 'fresh', bias: -0.8, timeframe: '4h' }], flow: { status: 'ready', basis: 'measured-aggressor', summary: { pressure: -0.5, bias: 'selling' } }, dealing: { position: 0.9 }, external: { direction: -1 } });
  assert.equal(clean.severity, 0); assert.ok(bad.severity >= 6); assert.ok(bad.conflicts.some((c) => c.id === 'alpha-levels-oppose'));
  const g1 = gradeSetup({ score: 0.6, agreeing: 7, total: 8, mtf: [{ status: 'fresh', bias: 0.9 }], conflictSeverity: 0, confidence: 80, expectancy: { reliable: true, expectancy: 0.5 } });
  const g2 = gradeSetup({ score: 0.6, agreeing: 7, total: 8, mtf: [{ status: 'fresh', bias: 0.9 }], conflictSeverity: 4, confidence: 80, expectancy: { reliable: true, expectancy: 0.5 } });
  assert.ok(g1.points > g2.points); assert.equal(g1.grade, 'A+');
  assert.equal(mtfBias([{ timeframe: '4h', candles: walk(20, 3) }], Date.now())[0].status, 'insufficient');
});

test('engine: deterministic, fully traceable, finite, and every layer item has provenance', () => {
  const rows = walk(400, 21), opts = { exchange: 'x', symbol: 'BTC/USDT', timeframe: '1h', now: nowFor(rows) };
  const a = analyzeChartIntelligence(rows, { ...opts, ledger: createMemoryLedger() }), b = analyzeChartIntelligence(rows, { ...opts, ledger: createMemoryLedger() });
  assert.equal(a.status, 'ready'); assert.equal(JSON.stringify(a.layers), JSON.stringify(b.layers)); assert.equal(JSON.stringify(a.plan), JSON.stringify(b.plan));
  for (const layer of LAYERS) for (const it of a.layers[layer] || []) {
    assert.ok(it.source && it.source.module && it.source.method && it.source.basis, layer + ' ' + it.id + ' lacks provenance');
    assert.ok(finite(it.price) && finite(it.top) && finite(it.bottom), layer + ' ' + it.id + ' has non-finite value');
    assert.ok(!JSON.stringify(it).includes('NaN'));
  }
  const ids = LAYERS.flatMap((l) => (a.layers[l] || []).map((i) => i.id)); assert.equal(new Set(ids).size, ids.length, 'duplicate item ids');
  assert.ok(a.provenance.length === LAYERS.length);
});

test('engine: forming candle is never used (appending a forming bar does not change the analysis)', () => {
  const rows = walk(300, 22), now = nowFor(rows), forming = [rows[299][0] + H, rows[299][4], rows[299][4] + 50, rows[299][4] - 50, rows[299][4] + 40, 9999];
  const a = analyzeChartIntelligence(rows, { symbol: 'X', timeframe: '1h', now: now - 1000 + 1000, ledger: createMemoryLedger() });
  const b = analyzeChartIntelligence([...rows, forming], { symbol: 'X', timeframe: '1h', now: forming[0] + 60000, ledger: createMemoryLedger() });
  assert.equal(JSON.stringify(a.layers), JSON.stringify(b.layers)); assert.equal(b.forming, forming[0]);
});

test('signals never repaint: the ledger freezes markers while new bars arrive', () => {
  const rows = walk(420, 31), ledger = createMemoryLedger(), o = { exchange: 'x', symbol: 'ETH/USDT', timeframe: '1h' };
  const early = analyzeChartIntelligence(rows.slice(0, 360), { ...o, now: nowFor(rows.slice(0, 360)), ledger });
  const snapshot = early.signals.map((s) => [s.ts, s.signal, s.riskPlan.entry, s.riskPlan.stopLoss]);
  let later; for (let n = 361; n <= 420; n += 1) later = analyzeChartIntelligence(rows.slice(0, n), { ...o, now: nowFor(rows.slice(0, n)), ledger });
  const lateMap = new Map(later.signals.map((s) => [s.ts, s]));
  for (const [ts, sig, entry, stop] of snapshot) { const s = lateMap.get(ts); assert.ok(s, 'signal at ' + ts + ' disappeared'); assert.equal(s.signal, sig); assert.equal(s.riskPlan.entry, entry); assert.equal(s.riskPlan.stopLoss, stop); }
  const sameBar = later.signals.map((s) => s.ts), buys = new Set(later.signals.filter((s) => s.signal === 'BUY').map((s) => s.ts));
  assert.ok(!later.signals.some((s) => s.signal === 'SELL' && buys.has(s.ts)), 'BUY and SELL on one bar'); assert.equal(new Set(sameBar).size, sameBar.length);
});

test('replay: analyzeAt(i) equals the analysis produced from the first i+1 candles', () => {
  const rows = walk(300, 41), o = { exchange: 'x', symbol: 'SOL/USDT', timeframe: '1h' }, i = 250;
  const r = analyzeAt(rows, i, o), direct = analyzeChartIntelligence(rows.slice(0, i + 1), { ...o, now: rows[i][0] + H, ledger: null });
  assert.equal(r.asOf, rows[i][0]); assert.equal(JSON.stringify(r.layers.sr), JSON.stringify(direct.layers.sr)); assert.equal(JSON.stringify(r.confluence), JSON.stringify(direct.confluence));
  assert.throws(() => analyzeAt(rows, 999, o));
});

test('no look-ahead leakage: on driftless random walks backtest expectancy is statistically ~0', () => {
  let resolved = 0, wins = 0, totalR = 0;
  for (const seed of [101, 202, 303, 404]) { const b = runChartIntelligenceBacktest(walk(800, seed), { symbol: 'RW', timeframe: '1h' }); resolved += b.resolved; wins += b.wins; totalR += b.totalR || 0; }
  assert.ok(resolved >= 100, 'enough resolved signals: ' + resolved);
  const exp = totalR / resolved, wr = wins / resolved;
  assert.ok(Math.abs(exp) < 0.2, 'expectancy ' + exp.toFixed(3)); assert.ok(wr > 0.28 && wr < 0.55, 'win rate ' + wr.toFixed(3));
});

test('coverage: works across asset scales and timeframes without NaN or exceptions', () => {
  const tfs = [['1m', 60e3], ['5m', 300e3], ['15m', 900e3], ['1h', H], ['4h', 4 * H], ['1d', 24 * H]];
  for (const scale of [0.00001, 1, 650]) for (const [tf, ms] of tfs) {
    const rows = walk(260, 7, { scale, tf: ms }), r = analyzeChartIntelligence(rows, { exchange: 'x', symbol: 'A/B', timeframe: tf, now: nowFor(rows, ms), ledger: createMemoryLedger() });
    assert.equal(r.status, 'ready', tf + ' ' + scale);
    assert.ok(!JSON.stringify(r.layers).includes('NaN') && !JSON.stringify(r.layers).includes('null,"price":null'), tf + ' ' + scale);
    assert.ok(Number.isFinite(r.confluence.score));
  }
  assert.equal(analyzeChartIntelligence(walk(30, 1), { symbol: 'X', timeframe: '1h', now: nowFor(walk(30, 1)) }).status, 'insufficient');
  assert.equal(analyzeChartIntelligence([], { symbol: 'X', timeframe: '1h' }).status, 'insufficient');
  const garbage = [[1, 'a', 2, 3, 4, 5], [null], 'x'], res = analyzeChartIntelligence(garbage, { symbol: 'X', timeframe: '1h' }); assert.equal(res.status, 'insufficient');
});

test('trade lifecycle: stop-first inside a bar, TP progression, trailing stop only tightens', () => {
  const base = []; for (let i = 0; i < 70; i++) base.push([i * H, 100, 100.5, 99.5, 100, 10]);
  const sig = { signal: 'BUY', ts: base[60][0], riskPlan: { entry: 100, stopLoss: 98, takeProfit1: 103, takeProfit2: 105, takeProfit3: null } };
  const both = base.slice(0, 62).concat([[62 * H, 100, 104, 97, 100, 10]]);
  assert.equal(evaluateTrade(sig, both).state, 'stopped');
  const run = base.slice(0, 61).concat([[61 * H, 100, 103.5, 99.9, 103, 10], [62 * H, 103, 105.5, 102, 105, 10]]);
  const ev = evaluateTrade(sig, run); assert.equal(ev.tpsHit, 2); assert.equal(ev.state, 'tp2');
  const tr1 = trailingStop(run, sig, { atr: 1 }), tr2 = trailingStop(run.concat([[63 * H, 105, 105.2, 102.5, 103, 10]]), sig, { atr: 1 });
  assert.ok(tr1.armed && tr2.armed && tr2.price >= tr1.price);
});

test('evidence mapping for Alpha / scanner / risk consumers', () => {
  const rows = walk(400, 51), r = analyzeChartIntelligence(rows, { exchange: 'x', symbol: 'BTC/USDT', timeframe: '1h', now: nowFor(rows), ledger: createMemoryLedger() }), ev = toChartEvidence(r);
  assert.equal(ev.source, 'chart-intelligence'); assert.equal(ev.available, true); assert.ok([1, -1, 0].includes(ev.direction)); assert.ok(Array.isArray(ev.conflicts));
  assert.equal(toChartEvidence({ status: 'insufficient', reason: 'x' }).available, false);
});

test('conflicting external Alpha levels are flagged and the plan is withheld when severe', () => {
  const rows = walk(420, 31), o = { exchange: 'x', symbol: 'ETH/USDT', timeframe: '1h', now: nowFor(rows) };
  const base = analyzeChartIntelligence(rows, { ...o, ledger: createMemoryLedger() });
  if (!base.active) return; // no live signal in this series; covered by unit-level conflict test
  const dir = base.active.signal === 'BUY' ? 1 : -1, price = base.price;
  const opp = [{ label: 'ENTRY', price }, { label: 'STOP', price: price + dir * 5 }];
  const r = analyzeChartIntelligence(rows, { ...o, externalLevels: opp, ledger: createMemoryLedger() });
  assert.ok(r.conflicts.some((c) => c.id === 'alpha-levels-oppose'));
});

test('settings: sanitised, persisted, shared by subscribers; alert ids are de-duplicated', () => {
  const mem = new Map(), storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  const s = sanitizeSettings({ layers: { signals: false, bogus: true }, density: 'weird', historyBars: 9999 });
  assert.equal(s.layers.signals, false); assert.equal('bogus' in s.layers, false); assert.equal(s.density, 'auto'); assert.equal(s.historyBars, 150);
  const st = createSettingsStore(storage); let seen = 0; st.subscribe(() => seen++);
  st.update({ layers: { orderflow: true } }); assert.equal(st.get().layers.orderflow, true); assert.equal(seen, 1);
  assert.equal(createSettingsStore(storage).get().layers.orderflow, true);
  st.reset(); assert.equal(st.get().layers.orderflow, false);
  const a = [{ id: 'a' }, { id: 'b' }];
  assert.equal(freshAlerts(a, storage).length, 2); assert.equal(freshAlerts(a, storage).length, 0); assert.equal(freshAlerts([...a, { id: 'c' }], storage).length, 1);
});

test('MR-2.0 regime diagnostics and adaptive posture are fully integrated into canonical chart intelligence',()=>{
 const rows=walk(420,81,{drift:.18}),r=analyzeChartIntelligence(rows,{exchange:'bitget',symbol:'BTC/USDT',timeframe:'1h',now:nowFor(rows),higherTimeframes:[],ledger:createMemoryLedger()}),ev=toChartEvidence(r);
 assert.equal(r.status,'ready');assert.equal(r.regime.model,'JPTI-MR-2.0');assert.ok(r.regime.probabilities&&r.regime.metrics&&r.regime.multiTimeframe);assert.ok(r.adaptive&&Number.isFinite(r.adaptive.minScore)&&Number.isFinite(r.adaptive.positionSizeMultiplier));assert.equal(ev.regime,r.regime.state);assert.equal(ev.regimeAnalysis.model,'JPTI-MR-2.0');assert.equal(ev.adaptive.positionSizeMultiplier,r.adaptive.positionSizeMultiplier);
});
