import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './lib/api.js';
import { describeHandoff, readSeen, selectHandoffAlerts, writeSeen } from './lib/handoff-alerts.js';

const POLL_MS = 60000;
const storage = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

// Raises operator alerts for high / urgent department handoffs that are still unread.
export default function HandoffAlerts({ notify }) {
  const [alerts, setAlerts] = useState([]);
  const [minPriority, setMinPriority] = useState('high');
  const [status, setStatus] = useState('Checking handoffs…');
  const [busyId, setBusyId] = useState('');
  const seenRef = useRef(readSeen(storage()));

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/intelligence-foundation/agents', { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { setStatus(response.status === 401 ? 'Enter the JPTI API token to receive handoff alerts.' : (data.error || 'Handoff alerts unavailable (HTTP ' + response.status + ').')); return; }
      const next = selectHandoffAlerts(data.messages, seenRef.current, { minPriority });
      const fresh = next.filter((a) => a.isNew);
      if (fresh.length && typeof notify === 'function') fresh.slice(0, 3).forEach((a) => notify(describeHandoff(a)));
      if (fresh.length) { seenRef.current = [...seenRef.current, ...fresh.map((a) => a.id)]; writeSeen(storage(), seenRef.current); }
      setAlerts(next);
      setStatus(next.length ? '' : 'No unread ' + minPriority + '-priority handoffs.');
    } catch (error) { setStatus('Handoff alerts unavailable: ' + String(error?.message || 'network error').slice(0, 100)); }
  }, [minPriority, notify]);

  useEffect(() => { load(); const timer = setInterval(load, POLL_MS); return () => clearInterval(timer); }, [load]);

  const markRead = async (id) => {
    setBusyId(id);
    try {
      const response = await apiFetch('/api/intelligence-foundation/agents/messages/' + encodeURIComponent(id) + '/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      setAlerts((current) => current.filter((a) => a.id !== id));
    } catch (error) { setStatus('Could not mark as read: ' + String(error?.message || 'error')); }
    finally { setBusyId(''); }
  };

  return <section className="wb-card" aria-label="Department handoff alerts" aria-live="polite">
    <div className="wb-head"><b>DEPARTMENT HANDOFFS</b>
      <label className="wb-note">Alert at <select value={minPriority} onChange={(e) => setMinPriority(e.target.value)}><option value="high">High and urgent</option><option value="urgent">Urgent only</option></select></label>
      <button className="ac-btn" type="button" onClick={load}>Refresh</button></div>
    {status && <p className="wb-note">{status}</p>}
    {alerts.length > 0 && <div className="ac-log">{alerts.map((a) => <div key={a.id} className={'handoff-alert handoff-' + a.priority}>
      <b>{a.priority.toUpperCase()}</b> <span>{a.from} → {a.to}</span>{a.isNew && <span className="ev-badge ev-unknown"> new</span>}
      <p><b>{a.subject}</b></p><p className="wb-note">{a.body}</p>
      <button className="ac-btn" type="button" disabled={busyId === a.id} onClick={() => markRead(a.id)}>{busyId === a.id ? 'Marking…' : 'Mark read'}</button>
    </div>)}</div>}
  </section>;
}
