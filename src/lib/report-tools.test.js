import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReports, similarity } from './report-diff.js';
import { buildReportEntry, deleteReport, mergeReports, readSavedReports, saveReport } from './saved-reports.js';
import { selectHandoffAlerts, describeHandoff, readSeen, writeSeen } from './handoff-alerts.js';
import { markdownToHtmlDocument, splitEvidenceLabel } from './markdown-lite.js';

const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

test('report comparison finds added, removed and reworded items per section', () => {
  const before = '## Key findings\n- Funding is neutral across venues\n- Open interest is flat\n\n## Risks\n- Event risk on Friday';
  const after = '## Key findings\n- Funding rates are neutral across venues\n- Spot volume is rising sharply\n\n## Risks\n- Event risk on Friday';
  const diff = compareReports(before, after);
  const findings = diff.sections.find((s) => s.title === 'Key findings');
  assert.deepEqual(findings.added, ['Spot volume is rising sharply']);
  assert.deepEqual(findings.removed, ['Open interest is flat']);
  assert.equal(findings.unchanged.length, 1);
  assert.equal(diff.totals.added, 1); assert.equal(diff.totals.removed, 1);
  assert.equal(compareReports(before, before).similarity, 1);
  assert.ok(similarity('alpha beta gamma', 'delta epsilon zeta') < 0.1);
  assert.equal(compareReports(JSON.stringify({ summary: 'Same.', risks: ['x risk'] }), JSON.stringify({ summary: 'Same.', risks: ['x risk'] })).totals.added, 0);
});

test('saved reports: entry shape, local save, cloud failure is reported honestly, merge and delete', async () => {
  assert.ok(buildReportEntry({ title: 'x', markdown: '  ' }).error);
  const { entry } = buildReportEntry({ title: 'BTC/USDT mission', markdown: '## Summary\nBTC range.', now: new Date('2026-11-26T10:00:00Z'), nonce: 'abc12' });
  assert.match(entry.id, /^[a-zA-Z0-9_-]{1,100}$/); assert.equal(entry.symbol, 'BTC/USDT'); assert.equal(entry.entryType, 'ai-report');
  assert.match(entry.symbol, /^[A-Z0-9._/-]{3,40}$/);
  assert.equal(buildReportEntry({ title: 'general', markdown: 'text' }).entry.symbol, 'JPTI/REPORT');
  const storage = mem();
  const okRemote = await saveReport({ entry, storage, post: async () => ({}) });
  assert.equal(okRemote.remote, true); assert.equal(readSavedReports(storage).length, 1);
  const failed = await saveReport({ entry: { ...entry, id: 'report-two' }, storage, post: async () => { throw new Error('HTTP 401'); } });
  assert.equal(failed.ok, true); assert.equal(failed.remote, false); assert.match(failed.message, /HTTP 401/);
  assert.equal(readSavedReports(storage).length, 2);
  assert.equal(mergeReports([entry], [{ ...entry, updatedAt: '2030-01-01' }, { id: 'trade', symbol: 'X' }]).length, 1);
  assert.equal(deleteReport(storage, 'report-two').length, 1);
  assert.equal((await saveReport({ entry, storage: { getItem: () => null, setItem() { throw new Error('full'); } } })).ok, false);
});

test('handoff alerts: only unread high/urgent, new vs seen, urgent first', () => {
  const messages = [
    { id: '1', priority: 'normal', status: 'unread', subject: 'low' },
    { id: '2', priority: 'high', status: 'unread', from: 'research', to: 'trading-social', subject: 'Verify ETF flows', createdAt: '2026-11-26T01:00:00Z' },
    { id: '3', priority: 'urgent', status: 'unread', from: 'research', to: 'general-marketing', subject: 'Source conflict', createdAt: '2026-11-26T02:00:00Z' },
    { id: '4', priority: 'urgent', status: 'read', subject: 'handled' }
  ];
  const alerts = selectHandoffAlerts(messages, ['2']);
  assert.deepEqual(alerts.map((a) => a.id), ['3', '2']);
  assert.equal(alerts[0].isNew, true); assert.equal(alerts[1].isNew, false);
  assert.match(describeHandoff(alerts[0]), /^\[URGENT\] research → general-marketing: Source conflict$/);
  assert.equal(selectHandoffAlerts(messages, [], { minPriority: 'urgent' }).length, 1);
  assert.deepEqual(selectHandoffAlerts(null), []);
  const s = mem(); writeSeen(s, ['a', 'a', 'b']); assert.deepEqual(readSeen(s), ['a', 'b']);
});

test('evidence labels and print HTML', () => {
  assert.deepEqual(splitEvidenceLabel('Verified fact: BTC closed at 70k'), { kind: 'verified', label: 'Verified fact', rest: 'BTC closed at 70k' });
  assert.equal(splitEvidenceLabel('Inference - momentum fading').kind, 'inferred');
  assert.equal(splitEvidenceLabel('Unknown: ETF flow data').kind, 'unknown');
  assert.equal(splitEvidenceLabel('Recommendation: wait').kind, 'recommendation');
  assert.equal(splitEvidenceLabel('Factual errors happen').kind, null);
  const html = markdownToHtmlDocument('## T\n<img src=x onerror=1> [a](javascript:x) **b**', { title: '<b>x</b>', generatedAt: new Date('2026-11-26T10:00:00Z') });
  assert.ok(!html.includes('<img') && !html.includes('<b>x</b>') && !html.includes('href="javascript'));
  assert.match(html, /<h3>T<\/h3>/); assert.match(html, /&lt;img src=x onerror=1&gt;/); assert.match(html, /Generated 2026-11-26 10:00 UTC/); assert.doesNotMatch(html, /<script/i);
});
