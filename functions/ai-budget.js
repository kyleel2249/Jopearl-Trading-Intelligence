// Soft spending guard for Workers AI. Every guarded call is already logged in
// jpti_agent_output_quality (attempts = real model calls), so usage is the sum of attempts in a
// rolling window. Limits come from env vars; "unlimited" disables a cap. The check is a soft cap
// (concurrent requests can overshoot slightly) and fails OPEN if telemetry is unreadable, so an
// observability fault never stops research - the failure is reported in the result instead.
import { ensureOutputQualityTable } from './output-quality.js';

export const DEFAULT_HOURLY_LIMIT = 60;
export const DEFAULT_DAILY_LIMIT = 400;

export function parseLimit(value, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'unlimited' || text === 'off') return Infinity;
  const n = Number(text);
  return text !== '' && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function evaluateBudget({ hourlyUsed, dailyUsed, hourlyLimit, dailyLimit, needed = 1 }) {
  const hourlyOk = hourlyUsed + needed <= hourlyLimit;
  const dailyOk = dailyUsed + needed <= dailyLimit;
  const scope = !hourlyOk ? 'hourly' : !dailyOk ? 'daily' : null;
  return { ok: hourlyOk && dailyOk, scope, hourly: { used: hourlyUsed, limit: hourlyLimit }, daily: { used: dailyUsed, limit: dailyLimit } };
}

export async function checkAiBudget(db, env = {}, { needed = 1, now = Date.now() } = {}) {
  const hourlyLimit = parseLimit(env.JPTI_AI_HOURLY_LIMIT, DEFAULT_HOURLY_LIMIT);
  const dailyLimit = parseLimit(env.JPTI_AI_DAILY_LIMIT, DEFAULT_DAILY_LIMIT);
  try {
    await ensureOutputQualityTable(db);
    const since = (ms) => new Date(now - ms).toISOString();
    const row = await db.prepare('SELECT COALESCE(SUM(CASE WHEN created_at>=? THEN attempts ELSE 0 END),0) AS h, COALESCE(SUM(attempts),0) AS d FROM jpti_agent_output_quality WHERE created_at>=?').bind(since(3600000), since(86400000)).first();
    return { ...evaluateBudget({ hourlyUsed: Number(row?.h) || 0, dailyUsed: Number(row?.d) || 0, hourlyLimit, dailyLimit, needed }), measured: true };
  } catch (error) {
    return { ok: true, scope: null, measured: false, unavailable: String(error?.message || error).slice(0, 120), hourly: { used: null, limit: hourlyLimit }, daily: { used: null, limit: dailyLimit } };
  }
}

export async function assertAiBudget(db, env, options) {
  const budget = await checkAiBudget(db, env, options);
  if (budget.ok) return budget;
  const window = budget[budget.scope];
  throw Object.assign(new Error('AI call budget reached: ' + window.used + ' of ' + window.limit + ' model calls used in the ' + (budget.scope === 'hourly' ? 'last hour' : 'last 24 hours') + '. Work stays queued; retry later or raise JPTI_' + (budget.scope === 'hourly' ? 'AI_HOURLY' : 'AI_DAILY') + '_LIMIT.'), { status: 429, budget });
}
