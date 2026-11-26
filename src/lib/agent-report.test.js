import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, formatAgentReport, humanizeAgentOutput, labelFromKey, summarizeInline } from './agent-report.js';

test('labels are readable', () => {
  assert.equal(labelFromKey('nextActions'), 'Next actions');
  assert.equal(labelFromKey('max_drawdown_percent'), 'Max drawdown percent');
  assert.equal(labelFromKey('apiUrl'), 'API URL');
});

test('agent JSON is converted to sectioned plain language', () => {
  const raw = JSON.stringify({ summary: 'BTC range-bound.', findings: ['Volume fading', 'Funding neutral'], evidence: [], risks: ['Event risk'], nextActions: ['Wait for confirmation'], handoffs: [{ toDepartment: 'research', subject: 'Verify ETF flows', body: 'Check sources', priority: 'high' }] });
  const text = humanizeAgentOutput(raw);
  assert.match(text, /^Summary\nBTC range-bound\./);
  assert.match(text, /Key findings\n• Volume fading\n• Funding neutral/);
  assert.match(text, /Recommended next steps\n• Wait for confirmation/);
  assert.match(text, /To department: research/);
  assert.doesNotMatch(text, /[{}"]/);
  assert.doesNotMatch(text, /Evidence/, 'empty sections are omitted');
});

test('fenced and prose-wrapped JSON is extracted', () => {
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Result: {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
  assert.equal(extractJson('plain prose'), undefined);
  assert.match(humanizeAgentOutput('Analysis follows. {"summary":"ok","risks":["x"]}'), /^Analysis follows\.\n\nSummary\nok/);
});

test('plain prose passes through unchanged and unknown objects are still readable', () => {
  assert.equal(humanizeAgentOutput('  Already readable.  '), 'Already readable.');
  const text = humanizeAgentOutput({ status: 'ok', score: 0.123456789, passed: true, nested: { riskLevel: 'low' }, list: [1, 2] });
  assert.match(text, /Status: ok/);
  assert.match(text, /Score: 0\.123457/);
  assert.match(text, /Passed: Yes/);
  assert.match(text, /Nested:\n {2}Risk level: low/);
  assert.match(text, /List:\n {2}• 1\n {2}• 2/);
});

test('extra keys on an agent report are appended, never dropped', () => {
  const text = formatAgentReport({ summary: 's', confidence: 0.7 });
  assert.match(text, /Confidence: 0\.7/);
});

test('null, empty and deeply nested input never throws', () => {
  assert.equal(humanizeAgentOutput(null), '');
  assert.equal(humanizeAgentOutput({}), '');
  let deep = {}; const root = deep; for (let i = 0; i < 20; i += 1) { deep.n = {}; deep = deep.n; } deep.v = 1;
  assert.doesNotThrow(() => humanizeAgentOutput(root));
  assert.equal(summarizeInline({ fast: 12, slow: 26 }), 'Fast: 12 · Slow: 26');
});
