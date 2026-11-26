// Turns department handoff messages into operator alerts. Only high/urgent unread handoffs
// raise alerts, and each one is raised once per browser (seen ids persist locally).
export const HANDOFF_SEEN_KEY = 'jpti.handoff-alerts.seen.v1';
export const PRIORITY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };

export function selectHandoffAlerts(messages, seen = [], { minPriority = 'high' } = {}) {
  const min = PRIORITY_RANK[minPriority] ?? 2; const seenSet = new Set(seen);
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && m.id && (m.status === undefined || m.status === 'unread') && (PRIORITY_RANK[m.priority] ?? 1) >= min)
    .map((m) => ({ id: m.id, priority: m.priority, from: m.from, to: m.to, subject: String(m.subject || '').slice(0, 180), body: String(m.body || '').slice(0, 600), createdAt: m.createdAt, isNew: !seenSet.has(m.id) }))
    .sort((a, b) => (PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

export const describeHandoff = (a) => '[' + String(a.priority).toUpperCase() + '] ' + a.from + ' → ' + a.to + ': ' + a.subject;

export function readSeen(storage) { try { const v = JSON.parse(storage?.getItem(HANDOFF_SEEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
export function writeSeen(storage, ids) { try { storage?.setItem(HANDOFF_SEEN_KEY, JSON.stringify([...new Set(ids)].slice(-500))); } catch { /* storage unavailable */ } }
