// Chart Intelligence engine: one deterministic, closed-candle-only analysis that every chart consumes.
// It does NOT mint a second BUY/SELL: signals come from the GainzAlpha engine (single source of truth). This layer
// adds data-backed levels, SMC, order flow, liquidation, MTF, regime, confluence grading, conflict detection, the trade
// plan (entry zone, TP1..TPn, SL, trailing stop) and a frozen signal ledger so markers never repaint.
import { analyzeGainzAlpha } from '../gainz-alpha/engine.js';
import { resolvePreset } from '../gainz-alpha/presets.js';
import { summarize, evaluateOutcome } from '../gainz-alpha/learning.js';
import { atrSeries, clamp, findSwings, normalizeCandles, splitClosed, structureEvents, timeframeMs } from '../gainz-alpha/indicators.js';
import { profileLevels, supportResistance, reactionStats, volumeProfile } from './levels.js';
import { analyzeOrderFlow } from './orderflow.js';
import { analyzeSmc } from './smc.js';
import { analyzeLiquidation } from './liquidation.js';
import { detectRegime, adaptiveConfig, mtfBias, scoreComponents, detectConflicts, gradeSetup } from './confluence.js';
import { scoreInstitutionalContext } from './institutional.js';
import { scoreChainDexContext } from './chain-dex.js';
import { analyzeFvgLiquidity, scoreFvgLiquidityForConfluence } from './fvg-liquidity.js';
import { analyzeCandleFormation } from './candle-formation.js';
import { evaluateTradingDeskAgents } from './trading-desk-agents.js';

export const MODULE_VERSION = 'chart-intelligence-1.2.0';
export const LAYERS = ['signals', 'plan', 'liquidation', 'profile', 'volumeNodes', 'sr', 'orderflow', 'structure', 'orderBlocks', 'fvg', 'liquidity', 'sweeps', 'smc', 'vwap', 'candlePatterns'];
export const DEFAULT_LAYER_VISIBILITY = { signals: true, plan: true, liquidation: true, profile: true, volumeNodes: true, sr: true, orderflow: false, structure: true, orderBlocks: true, fvg: true, liquidity: true, sweeps: true, smc: true, vwap: true, candlePatterns: true };
const r8 = (v) => (Number.isFinite(v) ? Number(v.toFixed(8)) : null);

export function createMemoryLedger() {
  const m = new Map();
  return { get: (k) => m.get(k) || null, put: (k, v) => { m.set(k, v); } };
}
export function createStorageLedger(storage, key = 'jpti.chart-intelligence.ledger.v1') {
  let state = {};
  try { state = JSON.parse(storage.getItem(key) || '{}') || {}; } catch { state = {}; }
  return { get: (k) => state[k] || null, put: (k, v) => { state[k] = v; try { storage.setItem(key, JSON.stringify(state)); } catch { /* memory-only fallback */ } } };
}

function compactSignal(r) {
  const p = r.riskPlan;
  return { id: [r.symbol, r.timeframe, r.asOf, r.signal].join('|'), signal: r.signal, ts: r.asOf, confidence: r.confidence, score: r.score, setupId: r.setupId, kind: r.signalKind, riskPlan: p ? { entry: p.entry, stopLoss: p.stopLoss, takeProfit1: p.takeProfit1, takeProfit2: p.takeProfit2, takeProfit3: p.takeProfit3, rr1: p.rr1, risk: p.risk, costs: p.costs } : null, riskPlanFull: undefined };
}

/** Walk-forward over closed candles with no lookahead: the result at bar i only sees bars <= i. */
export function walkForwardSignals(work, ctx, { fromIndex, gainzOptions = {} }) {
  const tf = timeframeMs(ctx.timeframe), out = [];
  if (!tf) return out;
  for (let i = Math.max(60, fromIndex); i < work.length; i++) {
    const slice = work.slice(Math.max(0, i - 299), i + 1);
    let res; try { res = analyzeGainzAlpha(slice, { ...gainzOptions, symbol: ctx.symbol, exchange: ctx.exchange, timeframe: ctx.timeframe, now: work[i][0] + tf, mode: 'confirmed', outcomes: [], model: null, recentSignals: [] }); } catch { continue; }
    if (res.status === 'ready' && (res.signal === 'BUY' || res.signal === 'SELL') && res.riskPlan) out.push(compactSignal(res));
  }
  return out;
}

/** Evaluate a recorded signal against the closed candles that followed it. Stop is checked before targets inside a bar. */
export function evaluateTrade(sig, work, { expireBars = 40 } = {}) {
  const dir = sig.signal === 'BUY' ? 1 : -1, p = sig.riskPlan, i0 = work.findIndex((c) => c[0] === sig.ts);
  if (i0 < 0 || i0 + 1 >= work.length) return { state: 'open', tpsHit: 0, bars: 0 };
  const entry = work[i0 + 1][1], tps = [p.takeProfit1, p.takeProfit2, p.takeProfit3].filter((x) => Number.isFinite(x)), risk = (entry - p.stopLoss) * dir;
  let tpsHit = 0, state = 'open', exitTs = null, mfe = 0;
  const horizon = Math.min(work.length - (i0 + 1), expireBars);
  for (let k = 0; k < horizon; k++) {
    const c = work[i0 + 1 + k];
    if (dir > 0 ? c[3] <= p.stopLoss : c[2] >= p.stopLoss) { state = tpsHit > 0 ? 'tp' + tpsHit : 'stopped'; exitTs = c[0]; if (tpsHit > 0) state = 'stopped-after-tp' + tpsHit; break; }
    while (tpsHit < tps.length && (dir > 0 ? c[2] >= tps[tpsHit] : c[3] <= tps[tpsHit])) tpsHit++;
    mfe = Math.max(mfe, ((dir > 0 ? c[2] : c[3]) - entry) * dir / (risk || 1));
    if (tpsHit === tps.length) { state = 'tp' + tpsHit; exitTs = c[0]; break; }
  }
  if (state === 'open') state = work.length - (i0 + 1) >= expireBars ? (tpsHit > 0 ? 'tp' + tpsHit : 'expired') : tpsHit > 0 ? 'tp' + tpsHit + '-open' : 'open';
  const terminal = !['open'].includes(state) && !state.endsWith('-open');
  return { state, terminal, tpsHit, exitTs, entry, mfeR: r8(mfe), bars: Math.min(horizon, work.length - 1 - i0) };
}

/** Chandelier-style trailing stop on closed candles after entry. Starts after +1R and only ever tightens. */
export function trailingStop(work, sig, { atr, mult = 2.5 }) {
  const dir = sig.signal === 'BUY' ? 1 : -1, p = sig.riskPlan, i0 = work.findIndex((c) => c[0] === sig.ts);
  if (i0 < 0 || i0 + 1 >= work.length) return null;
  const entry = work[i0 + 1][1], risk = (entry - p.stopLoss) * dir;
  let extreme = entry, trail = null, armed = false;
  for (let i = i0 + 1; i < work.length; i++) {
    extreme = dir > 0 ? Math.max(extreme, work[i][2]) : Math.min(extreme, work[i][3]);
    if (!armed && (extreme - entry) * dir >= risk) armed = true;
    if (armed) { const cand = extreme - dir * atr * mult; trail = trail == null ? cand : dir > 0 ? Math.max(trail, cand) : Math.min(trail, cand); }
  }
  return trail == null ? { armed: false, price: null } : { armed: true, price: r8(dir > 0 ? Math.max(trail, p.stopLoss) : Math.min(trail, p.stopLoss)), multiple: mult };
}

function mergeNearLevels(items, atr, tolAtr = 0.06) {
  const singles = items.filter((i) => i.top == null && Number.isFinite(i.price)).sort((a, b) => a.price - b.price), rest = items.filter((i) => !(i.top == null && Number.isFinite(i.price)));
  const out = [];
  for (const it of singles) {
    const prev = out[out.length - 1];
    if (prev && prev.layer === it.layer && Math.abs(prev.price - it.price) <= atr * tolAtr) { prev.label += ' / ' + it.label; prev.merged = [...(prev.merged || [prev.id]), it.id]; prev.strength = Math.max(prev.strength || 0, it.strength || 0); } else out.push({ ...it });
  }
  return [...out, ...rest];
}

function buildPlan(sig, state, work, atr, levelPool, cfg, trail) {
  const dir = sig.signal === 'BUY' ? 1 : -1, p = sig.riskPlan, entry = p.entry, risk = Math.abs(entry - p.stopLoss);
  const targets = [], pushT = (price, source) => { if (Number.isFinite(price) && (price - entry) * dir > 0 && !targets.some((t) => Math.abs(t.price - price) < atr * 0.3)) targets.push({ price: r8(price), rr: r8(((price - entry) * dir) / risk), source }); };
  [[p.takeProfit1, 'gainz-tp1'], [p.takeProfit2, 'gainz-tp2'], [p.takeProfit3, 'gainz-tp3']].forEach(([x, s]) => pushT(x, s));
  levelPool.filter((l) => (l.price - entry) * dir > risk * cfg.minRR && (l.strength || 0) >= 0.5).sort((a, b) => (a.price - b.price) * dir).forEach((l) => { if (targets.length < 5) pushT(l.price, 'level:' + l.label); });
  targets.sort((a, b) => a.rr - b.rr).forEach((t, i) => { t.name = 'TP' + (i + 1); t.hit = i < state.tpsHit; });
  const optimized = targets.find((t) => t.rr >= 2 && !t.source.startsWith('gainz')) || targets.find((t) => t.rr >= 2) || targets[0] || null;
  const zoneBlock = work && levelPool.find((l) => l.top != null && l.direction === (dir > 0 ? 'bullish' : 'bearish') && Math.abs(l.price - entry) <= atr);
  return {
    direction: sig.signal, signalTs: sig.ts, entry: r8(entry), entryZone: { low: r8(entry - atr * 0.2), high: r8(entry + atr * 0.2), basis: '±0.2 ATR around the signal close' },
    optimalEntry: zoneBlock ? { price: r8(zoneBlock.price), source: zoneBlock.label, zone: { low: zoneBlock.bottom, high: zoneBlock.top } } : null,
    stopLoss: p.stopLoss, risk: r8(risk), riskAtr: r8(risk / atr), targets, rrOptimized: optimized ? { name: optimized.name, rr: optimized.rr } : null,
    trailingStop: trail, invalidation: { price: p.stopLoss, reason: 'Close beyond the stop invalidates the setup' }, state: state.state, tpsHit: state.tpsHit,
    source: { module: 'chart-intelligence/engine', method: 'gainz-risk-plan + level-derived targets', basis: 'engine', inputs: { atr: r8(atr), minRR: cfg.minRR } }
  };
}

function buildEntryAssessment({active,plan,smc,work,atr,confluence,conflictSeverity,chainDex,institutional,sessionContext,fvgLiquidity,crossExchangeFlows,walletAttributionContext,eventImpact,bisFlows}){
 const direction=active?.signal==='BUY'?'bullish':active?.signal==='SELL'?'bearish':null,dir=direction==='bullish'?1:direction==='bearish'?-1:0;
 if(!active)return{status:'no-confirmed-signal',direction:null,qualityScore:0,entryZone:null,trigger:'Wait for the GainzAlpha engine to confirm a closed-candle signal.',reasons:['No confirmed BUY/SELL signal exists.'],invalidation:null};
 const last=work.at(-1),price=last?.[4],items=smc.items||[];
 if(Number(active.trade?.bars||0)>0)return{status:'manage-existing-position',direction,qualityScore:0,entryZone:null,currentPrice:price,trigger:'The signal has already progressed beyond its entry candle. Manage the existing position using its stop, targets and trailing-stop rules; do not treat this as a fresh entry.',reasons:['An active trade is already in progress.'],invalidation:active.riskPlan?.stopLoss??null};
 const zones=items.filter(i=>i.top!=null&&i.bottom!=null&&i.top>i.bottom&&i.direction===direction&&['orderBlocks','fvg','smc'].includes(i.layer)&&['ORDER_BLOCK','MITIGATION_BLOCK','FVG','IFVG','OTE_BULLISH','OTE_BEARISH'].includes(i.kind)&&!['breaker','filled','invalidated'].includes(i.status));
 const linkedSetup=(fvgLiquidity?.setups||[]).filter(s=>s.direction===direction&&['awaiting-retest','retest-observed','retest-in-zone'].includes(s.state)).sort((a,b)=>b.score-a.score)[0]||null;
 const linkedFvg=linkedSetup?items.find(i=>i.kind==='FVG'&&i.ts===linkedSetup.fvg.ts&&i.direction===direction):null;
 const zone=linkedFvg||[...zones].sort((a,b)=>Math.abs((a.top+a.bottom)/2-price)-Math.abs((b.top+b.bottom)/2-price))[0]||null;
 const inZone=!!zone&&price<=zone.top+atr*.2&&price>=zone.bottom-atr*.2;
 const recent=(layer,kind)=>items.filter(i=>(!layer||i.layer===layer)&&(!kind||i.kind===kind)&&i.direction===direction&&last[0]-i.ts<=12*(work.length>1?Math.max(1,work.at(-1)[0]-work.at(-2)[0]):3600000));
 const sweep=recent('sweeps','LIQUIDITY_SWEEP').at(-1)||null;
 const structure=items.filter(i=>i.layer==='structure'&&i.direction===direction&&last[0]-i.ts<=12*(work.at(-1)[0]-work.at(-2)[0])).at(-1)||null;
 const displacement=recent('smc','DISPLACEMENT').at(-1)||null;
 const mtf=confluence.components.find(x=>x.key==='mtf'),dex=chainDex?.status==='ready'&&chainDex.confidence>=.45&&chainDex.score*dir>=.15,inst=institutional?.status==='ready'&&institutional.confidence>=.45&&institutional.score*dir>=.15;
 const reasons=[];if(chainDex?.status==='ready'&&chainDex.score*dir<=-.15)reasons.push('Confirmed DEX swap flow opposes the proposed direction.');if(institutional?.status==='ready'&&institutional.score*dir<=-.15)reasons.push('Institutional and macro evidence opposes the proposed direction.');if(!zone)reasons.push('No nearby active directional order block, FVG or OTE zone.');if(!linkedSetup)reasons.push('No qualified same-direction sweep-to-displacement-to-FVG relationship is currently mapped.');if(!sweep)reasons.push('No recent same-direction liquidity sweep.');if(!structure)reasons.push('No recent same-direction BOS, CHoCH or MSS confirmation.');if(!displacement)reasons.push('No recent same-direction displacement candle.');if(!inZone)reasons.push('Price has not returned to the selected entry zone.');if(conflictSeverity>=3)reasons.push('Severe independent-evidence conflict blocks the setup.');if(institutional?.eventRisk?.active)reasons.push('Recent high-impact geopolitical or financial headlines are active; wait for post-event confirmation.');if(eventImpact?.active&&eventImpact.impactScore>=60)reasons.push('The event-impact model detects an elevated volatility-risk window; wait for post-event confirmation.');
 let quality=0;quality+=Math.max(0,Math.min(25,Math.abs(confluence.score*dir)*25));quality+=zone?12:0;quality+=linkedSetup?Math.round(8*linkedSetup.score/100):0;quality+=sweep?12:0;quality+=structure?12:0;quality+=displacement?8:0;quality+=inZone?8:0;quality+=dex?5:0;quality+=inst?5:0;quality+=crossExchangeFlows?.status==='ready'&&crossExchangeFlows.confidence>=.4&&crossExchangeFlows.score*dir>.15?4:0;quality+=walletAttributionContext?.flows?.status==='ready'&&(walletAttributionContext.flows.attributedTrades||walletAttributionContext.flows.verifiedTrades||0)>=3&&walletAttributionContext.flows.score*dir>.15?4:0;quality-=Math.min(30,conflictSeverity*10);quality-=institutional?.eventRisk?.severity>=2?8:institutional?.eventRisk?.active?4:0;quality=Math.max(0,Math.min(100,Math.round(quality)));
 const status=conflictSeverity>=3?'blocked-conflict':eventImpact?.impactScore>=80?'event-risk-caution':institutional?.eventRisk?.severity>=2?'event-risk-caution':!zone?'wait-for-location':!sweep?'wait-for-liquidity-sweep':!structure?'wait-for-structure':!displacement?'wait-for-displacement':!linkedSetup?'wait-for-fvg-liquidity-link':!inZone?'wait-for-retest':quality>=70?'ready-for-review':'wait-for-confluence';
 return{status,direction,qualityScore:quality,entryZone:zone?{low:zone.bottom,high:zone.top,mid:Number(((zone.bottom+zone.top)/2).toFixed(8)),kind:zone.kind,source:zone.source?.method||zone.layer}:null,fvgLiquiditySetup:linkedSetup,plannedEntry:plan?.entry??(zone?(zone.top+zone.bottom)/2:null),stopLoss:plan?.stopLoss??active.riskPlan?.stopLoss??null,targets:plan?.targets||[],currentPrice:price,inZone,confirmations:{liquiditySweep:!!sweep,structureBreak:!!structure,displacement:!!displacement,linkedFvgLiquidity:!!linkedSetup,fvgLiquidityScore:linkedSetup?.score??null,dexFlow:dex,institutional:inst,crossExchange:!!(crossExchangeFlows?.status==='ready'&&crossExchangeFlows.score*dir>.15),verifiedWalletFlow:!!(walletAttributionContext?.flows?.status==='ready'&&walletAttributionContext.flows.score*dir>.15),mtf:!!(mtf?.available&&mtf.value*dir>.15)},trigger:'Require a closed-candle rejection or displacement from the selected zone, then re-check the risk plan.',invalidation:active.riskPlan?.stopLoss??null,reasons,gradeNote:'Quality score is a rule-based checklist score, not a win probability. A ready-for-review state is not an order.'};
}

export function analyzeChartIntelligence(candles, opts = {}) {
  const { exchange = 'unknown', symbol = 'unknown', timeframe = 'unknown', now = Date.now(), gainz = null, higherTimeframes = [], outcomes = [], flow = null, liquidationFeed = null, externalLevels = [], institutionalContext = null, chainDexContext = null, sessionContext = null, crossExchangeFlows = null, bisFlows = null, walletAttributionContext = null, eventImpact = null, smtDivergence = null, settings = {}, ledger = null, historyBars = 60, preset, overrides } = opts;
  const rows = normalizeCandles(candles), { closed, forming } = splitClosed(rows, timeframe, now), work = closed.slice(-1000);
  const base = { status: 'insufficient', module: MODULE_VERSION, symbol, timeframe, exchange, layers: {}, signals: [], plan: null, conflicts: [], alerts: [], provenance: [] };
  if (work.length < 60) return { ...base, reason: 'Need 60 closed candles, have ' + work.length };
  const atrS = atrSeries(work, 14), atr = atrS[work.length - 1], last = work.length - 1, price = work[last][4], tf = timeframeMs(timeframe);
  if (!atr) return { ...base, reason: 'ATR unavailable' };
  const cfg = resolvePreset(preset, overrides);

  // Anchors for anchored VWAP / profile: last swing high, last swing low, last structure break.
  const sw = findSwings(work, 3), st = structureEvents(work, sw), anchors = [];
  const lh = sw.highs[sw.highs.length - 1], ll = sw.lows[sw.lows.length - 1], le = st.events[st.events.length - 1];
  if (lh) anchors.push({ kind: 'swing-high', ts: lh.ts }); if (ll) anchors.push({ kind: 'swing-low', ts: ll.ts }); if (le) anchors.push({ kind: le.kind.toLowerCase(), ts: le.ts });

  const profile = profileLevels(work, { timeframe, atr, anchors }), volume = volumeProfile(work.slice(-300), { bins: 64, valueAreaPct: 0.7 }), sr = supportResistance(work, { atr });
  const smc = analyzeSmc(work), of = analyzeOrderFlow(work, { flow }), liq = analyzeLiquidation(work, { feed: liquidationFeed });
  const candleFormation = analyzeCandleFormation(work, { atrSeries: atrS, lookback: 120 });
  const regime = detectRegime(work, atrS), rcfg = adaptiveConfig(regime), mtf = mtfBias(higherTimeframes, now);
  const institutional = scoreInstitutionalContext(institutionalContext, { now });
  const chainDex = scoreChainDexContext(chainDexContext, { now });
  const fvgLiquidity = analyzeFvgLiquidity(smc, work, { atr, timeframeMs: tf || 60_000, now });
  const fvgLiquidityScore = scoreFvgLiquidityForConfluence(fvgLiquidity, null);

  // Predictive level strength: shrink an a-priori strength toward the measured reaction rate of that very level.
  const K = 4, strengthen = (it) => { if (it.top != null || !Number.isFinite(it.price)) return it; const idx = Math.max(0, work.findIndex((c) => c[0] >= it.ts)); const rs = reactionStats(work, it.price, atr, { fromIndex: idx }); const prior = it.strength ?? 0.5; const s = ((rs.reactions) + K * prior) / (rs.touches + K); return { ...it, strength: r8(s), reaction: { touches: rs.touches, reactions: rs.reactions, rate: r8(rs.rate) }, source: { ...it.source, inputs: { ...it.source.inputs, touches: rs.touches, reactions: rs.reactions } } }; };
  const profileS = profile.map(strengthen);

  const conf = scoreComponents({ price, atr, smc, levels: profileS, sr, flow: of, liq, mtf, institutional, chainDex, sessionContext, fvgLiquidityScore, crossExchangeFlows, walletAttributionContext, smtDivergence, regimeCfg: rcfg });
  const scoreDir = Math.abs(conf.score) >= rcfg.minScore ? Math.sign(conf.score) : 0;

  // Signals: ledger (frozen) + walk-forward for bars not yet recorded. The live bar uses the hub's confirmed result.
  const ctxKey = [exchange, symbol, timeframe].join('|'), gopts = { preset, overrides };
  let rec = ledger ? ledger.get(ctxKey) : null;
  if (!rec) rec = { observedFrom: work[last][0], lastObserved: null, signals: {} };
  const nextIdx = rec.lastObserved == null ? -1 : work.findIndex((c) => c[0] > rec.lastObserved);
  const startIdx = rec.lastObserved == null ? Math.max(60, last - historyBars + 1) : nextIdx < 0 ? last + 1 : Math.max(60, nextIdx);
  const fresh = startIdx <= last ? walkForwardSignals(work, { symbol, exchange, timeframe }, { fromIndex: startIdx, gainzOptions: gopts }) : [];
  const live = gainz && gainz.confirmed && gainz.confirmed.status === 'ready' && ['BUY', 'SELL'].includes(gainz.confirmed.signal) && gainz.confirmed.riskPlan && gainz.confirmed.asOf === work[last][0] ? compactSignal(gainz.confirmed) : null;
  const incoming = [...fresh.filter((s) => !(live && s.ts === live.ts)), ...(live ? [live] : [])].sort((a, b) => a.ts - b.ts);
  const sigs = { ...rec.signals };
  for (const s of incoming) {
    if (sigs[s.ts]) continue;
    const recentSame = Object.values(sigs).some((x) => x.signal === s.signal && tf && s.ts > x.ts && s.ts - x.ts < cfg.cooldownBars * tf);
    if (recentSame && !(live && s.ts === live.ts)) continue;
    sigs[s.ts] = s;
  }
  const keep = Object.values(sigs).sort((a, b) => a.ts - b.ts).slice(-400);
  rec = { observedFrom: rec.observedFrom, lastObserved: work[last][0], signals: Object.fromEntries(keep.map((s) => [s.ts, s])) };
  if (ledger) ledger.put(ctxKey, rec);
  const trades = keep.map((s) => ({ ...s, trade: evaluateTrade(s, work, { expireBars: cfg.expireBars * 3 }) }));
  const active = [...trades].reverse().find((t) => !t.trade.terminal) || null;

  // Conflicts + grade use the latest active signal's direction (or the confluence direction when there is no signal).
  const sigDir = active ? (active.signal === 'BUY' ? 1 : -1) : 0;
  const ext = (() => { const e = externalLevels.find((l) => /entry/i.test(l.label)), s = externalLevels.find((l) => /stop/i.test(l.label)); return e && s && Number.isFinite(+e.price) && Number.isFinite(+s.price) ? { direction: +e.price > +s.price ? 1 : -1 } : null; })();
  const cf = detectConflicts({ signalDir: sigDir, score: conf.score, minScore: rcfg.minScore, mtf, flow: of, dealing: smc.dealingRange, external: ext, institutional, chainDex, fvgLiquidity, crossExchangeFlows, walletAttributionContext, smtDivergence, eventImpact, bisFlows, eventRisk: institutional?.eventRisk });
  const agreeing = conf.components.filter((c) => c.available && c.value * (sigDir || scoreDir || 1) >= 0.25).length, total = conf.components.filter((c) => c.available).length;
  const gz = gainz && gainz.confirmed && gainz.confirmed.status === 'ready' ? gainz.confirmed : null;
  const expectancy = summarize(outcomes, { symbol, timeframe, preset: cfg.id });
  const grade = sigDir ? gradeSetup({ score: conf.score * sigDir, agreeing, total, mtf, conflictSeverity: cf.severity, confidence: active.confidence, expectancy }) : null;
  const severe = cf.severity >= 3;
  const display = !active ? { state: scoreDir ? 'WATCH-' + (scoreDir > 0 ? 'BUY' : 'SELL') : 'NEUTRAL', note: scoreDir ? 'Confluence leans ' + (scoreDir > 0 ? 'bullish' : 'bearish') + ' but the signal engine has not confirmed an entry' : 'No directional edge' } : severe ? { state: 'CONFLICT', note: cf.conflicts.map((c) => c.detail).join('; ') } : { state: active.signal, note: null };

  const trail = active && !severe ? trailingStop(work, active, { atr }) : null;
  const plan = active && !severe ? buildPlan(active, active.trade, work, atr, [...profileS, ...sr, ...smc.items.filter((i) => i.layer === 'liquidity')], cfg, trail) : null;
  const entryAssessment = buildEntryAssessment({ active, plan, smc, work, atr, confluence: conf, conflictSeverity: cf.severity, chainDex, institutional, sessionContext, fvgLiquidity, crossExchangeFlows, walletAttributionContext, eventImpact, bisFlows });
  const tradingAgents = evaluateTradingDeskAgents({ now, symbol, timeframe, active, plan, grade, confluence: conf, conflictSeverity: cf.severity, regime, mtf, smc, fvgLiquidity, flow: of, eventRisk: eventImpact, executionCosts: cfg.costs });

  // Layer assembly with caps, merging and stable ids.
  const cap = (arr, n) => arr.slice(-n);
  const observedLiquidityLevels = ['high','low'].map(side => { const level = sessionContext?.liquidity24h?.levels?.[side]; return { id: 'ROLLING_24H|' + side, layer: 'liquidity', kind: side === 'high' ? 'ROLLING_24H_HIGH' : 'ROLLING_24H_LOW', direction: side === 'high' ? 'buy-side' : 'sell-side', ts: work[last][0], price: level?.price, label: '24h observed ' + side, strength: 0.65, source: { module: 'session-liquidity-engine', method: 'exchange-ticker-or-closed-candle-rolling-window', basis: level?.source || 'unavailable' } }; }).filter(x => Number.isFinite(x.price));
  const observedSessionLevels = (sessionContext?.sessions || []).flatMap(x => [
    { id:'SESSION_OBSERVED|'+x.id+'|HIGH',layer:'liquidity',kind:'SESSION_OBSERVED_HIGH',direction:'buy-side',ts:work[last][0],price:x.observed?.high,label:x.name+' observed high',strength:.5,source:{module:'session-liquidity-engine',method:'current-session-closed-candle-range',basis:'observed'} },
    { id:'SESSION_OBSERVED|'+x.id+'|LOW',layer:'liquidity',kind:'SESSION_OBSERVED_LOW',direction:'sell-side',ts:work[last][0],price:x.observed?.low,label:x.name+' observed low',strength:.5,source:{module:'session-liquidity-engine',method:'current-session-closed-candle-range',basis:'observed'} }
  ].filter(z=>Number.isFinite(z.price)));
  const forecastLiquidityLevels = (sessionContext?.sessions || []).flatMap(x => [
    { id:'SESSION|'+x.id+'|HIGH',layer:'liquidity',kind:'SESSION_FORECAST_HIGH',direction:'buy-side',ts:work[last][0],price:x.forecast?.high,label:x.name+' forecast high',strength:.35,source:{module:'session-liquidity-engine',method:'historical-session-range-forecast',basis:'estimated-model',inputs:{confidence:x.confidence,samples:x.historySamples}} },
    { id:'SESSION|'+x.id+'|LOW',layer:'liquidity',kind:'SESSION_FORECAST_LOW',direction:'sell-side',ts:work[last][0],price:x.forecast?.low,label:x.name+' forecast low',strength:.35,source:{module:'session-liquidity-engine',method:'historical-session-range-forecast',basis:'estimated-model',inputs:{confidence:x.confidence,samples:x.historySamples}} }
  ].filter(z=>Number.isFinite(z.price)));
  const L = {
    candlePatterns: (candleFormation.patterns || []).map(p => ({ id: 'CANDLE|' + p.id, layer: 'candlePatterns', kind: p.kind, direction: p.direction, ts: p.ts, price: work.find(c => c[0] === p.ts)?.[4], label: p.kind.replaceAll('_',' '), strength: p.score / 100, score: p.score, detail: p.detail, source: p.source })),
    signals: trades.slice(-40).map((t) => ({ id: 'SIG|' + t.id, layer: 'signals', kind: t.signal, direction: t.signal === 'BUY' ? 'bullish' : 'bearish', ts: t.ts, price: t.signal === 'BUY' ? work.find((c) => c[0] === t.ts)?.[3] : work.find((c) => c[0] === t.ts)?.[2], label: t.signal + ' ' + t.confidence, confidence: t.confidence, outcome: t.trade.state, strength: t.confidence / 100, source: { module: 'gainz-alpha/engine', method: t.kind || 'confluence', basis: 'engine', inputs: { score: t.score, setupId: t.setupId } } })),
    profile: mergeNearLevels(profileS.filter((i) => !['VWAP', 'VWAP_BAND', 'AVWAP'].includes(i.kind)), atr), volumeNodes: [], vwap: profileS.filter((i) => ['VWAP', 'VWAP_BAND', 'AVWAP'].includes(i.kind)),
    sr: sr, liquidation: liq.items || [], orderflow: cap(of.items || [], 24),
    structure: cap(smc.items.filter((i) => i.layer === 'structure'), 14), orderBlocks: cap(smc.items.filter((i) => i.layer === 'orderBlocks' && i.status !== 'breaker-old'), 8),
    fvg: cap(smc.items.filter((i) => i.layer === 'fvg').map(i => { const linked = (fvgLiquidity.setups || []).find(s => s.fvg.ts === i.ts && s.direction === i.direction); return linked ? { ...i, liquiditySetupId: linked.id, liquiditySetupScore: linked.score, liquiditySetupState: linked.state, linkedSweepTs: linked.sweep.ts } : i; }), 10), liquidity: [...smc.items.filter((i) => i.layer === 'liquidity'), ...observedLiquidityLevels, ...observedSessionLevels, ...forecastLiquidityLevels], sweeps: cap(smc.items.filter((i) => i.layer === 'sweeps'), 8), smc: smc.items.filter((i) => i.layer === 'smc')
  };
  if (volume && volume.bins.length) {
    const vols = volume.bins.map((b) => b.volume).filter((v) => v > 0).sort((a, b) => a - b);
    const q25 = vols[Math.floor(Math.max(0, vols.length - 1) * 0.25)] || 0;
    const q75 = vols[Math.floor(Math.max(0, vols.length - 1) * 0.75)] || 0;
    L.volumeNodes = volume.bins.map((b, i, a) => {
      const left = a[i - 1]?.volume ?? -1, right = a[i + 1]?.volume ?? -1;
      const hvn = b.volume >= q75 && b.volume >= left && b.volume >= right;
      const lvn = b.volume > 0 && b.volume <= q25 && b.volume <= left && b.volume <= right;
      if (!hvn && !lvn) return null;
      return { id: ['VP', hvn ? 'HVN' : 'LVN', i].join('|'), layer: 'volumeNodes', kind: hvn ? 'HVN' : 'LVN', direction: 'neutral', ts: work[Math.max(0, work.length - 300)][0], price: r8(b.price), label: hvn ? 'HVN' : 'LVN', strength: r8(b.volume / (volume.totalVolume || 1)), source: { module: 'chart-intelligence/volume-profile', method: 'local-volume-node-quantiles', basis: 'ohlcv-distributed', inputs: { bin: i, q25, q75 } } };
    }).filter(Boolean).slice(-24);
  }
  if (plan) L.plan = [{ id: 'PLAN|' + plan.signalTs, layer: 'plan', kind: 'PLAN', ts: plan.signalTs, price: plan.entry, label: 'Trade plan', direction: plan.direction === 'BUY' ? 'bullish' : 'bearish', source: plan.source }];
  else L.plan = [];

  // Alerts: derived only from events on the latest closed bar; ids are stable so consumers can dedupe.
  const alerts = [], lastTs = work[last][0], A = (type, id, message, severity = 'info') => alerts.push({ id: [symbol, timeframe, type, id].join('|'), type, message, severity, ts: lastTs });
  if (active && active.ts === lastTs && !severe) A('signal', active.id, active.signal + ' signal at ' + active.riskPlan.entry + ' (grade ' + (grade ? grade.grade : 'n/a') + ')', 'signal');
  if (severe && active && active.ts === lastTs) A('conflict', active.id, 'Signal conflicted: ' + cf.conflicts[0].detail, 'warning');
  trades.filter((t) => t.trade.exitTs === lastTs).forEach((t) => A('trade-exit', t.id + '|' + t.trade.state, t.signal + ' signal ' + t.trade.state, t.trade.state.startsWith('stopped') ? 'warning' : 'signal'));
  smc.items.filter((i) => i.ts === lastTs && ['MSS', 'CHoCH', 'BOS', 'LIQUIDITY_SWEEP'].includes(i.kind)).forEach((i) => A('structure', i.id, i.label + ' ' + i.direction));
  const key = [...profileS, ...sr].filter((l) => l.top == null || l.kind === 'POC').filter((l) => ['POC', 'VWAP', 'PD_POC', 'VAH', 'VAL', 'PDH', 'PDL'].includes(l.kind));
  key.forEach((l) => { const pc = work[last - 1][4]; if ((pc - l.price) * (price - l.price) < 0) A('level-cross', l.id + '|' + lastTs, 'Price crossed ' + l.label + ' (' + l.price + ')'); });
  if (liq.cascade && liq.cascade.level === 'elevated') A('liquidation-risk', liq.cascade.exposedSide, 'Elevated liquidation cascade risk on the ' + liq.cascade.exposedSide + ' side (' + liq.cascade.basis + ')', 'warning');

  const bases = { liquidation: liq.basis, orderflow: of.basis };
  const provenance = LAYERS.map((l) => ({ layer: l, count: (L[l] || []).length, bases: [...new Set((L[l] || []).map((i) => i.source && i.source.basis).filter(Boolean))], methods: [...new Set((L[l] || []).map((i) => i.source && i.source.method).filter(Boolean))].slice(0, 6) }));
  return {
    status: 'ready', module: MODULE_VERSION, symbol, timeframe, exchange, asOf: lastTs, forming: forming ? forming[0] : null, atr: r8(atr), price,
    layers: L, volumeProfile: volume ? { poc: r8(volume.poc), vah: r8(volume.vah), val: r8(volume.val), totalVolume: r8(volume.totalVolume), low: r8(volume.low), high: r8(volume.high), bins: volume.bins.map((b) => ({ price: r8(b.price), volume: r8(b.volume) })) } : null, signals: trades, active: active ? { ...active, grade, display } : null, display, plan, grade, conflicts: cf.conflicts, conflictSeverity: cf.severity,
    confluence: { score: conf.score, direction: scoreDir, minScore: rcfg.minScore, agreeing, total, components: conf.components }, institutional, chainDex, fvgLiquidity, crossExchangeFlows, bisFlows, walletAttribution: walletAttributionContext, eventImpact, smtDivergence, sessionForecast: sessionContext, entryAssessment, tradingAgents, candleFormation, regime, adaptive: rcfg, mtf, smc: { trend: smc.trend, dealingRange: smc.dealingRange, magnets: smc.liquidity.magnets }, orderFlow: of.summary ? { ...of.summary, basis: of.basis } : null,
    liquidation: { basis: liq.basis, cascade: liq.cascade, heatmap: liq.heatmap }, expectancy, gainzStatus: gz ? { signal: gz.signal, confidence: gz.confidence, stage: gz.stage } : null, alerts, provenance, bases,
    method: 'Closed-candle analysis; signals frozen in a ledger so history never repaints. Estimated layers are labelled in provenance.'
  };
}

/** Walk-forward evaluation of the engine's own signals and grades (no lookahead, outcomes not fed back into the signals). */
export function runChartIntelligenceBacktest(candles, opts = {}) {
  const rows = normalizeCandles(candles), tf = timeframeMs(opts.timeframe), cfg = resolvePreset(opts.preset, opts.overrides);
  const sigs = walkForwardSignals(rows, { symbol: opts.symbol || 'unknown', exchange: opts.exchange || 'unknown', timeframe: opts.timeframe }, { fromIndex: 60, gainzOptions: { preset: opts.preset, overrides: opts.overrides } });
  const accepted = [];
  for (const s of sigs) if (!accepted.some((x) => x.signal === s.signal && tf && s.ts - x.ts < cfg.cooldownBars * tf)) accepted.push(s);
  const resolved = accepted.map((s) => ({ s, o: evaluateOutcome({ signal: s.signal, riskPlan: s.riskPlan }, rows.filter((c) => c[0] > s.ts), { window: cfg.expireBars * 3, costPct: 0 }) })).filter((x) => x.o.status === 'resolved');
  const R = resolved.map((x) => x.o.returnR), wins = resolved.filter((x) => x.o.returnR > 0).length;
  return { signals: accepted.length, resolved: resolved.length, wins, winRate: resolved.length ? r8(wins / resolved.length) : null, expectancyR: R.length ? r8(R.reduce((a, b) => a + b, 0) / R.length) : null, totalR: R.length ? r8(R.reduce((a, b) => a + b, 0)) : null, note: 'Entry at next open; stop checked before targets in a bar; outcomes do not influence signals.' };
}

/** Replay: the analysis exactly as it would have been displayed after bar `index` closed. */
export function analyzeAt(candles, index, opts = {}) {
  const rows = normalizeCandles(candles), tf = timeframeMs(opts.timeframe) || 0;
  if (index < 0 || index >= rows.length) throw new Error('index out of range');
  return analyzeChartIntelligence(rows.slice(0, index + 1), { ...opts, now: rows[index][0] + tf, gainz: null, ledger: null });
}

/** Structured evidence for the JPTI Alpha ensemble, risk engine and scanner. Pure mapping. */
export function toChartEvidence(r) {
  if (!r || r.status !== 'ready') return { source: 'chart-intelligence', available: false, reason: r?.reason || 'unavailable' };
  const a = r.active, dir = a && r.display.state === a.signal ? (a.signal === 'BUY' ? 1 : -1) : 0;
  return { source: 'chart-intelligence', available: true, version: r.module, direction: dir, state: r.display.state, grade: r.grade ? r.grade.grade : null, gradePoints: r.grade ? r.grade.points : null, confluenceScore: r.confluence.score, candleFormation: r.candleFormation ? { status: r.candleFormation.status, latest: r.candleFormation.latest, summary: r.candleFormation.summary } : null, fvgLiquidity: r.fvgLiquidity ? { status: r.fvgLiquidity.status, summary: r.fvgLiquidity.summary, setups: (r.fvgLiquidity.setups || []).slice(0, 10) } : null, crossExchangeFlows: r.crossExchangeFlows ? { status:r.crossExchangeFlows.status, score:r.crossExchangeFlows.score, confidence:r.crossExchangeFlows.confidence, venues:r.crossExchangeFlows.venues } : null, bisFlows: r.bisFlows ? { status:r.bisFlows.status, freshness:r.bisFlows.freshness, latest:r.bisFlows.latest, change:r.bisFlows.change } : null, walletAttribution: r.walletAttribution ? { status:r.walletAttribution.status, flows:r.walletAttribution.flows } : null, eventImpact: r.eventImpact ? { status:r.eventImpact.status, impactScore:r.eventImpact.impactScore, risk:r.eventImpact.risk, active:r.eventImpact.active, events:r.eventImpact.events?.slice(0,10) } : null, smtDivergence: r.smtDivergence || null, institutional: r.institutional ? { status: r.institutional.status, score: r.institutional.score, confidence: r.institutional.confidence, sourceCoverage: r.institutional.sourceCoverage, eventRisk: r.institutional.eventRisk, evidence: r.institutional.evidence, sources: (r.institutional.sources || []).map(x => ({ name: x.name, status: x.status })) } : null, chainDex: r.chainDex ? { status: r.chainDex.status, score: r.chainDex.score, confidence: r.chainDex.confidence, flow: r.chainDex.flow, evidence: r.chainDex.evidence, sources: (r.chainDex.sources || []).map(x => ({ name: x.name, status: x.status })), pools: r.chainDex.pools, recentTransactions: (r.chainDex.trades || []).slice(0, 20), poolCount: r.chainDex.poolCount, tradeCount: r.chainDex.tradeCount } : null, entryAssessment: r.entryAssessment || null, tradingAgents: r.tradingAgents || null, sessionForecast: r.sessionForecast ? { status: r.sessionForecast.status, directionalBias: r.sessionForecast.directionalBias, sessions: (r.sessionForecast.sessions || []).map(x => ({ id: x.id, forecast: x.forecast, confidence: x.confidence })) } : null, regime: r.regime.state, regimeAnalysis: r.regime, adaptive: r.adaptive, conflicts: r.conflicts.map((c) => c.id), conflictSeverity: r.conflictSeverity, cascadeRisk: r.liquidation.cascade ? r.liquidation.cascade.level : null, plan: r.plan ? { entry: r.plan.entry, stopLoss: r.plan.stopLoss, targets: r.plan.targets.map((t) => ({ price: t.price, rr: t.rr })) } : null, bases: r.bases };
}
