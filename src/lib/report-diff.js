// Compares two agent reports (Markdown or plain text) section by section. Bullet/line items are
// matched fuzzily (token Jaccard) so rewordings count as unchanged while genuinely new or dropped
// findings, risks and next steps are surfaced.
import { agentReportToMarkdown } from './agent-report.js';
import { markdownToPlainText, parseInline, parseMarkdown } from './markdown-lite.js';

const plain = (text) => parseInline(text).map((t) => t.text).join('').trim();
const tokens = (text) => new Set(plain(text).toLowerCase().replace(/[^\p{L}\p{N}\s.%-]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));

export function similarity(a, b) {
  const x = tokens(a); const y = tokens(b);
  if (!x.size && !y.size) return 1;
  let shared = 0; for (const w of x) if (y.has(w)) shared += 1;
  return shared / (x.size + y.size - shared || 1);
}

export function sectionsOf(content) {
  const blocks = parseMarkdown(agentReportToMarkdown(content));
  const sections = new Map(); let title = 'Overview';
  const push = (item) => { const text = plain(item); if (!text) return; (sections.get(title) || sections.set(title, []).get(title)).push(text); };
  for (const block of blocks) {
    if (block.type === 'heading') { title = plain(block.text); if (!sections.has(title)) sections.set(title, []); }
    else if (block.type === 'list') block.items.forEach((item) => push(item.text));
    else if (block.type === 'paragraph' || block.type === 'quote') block.text.split(/(?<=[.!?])\s+/).forEach(push);
    else if (block.type === 'code') push(markdownToPlainText('```\n' + block.text + '\n```'));
  }
  return sections;
}

export function compareReports(before, after, threshold = 0.6) {
  const a = sectionsOf(before); const b = sectionsOf(after);
  const titles = [...new Set([...a.keys(), ...b.keys()])];
  const sections = titles.map((title) => {
    const left = a.get(title) || []; const right = b.get(title) || [];
    const unmatched = new Set(left.map((_, i) => i));
    const added = []; const unchanged = [];
    for (const item of right) {
      let best = -1; let bestScore = 0;
      for (const i of unmatched) { const score = similarity(left[i], item); if (score > bestScore) { bestScore = score; best = i; } }
      if (best >= 0 && bestScore >= threshold) { unmatched.delete(best); unchanged.push(item); } else added.push(item);
    }
    return { title, added, removed: [...unmatched].map((i) => left[i]), unchanged };
  }).filter((s) => s.added.length || s.removed.length || s.unchanged.length);
  const count = (key) => sections.reduce((n, s) => n + s[key].length, 0);
  const totals = { added: count('added'), removed: count('removed'), unchanged: count('unchanged') };
  const denominator = totals.added + totals.removed + totals.unchanged;
  return { sections, totals, similarity: denominator ? Number((totals.unchanged / denominator).toFixed(3)) : 1 };
}
