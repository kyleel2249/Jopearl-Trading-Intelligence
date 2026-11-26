import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { humanizeAgentOutput } from '../src/lib/agent-report.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');

test('server agent runners never store raw JSON as the human-readable output', () => {
  const foundation = read('functions/intelligence-foundation.js');
  assert.doesNotMatch(foundation, /output\s*=\s*structured\s*\?\s*JSON\.stringify/);
  assert.match(foundation, /formatAgentReport\(structured\)/);
  assert.match(read('functions/organization-intelligence.js'), /humanizeAgentOutput\(typeof synthesis/);
  assert.match(read('functions/api/[[path]].js'), /humanizeAgentOutput\(typeof output/);
});

test('UI panels that show agent or engine output convert JSON to plain language', () => {
  for (const file of ['src/AutonomousDepartments.jsx', 'src/MarketDigitalTwin.jsx', 'src/Phase15To21Workspaces.jsx', 'src/ReflectiveJournal.jsx']) {
    assert.match(read(file), /<AgentReport\b/, file + ' must render agent output through AgentReport');
  }
  assert.doesNotMatch(read('src/AutonomousDepartments.jsx'), /<pre>\{item\.result\.output\}<\/pre>/);
  assert.doesNotMatch(read('src/ReflectiveJournal.jsx'), /<pre[^>]*>\{mentorReview/);
});

test('previously stored JSON mission output is healed at display time', () => {
  const stored = JSON.stringify({ summary: 'Funding is neutral.', findings: ['OI flat'], risks: [], nextActions: ['Re-check at the NY open'], handoffs: [] });
  const shown = humanizeAgentOutput(stored);
  assert.match(shown, /^Summary\nFunding is neutral\./);
  assert.doesNotMatch(shown, /[{}\[\]"]/);
});

test('AgentReport renders JSON as formatted HTML, escapes markup and offers export actions', async () => {
  const { build } = await import('esbuild');
  const { pathToFileURL } = await import('node:url');
  const { mkdirSync, rmSync } = await import('node:fs');
  const dir = join(root, 'node_modules', '.cache', 'jpti-report-test');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, 'bundle.mjs');
  await build({ entryPoints: [join(root, 'src/AgentReport.jsx')], bundle: true, format: 'esm', platform: 'node', outfile: out, external: ['react', 'react-dom'], jsx: 'automatic', logLevel: 'silent' });
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: AgentReport } = await import(pathToFileURL(out).href);
  const html = renderToStaticMarkup(React.createElement(AgentReport, { content: JSON.stringify({ summary: 'Calm <script>alert(1)</script>', findings: ['Use **care**'], risks: [], nextActions: ['Re-check'], handoffs: [] }), title: 'Test' }));
  assert.match(html, /<h4>Summary<\/h4>/);
  assert.match(html, /<li>Use <strong>care<\/strong><\/li>/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  for (const label of ['Copy', 'Download .md', 'Download .txt']) assert.ok(html.includes(label), label);
  assert.equal(renderToStaticMarkup(React.createElement(AgentReport, { content: '' })), '');
  rmSync(dir, { recursive: true, force: true });
});
