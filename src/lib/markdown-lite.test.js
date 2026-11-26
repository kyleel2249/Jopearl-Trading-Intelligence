import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToPlainText, parseInline, parseMarkdown, safeUrl } from './markdown-lite.js';
import { agentReportToMarkdown } from './agent-report.js';

test('block parsing: headings, lists, code, quotes, rules, paragraphs', () => {
  const blocks = parseMarkdown('## Title\nIntro line\nmore\n\n- a\n  - nested\n1. one\n\n```\ncode **x**\n```\n> quote\n---');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'list', 'list', 'code', 'quote', 'rule']);
  assert.equal(blocks[2].items[1].depth, 1);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[4].text, 'code **x**');
});

test('inline parsing is safe: only http(s)/mailto links, no raw HTML interpretation', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
  const tokens = parseInline('[bad](javascript:alert(1)) [ok](https://a.com) <img src=x onerror=1> **b** `c` https://x.org/p.');
  assert.ok(!tokens.some((t) => t.type === 'link' && t.href.startsWith('javascript')));
  assert.ok(tokens.some((t) => t.type === 'link' && t.href === 'https://a.com/'));
  assert.ok(tokens.some((t) => t.type === 'text' && t.text.includes('<img src=x onerror=1>')), 'HTML stays inert text');
  assert.ok(tokens.some((t) => t.type === 'strong') && tokens.some((t) => t.type === 'code'));
  const bare = tokens.find((t) => t.type === 'link' && t.href.startsWith('https://x.org'));
  assert.equal(bare.text, 'https://x.org/p');
});

test('agent JSON becomes markdown headings and bullets; plain markdown is unchanged', () => {
  const md = agentReportToMarkdown(JSON.stringify({ summary: 'Calm.', findings: ['A', 'B'], risks: [], nextActions: ['C'], handoffs: [] }));
  assert.equal(md, '## Summary\nCalm.\n\n## Key findings\n- A\n- B\n\n## Recommended next steps\n- C');
  assert.equal(agentReportToMarkdown('## Executive assessment\n- ok'), '## Executive assessment\n- ok');
});

test('plain-text export strips Markdown syntax', () => {
  const text = markdownToPlainText('## Summary\nA **bold** [link](https://a.com)\n\n- x\n- y');
  assert.equal(text, 'SUMMARY\n\nA bold link\n\n• x\n• y');
});
