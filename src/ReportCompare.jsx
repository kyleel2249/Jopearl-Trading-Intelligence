import React, { useMemo } from 'react';
import { compareReports } from './lib/report-diff.js';

export default function ReportCompare({ before, after, onClose }) {
  const diff = useMemo(() => compareReports(before.content, after.content), [before.content, after.content]);
  const { totals, sections } = diff;
  return <section className="report-compare" aria-label="Report comparison">
    <div className="report-compare-head">
      <div><span className="eyebrow">RUN COMPARISON</span><h4>{before.label} → {after.label}</h4></div>
      <button type="button" className="small-refresh" onClick={onClose}>Close</button>
    </div>
    <p className="subtle-note"><b>{Math.round(diff.similarity * 100)}%</b> of findings are unchanged · <span className="diff-add">+{totals.added} new</span> · <span className="diff-del">−{totals.removed} dropped</span> · {totals.unchanged} unchanged</p>
    {sections.map((section) => <div key={section.title} className="report-compare-section">
      <h5>{section.title}</h5>
      <ul>
        {section.added.map((text, i) => <li key={'a' + i} className="diff-add"><b aria-label="added">+ </b>{text}</li>)}
        {section.removed.map((text, i) => <li key={'r' + i} className="diff-del"><b aria-label="removed">− </b>{text}</li>)}
        {section.unchanged.map((text, i) => <li key={'u' + i} className="diff-same">{text}</li>)}
      </ul>
    </div>)}
    {!sections.length && <p className="subtle-note">Neither report has comparable content.</p>}
  </section>;
}
