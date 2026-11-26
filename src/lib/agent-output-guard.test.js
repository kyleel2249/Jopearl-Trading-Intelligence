import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReadability, assessStructuredStrings, guardedGeneration, outcomeOf, summarizeQuality } from './agent-output-guard.js';

const json = JSON.stringify({ summary: 'Calm.', findings: ['A'], risks: [], nextActions: [], handoffs: [] });

test('readability assessment', () => {
  assert.equal(assessReadability('A normal paragraph about BTC.').readable, true);
  assert.deepEqual(assessReadability(json).reasons, ['json-document']);
  assert.deepEqual(assessReadability('').reasons, ['empty']);
  assert.equal(assessReadability('Intro\n```json\n' + json + '\n```').readable, false, 'JSON that dominates the reply is unreadable');
  assert.equal(assessReadability('A long, thoughtful analysis. '.repeat(30) + 'Config: {"a":1}').readable, true, 'a small JSON aside inside long prose is fine');
  assert.equal(assessReadability('"a": 1, "b": 2, "c": 3, "d": 4 trailing noise').readable, false);
  assert.equal(assessStructuredStrings({ summary: '{"x":1}' }).readable, false);
  assert.equal(assessStructuredStrings({ summary: 'ok', findings: ['fine'] }).readable, true);
});

test('prose mode: clean reply needs one call, JSON reply is repaired with a rewrite prompt', async () => {
  let calls = 0; const seen = [];
  const clean = await guardedGeneration({ generate: async () => { calls += 1; return { response: 'All good.' }; }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls, 1); assert.equal(outcomeOf(clean), 'clean');
  calls = 0;
  const fixed = await guardedGeneration({ generate: async (m) => { calls += 1; seen.push(m); return calls === 1 ? json : 'Plain rewrite.'; }, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(calls, 2); assert.equal(fixed.text, 'Plain rewrite.'); assert.equal(outcomeOf(fixed), 'repaired');
  assert.match(seen[1].at(-1).content, /Rewrite it as clear, plain-English/);
});

test('prose mode: still-JSON after retry falls back (retries bounded to one)', async () => {
  let calls = 0;
  const result = await guardedGeneration({ generate: async () => { calls += 1; return json; }, messages: [] });
  assert.equal(calls, 2); assert.equal(result.fellBack, true); assert.equal(outcomeOf(result), 'fallback');
  assert.ok(result.reasons.includes('json-document'));
});

test('structured mode: valid JSON passes; broken JSON retries then falls back to prose', async () => {
  const ok = await guardedGeneration({ mode: 'structured', generate: async () => json, messages: [] });
  assert.equal(ok.structured.summary, 'Calm.'); assert.equal(ok.attempts, 1);
  let calls = 0;
  const repaired = await guardedGeneration({ mode: 'structured', generate: async () => (++calls === 1 ? 'not json at all' : json), messages: [] });
  assert.equal(repaired.repaired, true); assert.ok(repaired.structured);
  const broken = await guardedGeneration({ mode: 'structured', generate: async () => 'still prose', messages: [] });
  assert.equal(broken.fellBack, true); assert.equal(broken.structured, null); assert.equal(broken.text, 'still prose');
});

test('quality summary ranks the least reliable agents first', () => {
  const out = summarizeQuality([{ agentKey: 'a', outcome: 'clean' }, { agentKey: 'a', outcome: 'clean' }, { agentKey: 'b', outcome: 'fallback' }, { agentKey: 'b', outcome: 'clean' }]);
  assert.equal(out[0].agentKey, 'b'); assert.equal(out[0].cleanRate, 0.5); assert.equal(out[1].cleanRate, 1);
});
