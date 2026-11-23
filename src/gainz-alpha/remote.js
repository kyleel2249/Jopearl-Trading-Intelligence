// Backend sync adapter for the hub: loads durable outcomes and pushes newly resolved ones. Best-effort and non-fatal.
export function createApiRemote(apiFetch) {
  return {
    async load({ symbol, timeframe } = {}) {
      const q = new URLSearchParams(); if (symbol) q.set('symbol', symbol); if (timeframe) q.set('timeframe', timeframe);
      const r = await apiFetch('/api/alpha/gainz/outcomes?' + q.toString(), { cache: 'no-store' });
      if (!r.ok) throw new Error('outcome load failed (HTTP ' + r.status + ')');
      const d = await r.json(); return Array.isArray(d.records) ? d.records : [];
    },
    async save(records) {
      const r = await apiFetch('/api/alpha/gainz/outcomes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) });
      if (!r.ok) throw new Error('outcome save failed (HTTP ' + r.status + ')');
      return r.json();
    }
  };
}
