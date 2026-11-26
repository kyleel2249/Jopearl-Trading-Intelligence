import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as intelligenceLab } from '../functions/api/intelligence-lab/[[path]].js';

const stmt = { bind() { return this; }, async run() { return { results: [] }; }, async all() { return { results: [] }; }, async first() { return null; } };
const db = { prepare: () => stmt };
const SECRET = 'correct-horse-battery-staple';
const call = (env, headers) => intelligenceLab({ request: new Request('https://jpti.example/api/intelligence-lab/unknown', { headers }), env });

test('intelligence-lab honours Bearer auth (regression: doubled backslash in the regex)', async () => {
  const env = { JPTI_DB: db, JPTI_JOURNAL_TOKEN: SECRET };
  const bearer = await call(env, { authorization: `Bearer ${SECRET}` });
  const header = await call(env, { 'x-jpti-api-token': SECRET });
  assert.notEqual(bearer.status, 401);
  assert.equal(bearer.status, header.status);
});

test('intelligence-lab rejects wrong or missing tokens with 401', async () => {
  const env = { JPTI_DB: db, JPTI_JOURNAL_TOKEN: SECRET };
  assert.equal((await call(env, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call(env, {})).status, 401);
});

test('a secret stored with a trailing newline or spaces still matches the entered token', async () => {
  const ok = (await call({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: SECRET }, { 'x-jpti-api-token': SECRET })).status;
  for (const stored of [`${SECRET}\n`, ` ${SECRET}`, `${SECRET}  `]) {
    assert.equal((await call({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: stored }, { 'x-jpti-api-token': SECRET })).status, ok, JSON.stringify(stored));
  }
});

test('JPTI_API_TOKEN is the fallback; an unset secret is 503, never a silent pass', async () => {
  assert.notEqual((await call({ JPTI_DB: db, JPTI_API_TOKEN: SECRET }, { 'x-jpti-api-token': SECRET })).status, 401);
  assert.equal((await call({ JPTI_DB: db }, { 'x-jpti-api-token': SECRET })).status, 503);
});
