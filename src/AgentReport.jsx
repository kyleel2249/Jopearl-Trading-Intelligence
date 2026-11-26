import React, { useMemo, useState } from 'react';
import { agentReportToMarkdown } from './lib/agent-report.js';
import { markdownToPlainText, parseInline, parseMarkdown } from './lib/markdown-lite.js';

function Inline({ text }) {
  return parseInline(text).map((token, index) => {
    if (token.type === 'strong') return <strong key={index}>{token.text}</strong>;
    if (token.type === 'em') return <em key={index}>{token.text}</em>;
    if (token.type === 'code') return <code key={index}>{token.text}</code>;
    if (token.type === 'link') return <a key={index} href={token.href} target="_blank" rel="noopener noreferrer nofollow">{token.text}</a>;
    return <React.Fragment key={index}>{token.text}</React.Fragment>;
  });
}

export function MarkdownView({ markdown }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return <>{blocks.map((block, index) => {
    if (block.type === 'heading') { const Tag = 'h' + Math.min(block.level + 2, 6); return <Tag key={index}><Inline text={block.text} /></Tag>; }
    if (block.type === 'list') {
      const Tag = block.ordered ? 'ol' : 'ul';
      return <Tag key={index}>{block.items.map((item, n) => <li key={n} style={item.depth ? { marginLeft: item.depth * 16 } : undefined}><Inline text={item.text} /></li>)}</Tag>;
    }
    if (block.type === 'code') return <pre key={index}><code>{block.text}</code></pre>;
    if (block.type === 'quote') return <blockquote key={index}><Inline text={block.text} /></blockquote>;
    if (block.type === 'rule') return <hr key={index} />;
    return <p key={index}><Inline text={block.text} /></p>;
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

// Renders agent / engine output as formatted, readable text with copy and export actions.
export default function AgentReport({ content, title = 'JPTI report', maxChars = 0, className = '' }) {
  const [status, setStatus] = useState('');
  const markdown = useMemo(() => { const text = agentReportToMarkdown(content); return maxChars > 0 ? text.slice(0, maxChars) : text; }, [content, maxChars]);
  if (!markdown.trim()) return null;
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report';
  const flash = (message) => { setStatus(message); setTimeout(() => setStatus(''), 2200); };
  return <div className={'agent-report ' + className}>
    <div className="agent-report-actions" role="group" aria-label="Report actions">
      <button type="button" onClick={async () => flash((await copyText(markdown)) ? 'Copied' : 'Copy failed')}>Copy</button>
      <button type="button" onClick={() => { download(slug + '.md', markdown, 'text/markdown;charset=utf-8'); flash('Markdown saved'); }}>Download .md</button>
      <button type="button" onClick={() => { download(slug + '.txt', markdownToPlainText(markdown), 'text/plain;charset=utf-8'); flash('Text saved'); }}>Download .txt</button>
      <span className="agent-report-status" role="status" aria-live="polite">{status}</span>
    </div>
    <div className="agent-report-body"><MarkdownView markdown={markdown} /></div>
  </div>;
}
