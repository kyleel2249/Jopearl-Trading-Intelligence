// Minimal, dependency-free and XSS-safe Markdown parser for AI-generated reports.
// It returns plain data (blocks and inline tokens); the React layer turns it into elements,
// so no HTML string is ever injected. Only http(s) and mailto links are ever produced.

export function safeUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+`|\*[^*\s][^*\n]*?\*|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>)\]]+)/g;

export function parseInline(text) {
  const out = [];
  const source = String(text ?? '');
  let last = 0;
  for (const match of source.matchAll(INLINE)) {
    const token = match[0];
    if (match.index > last) out.push({ type: 'text', text: source.slice(last, match.index) });
    if (token.startsWith('**') || token.startsWith('__')) out.push({ type: 'strong', text: token.slice(2, -2) });
    else if (token.startsWith('`')) out.push({ type: 'code', text: token.slice(1, -1) });
    else if (token.startsWith('*')) out.push({ type: 'em', text: token.slice(1, -1) });
    else if (token.startsWith('[')) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = parts && safeUrl(parts[2]);
      out.push(href ? { type: 'link', text: parts[1], href } : { type: 'text', text: token });
    } else {
      const trailing = token.match(/[.,;:!?]+$/)?.[0] || '';
      const href = safeUrl(trailing ? token.slice(0, -trailing.length) : token);
      if (href) { out.push({ type: 'link', text: trailing ? token.slice(0, -trailing.length) : token, href }); if (trailing) out.push({ type: 'text', text: trailing }); }
      else out.push({ type: 'text', text: token });
    }
    last = match.index + token.length;
  }
  if (last < source.length) out.push({ type: 'text', text: source.slice(last) });
  return out;
}

// Blocks: heading {level,text} · paragraph {text} · list {ordered,items:[{depth,text}]} ·
// code {text} · quote {text} · rule {}
export function parseMarkdown(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: 'paragraph', text: paragraph.join('\n') }); paragraph = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushParagraph(); flushList();
      const code = [];
      for (i += 1; i < lines.length && !/^\s*```/.test(lines[i]); i += 1) code.push(lines[i]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushList(); blocks.push({ type: 'heading', level: Math.min(heading[1].length, 4), text: heading[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushParagraph(); flushList(); blocks.push({ type: 'rule' }); continue; }
    const item = line.match(/^(\s*)(?:([-*+•])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      const ordered = Boolean(item[3]);
      if (!list || list.ordered !== ordered) { flushList(); list = { type: 'list', ordered, items: [] }; }
      list.items.push({ depth: Math.min(Math.floor(item[1].replace(/\t/g, '  ').length / 2), 4), text: item[4] });
      continue;
    }
    if (/^\s*>\s?/.test(line)) { flushParagraph(); flushList(); blocks.push({ type: 'quote', text: line.replace(/^\s*>\s?/, '') }); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1].text += ' ' + line.trim(); continue; }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return blocks;
}

// Plain-text export (strips Markdown syntax) for .txt downloads and clipboard fallbacks.
export function markdownToPlainText(markdown) {
  return parseMarkdown(markdown).map((block) => {
    if (block.type === 'heading') return block.text.toUpperCase();
    if (block.type === 'list') return block.items.map((item, n) => '  '.repeat(item.depth) + (block.ordered ? n + 1 + '. ' : '• ') + parseInline(item.text).map((t) => t.text).join('')).join('\n');
    if (block.type === 'rule') return '----------------';
    if (block.type === 'code') return block.text;
    return parseInline(block.text).map((t) => t.text).join('');
  }).join('\n\n');
}

// Evidence labels used by the agent prompts ("Separate facts, inference, unknowns and
// recommendations"). A leading label becomes a badge in the UI; the text itself is unchanged.
const EVIDENCE_LABEL = /^(verified(?:\s+fact)?|facts?|inferences?|inferred|unknowns?|unverified|assumptions?|recommendations?)\s*[:\-–—]\s+/i;
export function splitEvidenceLabel(text) {
  const match = String(text ?? '').match(EVIDENCE_LABEL);
  if (!match) return { kind: null, label: '', rest: String(text ?? '') };
  const word = match[1].toLowerCase();
  const kind = word.startsWith('verified') || word.startsWith('fact') ? 'verified' : word.startsWith('infer') || word.startsWith('assum') ? 'inferred' : word.startsWith('recommend') ? 'recommendation' : 'unknown';
  return { kind, label: match[1].replace(/^./, (c) => c.toUpperCase()), rest: String(text).slice(match[0].length) };
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inlineHtml = (text) => parseInline(text).map((t) => {
  const body = escapeHtml(t.text);
  if (t.type === 'strong') return '<strong>' + body + '</strong>';
  if (t.type === 'em') return '<em>' + body + '</em>';
  if (t.type === 'code') return '<code>' + body + '</code>';
  if (t.type === 'link') return '<a href="' + escapeHtml(t.href) + '">' + body + '</a>';
  return body;
}).join('');

// Self-contained, print-optimised HTML document (every text node escaped; no scripts).
export function markdownToHtmlDocument(markdown, { title = 'JPTI report', generatedAt = new Date() } = {}) {
  const body = parseMarkdown(markdown).map((block) => {
    if (block.type === 'heading') { const n = Math.min(block.level + 1, 5); return '<h' + n + '>' + inlineHtml(block.text) + '</h' + n + '>'; }
    if (block.type === 'list') { const tag = block.ordered ? 'ol' : 'ul'; return '<' + tag + '>' + block.items.map((i) => '<li' + (i.depth ? ' style="margin-left:' + i.depth * 16 + 'px"' : '') + '>' + inlineHtml(i.text) + '</li>').join('') + '</' + tag + '>'; }
    if (block.type === 'code') return '<pre>' + escapeHtml(block.text) + '</pre>';
    if (block.type === 'quote') return '<blockquote>' + inlineHtml(block.text) + '</blockquote>';
    if (block.type === 'rule') return '<hr>';
    return '<p>' + inlineHtml(block.text) + '</p>';
  }).join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><style>'
    + 'body{font:14px/1.6 system-ui,Segoe UI,Arial,sans-serif;color:#111;margin:32px auto;max-width:760px;padding:0 16px}h1{font-size:22px;margin:0 0 4px}.meta{color:#555;font-size:12px;margin-bottom:18px}'
    + 'h2,h3,h4,h5{margin:18px 0 6px;page-break-after:avoid}li,p{page-break-inside:avoid}pre{white-space:pre-wrap;background:#f3f4f6;padding:8px;border-radius:4px}blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #bbb}a{color:#0b57d0}.note{margin-top:24px;font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:8px}'
    + '@media print{body{margin:0;max-width:none}}</style></head><body><h1>' + escapeHtml(title) + '</h1><div class="meta">Generated ' + escapeHtml(new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC · JPTI</div>'
    + body + '<div class="note">Research output only. Not investment advice. No orders were placed.</div></body></html>';
}
