import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getApiSource } from './lib/api.js';
import { productLabel } from './lib/bitget-search.js';
import { probeAll } from './lib/bitget-health.js';

const STEP_LABEL = { catalog: 'Catalogue', ticker: 'Ticker', candles: 'Candles' };
function Step({ step }) {
  if (!step) return <span className="st-unknown">—</span>;
  if (!step.ok) return <span className="st-down" title={step.error}>FAIL · {step.error}</span>;
  return <span className={step.slow ? 'st-degraded' : 'st-ok'}>{step.slow ? 'SLOW' : 'OK'} · {step.latencyMs} ms{step.count !== undefined ? ' · ' + step.count : ''}{step.stale ? ' · STALE' : ''}</span>;
}

export default function BitgetHealth() {
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(false);
  const running = useRef(false);
  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true; setBusy(true);
    try { setReport(await probeAll(apiFetch, { cloudflareMode: getApiSource().mode === 'cloudflare-edge' })); } finally { running.current = false; setBusy(false); }
  }, []);
  useEffect(() => { run(); }, [run]);
  useEffect(() => { if (!auto) return undefined; const timer = setInterval(run, 60000); return () => clearInterval(timer); }, [auto, run]);

  return <div className="bh-root">
    <section className="wb-card" aria-label="Bitget health summary">
      <div className="wb-head"><b>BITGET PRODUCT HEALTH</b><small>API mode: {getApiSource().mode}</small></div>
      <div className="wb-deriv"><div><small>WORKING</small><b className={report && report.working === report.total ? 'st-ok' : 'st-degraded'}>{report ? report.working + ' / ' + report.total : '…'}</b><span>products fully healthy</span></div><div><small>LAST CHECK</small><b>{report ? new Date(report.checkedAt).toLocaleTimeString() : '—'}</b></div></div>
      <div className="wb-layouts"><button className="bh-btn" type="button" onClick={run} disabled={busy}>{busy ? 'Checking…' : 'Check now'}</button><label className="bc-product"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Re-check every 60s</label></div>
      <small className="wb-note">Each product is probed through the same API the charts use: market catalogue, a sample ticker and recent candles. "Stale" means the newest candle is older than three bars. Results describe this browser's connection right now.</small>
    </section>
    <section className="wb-card" aria-label="Per-product results"><div className="table-scroll"><table className="bh-table"><thead><tr><th>PRODUCT</th><th>STATUS</th><th>SAMPLE</th>{Object.values(STEP_LABEL).map((l) => <th key={l}>{l.toUpperCase()}</th>)}</tr></thead><tbody>
      {(report?.results || []).map((r) => <tr key={r.product}><td><b>{productLabel(r.product)}</b></td><td className={'st-' + r.status}>{r.status.toUpperCase()}</td><td>{r.sample || '—'}</td>{r.status === 'unavailable' ? <td colSpan={3} className="wb-note">{r.reason}</td> : Object.keys(STEP_LABEL).map((k) => <td key={k}><Step step={r.steps[k]} /></td>)}</tr>)}
      {!report && <tr><td colSpan={6} className="wb-note">Running first check…</td></tr>}
    </tbody></table></div></section>
  </div>;
}
