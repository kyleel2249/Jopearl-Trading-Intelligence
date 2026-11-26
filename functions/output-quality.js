// Persists one row per guarded AI call so operators can see which agents drift into raw JSON.
// Recording is best-effort: a missing table or D1 hiccup must never fail an agent task.
import { outcomeOf, summarizeQuality } from '../src/lib/agent-output-guard.js';

const DDL = 'CREATE TABLE IF NOT EXISTS jpti_agent_output_quality(id TEXT PRIMARY KEY,agent_key TEXT NOT NULL,source TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,outcome TEXT NOT NULL,reasons TEXT,created_at TEXT NOT NULL)';

export const ensureOutputQualityTable = (db) => db.prepare(DDL).run();

export async function recordOutputQuality(db, { agentKey, source, result }) {
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    await db.prepare(DDL).run();
    await db.prepare('INSERT INTO jpti_agent_output_quality(id,agent_key,source,attempts,outcome,reasons,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), String(agentKey || 'unknown').slice(0, 120), String(source || 'agent').slice(0, 60), result.attempts, outcomeOf(result), (result.reasons || []).join(',').slice(0, 200), new Date().toISOString()).run();
    return true;
  } catch { return false; }
}

export async function readOutputQuality(db, limit = 1000) {
  try {
    await db.prepare(DDL).run();
    const rows = await db.prepare('SELECT agent_key,source,outcome,created_at FROM jpti_agent_output_quality ORDER BY created_at DESC LIMIT ?').bind(Math.max(1, Math.min(5000, limit))).all();
    const list = (rows.results || []).map((r) => ({ agentKey: r.agent_key, source: r.source, outcome: r.outcome }));
    const totals = list.reduce((t, r) => ({ ...t, [r.outcome]: (t[r.outcome] || 0) + 1 }), { clean: 0, repaired: 0, fallback: 0 });
    return { samples: list.length, totals, agents: summarizeQuality(list) };
  } catch (error) {
    return { samples: 0, totals: { clean: 0, repaired: 0, fallback: 0 }, agents: [], unavailable: String(error?.message || error).slice(0, 120) };
  }
}
