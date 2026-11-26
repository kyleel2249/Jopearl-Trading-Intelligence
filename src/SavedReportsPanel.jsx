import React, { useCallback, useEffect, useState } from 'react';
import AgentReport from './AgentReport.jsx';
import { deleteReport, readSavedReports } from './lib/saved-reports.js';

const store = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

// AI reports saved from missions, mentor reviews and engines. Kept separate from trade entries.
export default function SavedReportsPanel() {
  const [reports, setReports] = useState(() => readSavedReports(store()));
  const refresh = useCallback(() => setReports(readSavedReports(store())), []);
  useEffect(() => {
    window.addEventListener('jpti:reports-changed', refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener('jpti:reports-changed', refresh); window.removeEventListener('storage', refresh); };
  }, [refresh]);
  return <section className="rj-saved-reports" aria-label="Saved AI reports">
    <div className="rj-panel-title"><b>Saved AI reports</b><span className="rj-footnote">{reports.length} saved</span></div>
    {!reports.length && <p className="rj-footnote">Use “Save to journal” on any AI report to keep it here.</p>}
    {reports.map((report) => <details key={report.id} className="rj-saved-report">
      <summary>{report.title} <span className="rj-footnote">· {report.date} · {report.symbol}</span></summary>
      <AgentReport content={report.markdown} title={report.title} saveable={false} />
      <button type="button" className="small-refresh" onClick={() => setReports(deleteReport(store(), report.id))}>Remove from this device</button>
      <p className="rj-footnote">A copy synced to Cloudflare, if any, is kept there.</p>
    </details>)}
  </section>;
}
