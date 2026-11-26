import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from './lib/api.js';

const pct = (v) => Math.round((Number(v) || 0) * 100) + '%';

// Shows which agents needed their replies repaired or formatted by the fallback.
export default function OutputQualityPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [budget, setBudget] = useState(null);
  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/intelligence-foundation/agents/output-quality', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'HTTP ' + response.status);
      setData(body); setError('');
      const b = await apiFetch('/api/intelligence-foundation/agents/ai-budget', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      setBudget(b);
    } catch (e) { setError(String(e?.message || 'unavailable').slice(0, 120)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  return <details className="oq-panel">
    <summary>Agent output reliability{data?.samples ? ' · ' + pct(data.totals.clean / data.samples) + ' clean' : ''}</summary>
    {budget && <p className="subtle-note">AI calls: {budget.hourly.used ?? '?'} / {Number.isFinite(budget.hourly.limit) ? budget.hourly.limit : '∞'} this hour · {budget.daily.used ?? '?'} / {Number.isFinite(budget.daily.limit) ? budget.daily.limit : '∞'} today{budget.measured === false ? ' (usage unavailable)' : ''}{!budget.ok ? ' · LIMIT REACHED' : ''}</p>}
    {error && <p className="subtle-note">Unavailable: {error}</p>}
    {data && !data.samples && !error && <p className="subtle-note">No guarded agent calls recorded yet.</p>}
    {data?.samples > 0 && <>
      <p className="subtle-note">{data.samples} calls · {data.totals.clean} clean · {data.totals.repaired} auto-repaired · {data.totals.fallback} formatted by fallback</p>
      <table className="oq-table"><thead><tr><th>Agent</th><th>Calls</th><th>Clean</th><th>Repaired</th><th>Fallback</th></tr></thead>
        <tbody>{data.agents.slice(0, 12).map((a) => <tr key={a.agentKey}><td>{a.agentKey}</td><td>{a.calls}</td><td>{pct(a.cleanRate)}</td><td>{a.repaired}</td><td>{a.fellBack}</td></tr>)}</tbody></table>
    </>}
    <button type="button" className="small-refresh" onClick={load}>Refresh</button>
  </details>;
}
