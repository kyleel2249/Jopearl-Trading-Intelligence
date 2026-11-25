// Agent Desk Live engine. Pure, runtime-safe (Node, browser, Cloudflare). It only READS data:
// it maps the real JPTI specialist fleet (agent-fleet-engine) and the PAPER ledger payload
// (/api/paper/overview) into display state. It creates no orders and has no network access.
import { AGENT_CATALOG, runAgentFleet } from './agent-fleet-engine.js';
import { derivePaperSignal, PAPER_POLICY } from './paper-trading-engine.js';

export const DESK_MODE = Object.freeze({ mode: 'PAPER_ONLY', liveExecutionAuthorized: false, ordersCreated: 0 });
export const DESK_AGENTS = Object.freeze(AGENT_CATALOG.map(([id, name]) => Object.freeze({ id, name })));
const LOG_LIMIT = 60, TICKET_LIMIT = 12, HISTORY_LIMIT = 240;

const num = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Valid, time-sorted, de-duplicated [t,o,h,l,c,v] rows. Never fabricates a candle. */
export function normalizeCandles(rows) {
  const seen = new Set(), out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const r = row.slice(0, 6).map(Number);
    if (!r.every(Number.isFinite) || r[1] <= 0 || r[2] < r[3] || seen.has(r[0])) continue;
    seen.add(r[0]); out.push(r);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Builds fleet evidence only from supplied data. `candlesByTimeframe` needs a '5m' (or any) series;
 * extra timeframes feed timeframeAlignment. `market` is the optional /context payload:
 * orderBookImbalancePct (percent) and fundingRate. Anything missing stays missing, so the fleet
 * reports insufficient_evidence instead of guessing.
 */
export function buildFleetEvidence(candlesByTimeframe = {}, market = null, observedAt = Date.now()) {
  const series = Object.fromEntries(Object.entries(candlesByTimeframe).map(([k, v]) => [k, normalizeCandles(v)]));
  const baseKey = series['5m']?.length ? '5m' : Object.keys(series).find((k) => series[k].length);
  if (!baseKey) return { evidence: null, signal: null, reason: 'No valid candles supplied.' };
  const others = Object.fromEntries(Object.entries(series).filter(([k]) => k !== baseKey));
  const signal = derivePaperSignal(series[baseKey], {}, 'ensemble', { timeframes: others });
  const f = signal.features;
  if (!f) return { evidence: null, signal, reason: signal.reason };
  const sign = Math.sign(f.momentumPct), biases = Object.values(f.timeframeBias || {}).filter((v) => v !== 0);
  const evidence = {
    timestamp: new Date(observedAt).toISOString(), momentumPct: f.momentumPct, relativeVolume: f.relativeVolume,
    volatilityPct: f.atrPct, timeframeAlignment: biases.length && sign ? biases.reduce((s, v) => s + v * sign, 0) / biases.length : null,
    depthImbalance: num(market?.orderBookImbalancePct) === null ? null : clamp(num(market.orderBookImbalancePct) / 100, -1, 1),
    fundingRate: num(market?.fundingRate),
    sources: [{ id: 'jpti-ohlcv:' + baseKey, status: 'ok', required: true }]
  };
  for (const key of Object.keys(evidence)) if (evidence[key] === null) delete evidence[key];
  return { evidence, signal, reason: null };
}

/** Runs the real deterministic specialist fleet and returns the desk events it implies. */
export function fleetEvents(symbol, evidence, now = Date.now()) {
  const result = runAgentFleet({ symbol, evidence }, now, { maxAgeMs: 120000 });
  const time = new Date(now).toISOString().slice(11, 16);
  const events = result.agents.map((a) => ({ type: 'agent', data: { id: a.id, status: a.status, score: a.score, confidence: a.confidence, rationale: a.rationale } }));
  events.push({ type: 'log', data: result.risk.blocked
    ? { time, kind: 'BLOCK', symbol: result.symbol || symbol, text: result.risk.reasons.join('; ') || 'Risk gate blocked the setup' }
    : { time, kind: 'SCAN', symbol: result.symbol || symbol, text: result.consensus.stance + ' · ' + result.recommendedAction } });
  events.push({ type: 'consensus', data: { stance: result.consensus.stance, action: result.recommendedAction, confidence: result.consensus.confidence, blocked: result.risk.blocked, evaluated: result.consensus.evaluatedAgents, total: result.consensus.totalAgents } });
  return { result, events };
}

const hhmm = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString().slice(11, 16) : '--:--'; };

/** Maps the /api/paper/overview payload to events. `seen` (a Set) de-duplicates trade events across polls. */
export function paperEvents(overview, seen = new Set()) {
  const isObj = (v) => v !== null && typeof v === 'object';
  const agents = (Array.isArray(overview?.agents) ? overview.agents : []).filter(isObj);
  const events = [], equity = agents.reduce((s, a) => s + (num(a.metrics?.equityUsd) ?? PAPER_POLICY.initialEquityUsd), 0);
  const sum = (k) => agents.reduce((s, a) => s + (num(a.metrics?.[k]) ?? 0), 0);
  events.push({ type: 'mode', data: { mode: overview?.mode === 'PAPER_ONLY' ? 'PAPER' : 'UNVERIFIED' } });
  events.push({ type: 'tick', data: { balance: equity, start: agents.length * PAPER_POLICY.initialEquityUsd, wins: sum('wins'), losses: sum('losses'), trades: sum('closedTrades'), time: hhmm(overview?.updatedAt), at: Date.parse(overview?.updatedAt) || Date.now() } });
  events.push({ type: 'seats', data: agents.map((a) => ({ id: a.id, name: a.name, role: a.role || a.edge || '', tier: a.tier || 'RESEARCH', status: a.status || 'active',
    winRatePct: num(a.metrics?.winRatePct) ?? 0, open: Array.isArray(a.openTrades) ? a.openTrades.length : 0, loadPct: clamp((Array.isArray(a.openTrades) ? a.openTrades.length : 0) / PAPER_POLICY.maxConcurrentPerAgent * 100, 0, 100), netPnlUsd: num(a.metrics?.netPnlUsd) ?? 0 })) });
  const trades = agents.flatMap((a) => [...(Array.isArray(a.openTrades) ? a.openTrades : []), ...(Array.isArray(a.recentTrades) ? a.recentTrades : [])].filter(isObj).map((t) => ({ ...t, agentName: a.name })));
  const unique = new Map(trades.map((t) => [String(t.tradeId || t.trade_id) + ':' + t.status, t]));
  const fresh = [...unique.entries()].filter(([key]) => !seen.has(key)).map(([key, t]) => ({ key, t }))
    .sort((a, b) => Date.parse(a.t.closedAt || a.t.openedAt) - Date.parse(b.t.closedAt || b.t.openedAt));
  for (const { key, t } of fresh) {
    seen.add(key);
    const entry = num(t.entryPrice ?? t.entry_price), exit = num(t.exitPrice), dir = t.direction === 'SHORT' ? -1 : 1, symbol = String(t.symbol || '—');
    if (t.status === 'closed') {
      const pnl = num(t.netPnlUsd) ?? 0, pct = entry && exit ? (exit / entry - 1) * dir : 0;
      events.push({ type: 'log', data: { time: hhmm(t.closedAt), kind: pnl >= 0 ? 'TARGET' : 'STOP', symbol, text: t.agentName + ' · ' + (pct * 100).toFixed(2) + '%', pnl } });
      events.push({ type: 'ticket', data: { symbol, entry: entry ?? 0, exit: exit ?? 0, pct, size: (num(t.quantity) ?? 0) * (entry ?? 0), pnl, agent: t.agentName, key } });
    } else if (t.status === 'open') {
      events.push({ type: 'log', data: { time: hhmm(t.openedAt), kind: 'OPEN', symbol, text: t.agentName + ' · ' + (t.direction || '') } });
    }
  }
  if (seen.size > 5000) seen.clear();
  return events;
}

export function initialDeskState() {
  return { mode: 'PAPER', balance: null, start: null, wins: 0, losses: 0, trades: 0, history: [], agents: {}, active: null, consensus: null, seats: [], log: [], tickets: [] };
}

/** Pure reducer. Unknown events are ignored, so a malformed payload can never throw in render. */
export function reduceDesk(state, ev) {
  if (!ev || typeof ev.type !== 'string') return state;
  const d = ev.data;
  switch (ev.type) {
    case 'mode': return { ...state, mode: d.mode };
    case 'tick': {
      const point = num(d.balance);
      const startValue = num(d.start), at = Number.isFinite(d.at) ? d.at : Date.now();
      // The curve begins at the real starting capital so a single poll still draws a line.
      const seedPoint = state.history.length === 0 && startValue !== null && point !== null ? [{ at: at - 1, v: startValue }] : [];
      const history = point === null ? state.history : [...state.history, ...seedPoint, { at, v: point }].slice(-HISTORY_LIMIT);
      return { ...state, balance: point, start: num(d.start), wins: d.wins, losses: d.losses, trades: d.trades, history };
    }
    case 'restore': {
      const history = (Array.isArray(d?.history) ? d.history : []).filter((p) => p && Number.isFinite(p.v) && Number.isFinite(p.at)).slice(-HISTORY_LIMIT);
      return state.history.length ? state : { ...state, history };
    }
    case 'seats': return { ...state, seats: d };
    case 'agent': return { ...state, agents: { ...state.agents, [d.id]: d } };
    case 'activate': return { ...state, active: d.id };
    case 'consensus': return { ...state, consensus: d };
    case 'log': return { ...state, log: [d, ...state.log].slice(0, LOG_LIMIT) };
    case 'ticket': return { ...state, tickets: [d, ...state.tickets].slice(0, TICKET_LIMIT) };
    default: return state;
  }
}
