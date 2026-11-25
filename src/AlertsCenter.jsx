import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from './lib/api.js';
import { PRODUCTS, productLabel } from './lib/bitget-search.js';
import { resolveInstrument, instrumentQuery } from './lib/bitget-instruments.js';
import { ALERT_TYPES, MAX_ALERTS, STORAGE_KEY, createAlert, evaluateAlerts, parseAlerts, quoteKey, serializeAlerts, describeAlert } from './lib/alerts.js';

const TYPE_LABEL = { price_above: 'Price crosses above', price_below: 'Price crosses below', level_touch: 'Touches level', pct_move: 'Moves by %' };
const POLL_MS = 15000;

async function fetchLast(alert) {
  const path = '/api/exchanges/' + alert.exchange + '/ticker/' + alert.symbol.replace('/', '-') + '?type=' + encodeURIComponent(alert.product) + instrumentQuery(alert.instrumentId) + (alert.product === 'cfd' ? '&side=buy' : '');
  const response = await apiFetch(path, { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !(Number(data.last) > 0)) throw new Error(data?.error || 'No price');
  return Number(data.last);
}

export default function AlertsCenter() {
  const [alerts, setAlerts] = useState(() => { try { return parseAlerts(localStorage.getItem(STORAGE_KEY)); } catch { return []; } });
  const [form, setForm] = useState({ type: 'price_above', product: 'futures', symbol: 'BTC/USDT', value: '', direction: 'either', tolerancePercent: '0.1', repeat: false, cooldownMinutes: '15', note: '' });
  const [log, setLog] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
  const [lastPoll, setLastPoll] = useState(null);
  const [pollErrors, setPollErrors] = useState(0);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, serializeAlerts(alerts)); } catch { /* storage unavailable */ } }, [alerts]);

  const notify = useCallback((message) => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { try { new Notification('JPTI alert', { body: message }); } catch { /* some browsers only allow service-worker notifications */ } }
  }, []);

  const poll = useCallback(async () => {
    const live = alertsRef.current.filter((a) => a.enabled);
    if (!live.length) return;
    const unique = new Map(live.map((a) => [quoteKey(a), a]));
    const quotes = {};
    let failures = 0;
    await Promise.all([...unique.entries()].map(async ([key, alert]) => { try { quotes[key] = await fetchLast(alert); } catch { failures += 1; } }));
    setPollErrors(failures);
    setLastPoll(Date.now());
    const result = evaluateAlerts(alertsRef.current, quotes, Date.now());
    setAlerts(result.alerts);
    if (result.triggered.length) { setLog((current) => [...result.triggered.map((t) => ({ ...t, id: t.alertId + t.at })), ...current].slice(0, 50)); result.triggered.forEach((t) => notify(t.message)); }
  }, [notify]);

  useEffect(() => { poll(); const timer = setInterval(poll, POLL_MS); return () => clearInterval(timer); }, [poll]);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const add = async (event) => {
    event.preventDefault();
    setError('');
    if (alerts.length >= MAX_ALERTS) { setError('Alert limit reached (' + MAX_ALERTS + ').'); return; }
    setBusy(true);
    try {
      let symbol = form.symbol.trim().toUpperCase();
      let instrumentId = '';
      try { const found = await resolveInstrument(apiFetch, form.product, symbol); if (found) { symbol = found.symbol; instrumentId = found.id; } } catch { /* catalogue unavailable: use the symbol as typed */ }
      const probe = { exchange: 'bitget', product: form.product, symbol, instrumentId };
      const price = await fetchLast(probe).catch(() => null);
      const { alert, error: problem } = createAlert({ ...form, ...probe }, price);
      if (problem) { setError(problem); return; }
      setAlerts((current) => [alert, ...current]);
      setForm((current) => ({ ...current, value: '', note: '' }));
      if (permission === 'default' && typeof Notification !== 'undefined') Notification.requestPermission().then(setPermission);
    } finally { setBusy(false); }
  };

  return <div className="ac-root">
    <section className="wb-card" aria-label="Create alert">
      <div className="wb-head"><b>NEW ALERT</b><small>Bitget · evaluated every {POLL_MS / 1000}s while this page is open</small></div>
      <form className="ac-form" onSubmit={add}>
        <label>Type<select value={form.type} onChange={set('type')}>{ALERT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
        <label>Product<select value={form.product} onChange={set('product')}>{PRODUCTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
        <label>Symbol<input value={form.symbol} onChange={set('symbol')} placeholder="BTC/USDT" required /></label>
        <label>{form.type === 'pct_move' ? 'Move %' : 'Price'}<input inputMode="decimal" value={form.value} onChange={set('value')} required /></label>
        {form.type === 'pct_move' && <label>Direction<select value={form.direction} onChange={set('direction')}><option value="either">Either way</option><option value="up">Up</option><option value="down">Down</option></select></label>}
        {form.type === 'level_touch' && <label>Tolerance %<input inputMode="decimal" value={form.tolerancePercent} onChange={set('tolerancePercent')} /></label>}
        <label>Cooldown (min)<input inputMode="numeric" value={form.cooldownMinutes} onChange={set('cooldownMinutes')} /></label>
        <label className="ac-check"><span>Repeat</span><input type="checkbox" checked={form.repeat} onChange={set('repeat')} /></label>
        <label>Note<input value={form.note} maxLength={80} onChange={set('note')} /></label>
        <button className="ac-btn" type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add alert'}</button>
      </form>
      {error && <p className="wb-note wb-warn" role="alert">{error}</p>}
      <small className="wb-note">Alerts fire on a crossing, not on a level already passed. They are checked only while this page is open in a browser; they do not run on a server and cannot wake a closed tab. Browser notifications: {permission === 'granted' ? 'enabled' : permission === 'denied' ? 'blocked in browser settings' : permission === 'unsupported' ? 'not supported here' : 'will be requested when you add your first alert'}. In-app alerts always appear below.</small>
    </section>
    <section className="wb-card" aria-label="Active alerts">
      <div className="wb-head"><b>ALERTS ({alerts.length})</b><small>{lastPoll ? 'Last check ' + new Date(lastPoll).toLocaleTimeString() : 'Waiting for first check'}{pollErrors ? ' · ' + pollErrors + ' quote(s) unavailable' : ''}</small></div>
      {alerts.length === 0 ? <p className="wb-note">No alerts yet.</p> : <div className="table-scroll"><table className="ac-table"><thead><tr><th>CONDITION</th><th>STATE</th><th>LAST PRICE</th><th>TRIGGERS</th><th /></tr></thead><tbody>{alerts.map((a) => <tr key={a.id}>
        <td>{describeAlert(a)}{a.note ? <small className="wb-note"> — {a.note}</small> : null}<br /><small className="wb-note">{productLabel(a.product)}{a.repeat ? ' · repeats, ' + a.cooldownMinutes + ' min cooldown' : ' · one-shot'}</small></td>
        <td className={a.enabled ? 'st-ok' : 'st-unknown'}>{a.enabled ? 'ARMED' : a.triggerCount ? 'TRIGGERED' : 'PAUSED'}</td>
        <td>{a.lastPrice ?? '—'}</td><td>{a.triggerCount}</td>
        <td><button className="ac-btn" type="button" onClick={() => setAlerts((c) => c.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled, lastPrice: null } : x)))}>{a.enabled ? 'Pause' : 'Re-arm'}</button> <button className="ac-btn" type="button" onClick={() => setAlerts((c) => c.filter((x) => x.id !== a.id))}>Delete</button></td>
      </tr>)}</tbody></table></div>}
    </section>
    <section className="wb-card" aria-label="Triggered alerts" aria-live="polite">
      <div className="wb-head"><b>TRIGGERED</b>{log.length > 0 && <button className="ac-btn" type="button" onClick={() => setLog([])}>Clear</button>}</div>
      {log.length === 0 ? <p className="wb-note">Nothing has triggered in this session.</p> : <div className="ac-log">{log.map((entry) => <div key={entry.id}><b>{new Date(entry.at).toLocaleTimeString()}</b> {entry.message}</div>)}</div>}
    </section>
  </div>;
}
