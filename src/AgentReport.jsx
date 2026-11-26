import React, { useMemo, useState } from 'react';
import { agentReportToMarkdown } from './lib/agent-report.js';
import { markdownToHtmlDocument, markdownToPlainText, parseInline, parseMarkdown, splitEvidenceLabel } from './lib/markdown-lite.js';
import { apiFetch } from './lib/api.js';
import { buildReportEntry, saveReport } from './lib/saved-reports.js';

function Inline({ text }) {
  return parseInline(text).map((token, index) => {
    if (token.type === 'strong') return <strong key={index}>{token.text}</strong>;
    if (token.type === 'em') return <em key={index}>{token.text}</em>;
    if (token.type === 'code') return <code key={index}>{token.text}</code>;
    if (token.type === 'link') return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer nofollow">{token.text}</a>;
    return <React.Fragment key={index}>{token.text}</React.Fragment>;
  });
}

function Labelled({ text }) {
  const { kind, label, rest } = splitEvidenceLabel(text);
  if (!kind) return <Inline text={text} />;
  return <><span className={'ev-badge ev-' + kind} title={'Evidence class: ' + kind}>{label}</span> <Inline text={rest} /></>;
}

export function EvidenceSummary({ result }) {
  if (!result || typeof result !== 'object') return null;
  const chips = [];
  if (result.evidenceStatus) chips.push([String(result.evidenceStatus), /verified|ok|live/i.test(result.evidenceStatus) ? 'verified' : /stale|unavailable|none|missing/i.test(result.evidenceStatus) ? 'unknown' : 'inferred', 'Evidence']);
  if (Number.isFinite(Number(result.sourceCount))) chips.push([result.sourceCount + ' source' + (Number(result.sourceCount) === 1 ? '' : 's'), Number(result.sourceCount) > 0 ? 'verified' : 'unknown', 'Retrieved sources']);
  if (Number.isFinite(Number(result.memoryUsed))) chips.push([result.memoryUsed + ' memory item' + (Number(result.memoryUsed) === 1 ? '' : 's'), 'inferred', 'Shared memory used']);
  if (Array.isArray(result.specialistFindings)) chips.push([result.specialistFindings.length + ' specialists', 'inferred', 'Independent specialist analyses']);
  if (Array.isArray(result.handoffsCreated)) chips.push([result.handoffsCreated.length + ' handoffs', 'recommendation', 'Handoffs created']);
  if (result.trust) chips.push(['trust: ' + result.trust, result.trust === 'verified' ? 'verified' : result.trust === 'partially-verified' || result.trust === 'inferred' ? 'inferred' : 'unknown', result.trust === 'quarantined' ? 'Output contained an injection attempt; it was not shared with other departments or reused as memory' : 'How far shared memory may trust this result']);
  const fresh = result.freshness?.status || result.freshness?.memory;
  if (fresh && fresh !== 'empty') chips.push(['sources ' + fresh, fresh === 'fresh' ? 'verified' : fresh === 'partly-stale' || fresh === 'undated' ? 'inferred' : 'unknown', 'Age of retrieved news and memory' + (result.freshness?.newestAgeHours != null ? ' (newest ' + result.freshness.newestAgeHours + 'h old)' : '')]);
  if (result.grounding?.checked > 0) chips.push([result.grounding.unsupportedCount ? result.grounding.unsupportedCount + ' figure' + (result.grounding.unsupportedCount === 1 ? '' : 's') + ' not in sources' : 'figures match sources', result.grounding.unsupportedCount ? 'unknown' : 'verified', result.grounding.unsupportedCount ? 'Not found in the provided material (may be derived): ' + result.grounding.unsupported.join(', ') : 'Every figure appears in the provided material']);
  const flags = [...(result.safety?.inputFlags || []), ...(result.safety?.sourceFlags || []), ...(result.safety?.memoryFlags || []), ...(result.safety?.outputFlags || [])];
  if (flags.length) chips.push(['injection attempt neutralised', 'unknown', 'Instruction-like text was removed before the model saw it: ' + [...new Set(flags)].join(', ')]);
  if (result.safety?.redactions?.length) chips.push(['secrets redacted', 'inferred', 'Credential-like text was removed: ' + result.safety.redactions.join(', ')]);
  if (result.safety?.quarantinedMemory > 0) chips.push([result.safety.quarantinedMemory + ' memory quarantined', 'inferred', 'Quarantined memory was excluded from this run']);
  if (result.outputQuality?.repaired) chips.push(['auto-repaired', 'inferred', 'The model reply was rewritten into plain language']);
  if (result.outputQuality?.fellBack) chips.push(['formatted by fallback', 'unknown', 'The model kept returning raw JSON; the formatter converted it']);
  if (!chips.length) return null;
  return <div className="ev-summary" aria-label="Evidence summary">{chips.map(([text, kind, title]) => <span key={title + text} className={'ev-badge ev-' + kind} title={title}>{text}</span>)}</div>;
}

export function MarkdownView({ markdown }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return <>{blocks.map((block, index) => {
    if (block.type === 'heading') { const Tag = 'h' + Math.min(block.level + 2, 6); return <Tag key={index}><Inline text={block.text} /></Tag>; }
    if (block.type === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul';
      return <Tag key={index}>{block.items.map((item, n) => <li key={n} style={item.depth ? { marginLeft: item.depth * 16 } : undefined}><Labelled text={item.text} /></li>)}</Tag>;
    }
    if (block.type === 'code') return <pre key={index}><code>{block.text}</code></pre>;
    if (block.type === 'quote') return <blockquote key={index}><Inline text={block.text} /></blockquote>;
    if (block.type === 'rule') return <hr key={index} />;
    return <p key={index}><Labelled text={block.text} /></p>;
  })}</>;
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through to legacy path */ }
  try {
    const area = document.createElement('textarea');
    area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch { return false; }
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function printDocument(html) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const cleanup = () => setTimeout(() => frame.remove(), 1500);
  frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } finally { cleanup(); } };
  frame.srcdoc = html;
}

// Renders agent / engine output as formatted, readable text with copy and export actions.
export default function AgentReport({ content, title = 'JPTI report', maxChars = 0, className = '', saveable = true, source = 'ai-agent', meta = null }) {
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const markdown = useMemo(() => { const text = agentReportToMarkdown(content); return maxChars > 0 ? text.slice(0, maxChars) : text; }, [content, maxChars]);
  if (!markdown.trim()) return null;
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
  const flash = (message) => { setStatus(message); setTimeout(() => setStatus(''), 4200); };
  return <div className={'agent-report ' + className}>
    <div className="agent-report-actions" role="group" aria-label="Report actions">
      <button type="button" onClick={async () => flash((await copyText(markdown)) ? 'Copied' : 'Copy failed')}>Copy</button>
      <button type="button" onClick={() => { download(slug + '.md', markdown, 'text/markdown;charset=utf-8'); flash('Markdown saved'); }}>Download .md</button>
      <button type="button" onClick={() => { download(slug + '.txt', markdownToPlainText(markdown), 'text/plain;charset=utf-8'); flash('Text saved'); }}>Download .txt</button>
      <button type="button" onClick={() => printDocument(markdownToHtmlDocument(markdown, { title }))}>Print / PDF</button>
      {saveable && <button type="button" disabled={saving} onClick={async () => {
        const built = buildReportEntry({ title, markdown, source });
        if (built.error) { flash(built.error); return; }
        setSaving(true);
        const outcome = await saveReport({ entry: built.entry, storage: typeof localStorage === 'undefined' ? null : localStorage, post: async (entry) => { const response = await apiFetch('/api/journal/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entry }) }); if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'HTTP ' + response.status); } } });
        setSaving(false); flash(outcome.message);
        if (outcome.ok && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('jpti:reports-changed'));
      }}>{saving ? 'Saving…' : 'Save to journal'}</button>}
      <span className="agent-report-status" role="status" aria-live="polite">{status}</span>
    </div>
    {meta && <EvidenceSummary result={meta} />}
    <div className="agent-report-body"><MarkdownView markdown={markdown} /></div>
  </div>;
}
