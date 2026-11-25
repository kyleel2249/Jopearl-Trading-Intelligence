// Stateful trading circuit breaker. Pure and immutable: every function returns a new state.
// Trips on drawdown (manual resume), daily loss (resumes next UTC day) and consecutive
// losses (resumes after a cooldown). Persisting the state is the caller's responsibility.

export const DEFAULT_BREAKER_CONFIG = Object.freeze({ maxDrawdownPct: 5, maxDailyLossPct: 2, maxConsecutiveLosses: 4, cooldownMs: 3600000, historyLimit: 50 });

const finite = (v) => Number.isFinite(Number(v)) && v !== null && v !== '' && v !== undefined;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextUtcDay = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

export function createBreaker(startEquity, config = {}, now = Date.now()) {
  if (!finite(startEquity) || Number(startEquity) <= 0) throw new TypeError('startEquity must be a positive number.');
  const cfg = { ...DEFAULT_BREAKER_CONFIG, ...config };
  return {
    config: cfg, status: 'closed', reasons: [], trippedAt: null, resumeAt: null, manualResumeRequired: false,
    peakEquity: Number(startEquity), equity: Number(startEquity), dayKey: dayKey(now), dayStartEquity: Number(startEquity),
    consecutiveLosses: 0, history: []
  };
}

const log = (state, event) => [...state.history, event].slice(-state.config.historyLimit);

export function recordTrade(state, { pnl, equity, at = Date.now() } = {}) {
  if (!finite(pnl) || !finite(equity) || Number(equity) <= 0) throw new TypeError('pnl and a positive equity are required.');
  const e = Number(equity), p = Number(pnl);
  let s = { ...state, equity: e };
  if (dayKey(at) !== s.dayKey) s = { ...s, dayKey: dayKey(at), dayStartEquity: e - p };
  s.peakEquity = Math.max(s.peakEquity, e);
  s.consecutiveLosses = p < 0 ? s.consecutiveLosses + 1 : p > 0 ? 0 : s.consecutiveLosses;

  const cfg = s.config, reasons = [];
  const drawdownPct = (s.peakEquity - e) / s.peakEquity * 100;
  const dailyLossPct = s.dayStartEquity > 0 ? Math.max(0, (s.dayStartEquity - e) / s.dayStartEquity * 100) : 0;
  let resumeAt = null, manual = false;
  if (drawdownPct >= cfg.maxDrawdownPct) { reasons.push(`drawdown ${drawdownPct.toFixed(2)}% >= ${cfg.maxDrawdownPct}%`); manual = true; }
  if (dailyLossPct >= cfg.maxDailyLossPct) { reasons.push(`daily loss ${dailyLossPct.toFixed(2)}% >= ${cfg.maxDailyLossPct}%`); resumeAt = nextUtcDay(at); }
  if (s.consecutiveLosses >= cfg.maxConsecutiveLosses) { reasons.push(`${s.consecutiveLosses} consecutive losses`); resumeAt = Math.max(resumeAt ?? 0, at + cfg.cooldownMs); }

  if (reasons.length && s.status === 'closed') {
    return { ...s, status: 'open', reasons, trippedAt: at, resumeAt: manual ? null : resumeAt, manualResumeRequired: manual, history: log(s, { type: 'trip', at, reasons, equity: e }) };
  }
  return s;
}

export function canTrade(state, now = Date.now()) {
  if (state.status === 'closed') return { allowed: true, status: 'closed', reasons: [], resumeAt: null };
  if (!state.manualResumeRequired && state.resumeAt !== null && now >= state.resumeAt) {
    return { allowed: true, status: 'auto_reset_due', reasons: [], resumeAt: null };
  }
  return { allowed: false, status: 'open', reasons: state.reasons, resumeAt: state.resumeAt, manualResumeRequired: state.manualResumeRequired };
}

// Apply an automatic reset once its time has passed (no-op otherwise). Call before trading.
export function tick(state, now = Date.now()) {
  if (canTrade(state, now).status !== 'auto_reset_due') return state;
  return { ...state, status: 'closed', reasons: [], trippedAt: null, resumeAt: null, consecutiveLosses: 0, dayKey: dayKey(now), dayStartEquity: state.equity, history: log(state, { type: 'auto_reset', at: now }) };
}

// Manual resume is mandatory after a drawdown trip. Resets the peak so the breaker does not re-trip immediately.
export function resume(state, { by, reason, at = Date.now() } = {}) {
  if (!by || !reason) throw new TypeError('resume requires `by` and `reason` for the audit trail.');
  if (state.status === 'closed') return state;
  return { ...state, status: 'closed', reasons: [], trippedAt: null, resumeAt: null, manualResumeRequired: false, peakEquity: state.equity, consecutiveLosses: 0, dayKey: dayKey(at), dayStartEquity: state.equity, history: log(state, { type: 'manual_resume', at, by, reason }) };
}
