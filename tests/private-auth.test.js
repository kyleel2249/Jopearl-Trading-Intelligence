import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseToken, configuredToken, providedToken, tokensEqual, verifyPrivateToken } from '../functions/private-auth.js';
import { createPagesApiHandler } from '../functions/api/[[path]].js';
import { onRequest as paperRoute } from '../functions/api/paper/[[path]].js';
import { describeTokenCheck } from '../src/lib/token-check.js';

const SECRET = 'correct-horse-battery-staple';
const stmt = { bind() { return this; }, async run() { return { success: true, results: [] }; }, async all() { return { results: [] }; }, async first() { return null; } };
const db = { prepare: () => stmt };
const mainHandler = createPagesApiHandler({
  marketProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  bitgetCfdProvider: { async request() { return { status: 404, body: { error: 'not found' } }; } },
  fetchImpl: async () => new Response('', { status: 503 })
});
const req = (path, headers = {}, method = 'GET') => new Request('https://jpti.example' + path, { method, headers });

// --- shared module contract -------------------------------------------------------------------
test('normaliseToken trims and tolerates non-strings', () => {
  assert.equal(normaliseToken('  abc \n'), 'abc');
  assert.equal(normaliseToken(undefined), '');
  assert.equal(normaliseToken(null), '');
});

test('configuredToken prefers JPTI_JOURNAL_TOKEN, falls back to JPTI_API_TOKEN, and ignores blank values', () => {
  assert.equal(configuredToken({ JPTI_JOURNAL_TOKEN: 'a', JPTI_API_TOKEN: 'b' }), 'a');
  assert.equal(configuredToken({ JPTI_API_TOKEN: 'b' }), 'b');
  assert.equal(configuredToken({ JPTI_JOURNAL_TOKEN: ' \n', JPTI_API_TOKEN: 'b' }), 'b', 'a blank primary must not mask the fallback');
  assert.equal(configuredToken({ JPTI_JOURNAL_TOKEN: '  ' }), '');
  assert.equal(configuredToken(undefined), '');
});

test('providedToken reads the header first, then Bearer, trimmed', () => {
  assert.equal(providedToken(req('/x', { 'x-jpti-api-token': ' tok ' })), 'tok');
  assert.equal(providedToken(req('/x', { authorization: 'Bearer tok2' })), 'tok2');
  assert.equal(providedToken(req('/x', { 'x-jpti-api-token': 'h', authorization: 'Bearer b' })), 'h');
  assert.equal(providedToken(req('/x')), '');
});

test('tokensEqual is exact and length-safe', async () => {
  assert.equal(await tokensEqual('abc', 'abc'), true);
  assert.equal(await tokensEqual('abc', 'abd'), false);
  assert.equal(await tokensEqual('abc', 'abcd'), false);
  assert.equal(await tokensEqual('abc', ''), false);
});

test('verifyPrivateToken fails closed: 503 when unset, 401 when wrong, ok when right, custom wording kept', async () => {
  const wording = { unconfigured: 'U', rejected: 'R' };
  assert.deepEqual(await verifyPrivateToken(req('/x', { 'x-jpti-api-token': SECRET }), {}, wording), { ok: false, status: 503, error: 'U' });
  assert.deepEqual(await verifyPrivateToken(req('/x', { 'x-jpti-api-token': 'nope' }), { JPTI_JOURNAL_TOKEN: SECRET }, wording), { ok: false, status: 401, error: 'R' });
  assert.deepEqual(await verifyPrivateToken(req('/x'), { JPTI_JOURNAL_TOKEN: SECRET }, wording), { ok: false, status: 401, error: 'R' });
  assert.deepEqual(await verifyPrivateToken(req('/x', { 'x-jpti-api-token': SECRET }), { JPTI_JOURNAL_TOKEN: SECRET }), { ok: true });
});

// --- regression: secret saved with stray whitespace must still authorise on EVERY private route ----
const storedVariants = [SECRET, SECRET + '\n', ' ' + SECRET, SECRET + '  ', '\t' + SECRET + '\r\n'];
const routes = {
  journal: (env, headers) => mainHandler({ request: req('/api/journal/entries', headers), env }),
  department: (env, headers) => mainHandler({ request: req('/api/org/overview', headers), env }),
  foundation: (env, headers) => mainHandler({ request: req('/api/intelligence-foundation/status', headers), env }),
  agents: (env, headers) => mainHandler({ request: req('/api/agents/history', headers), env }),
  paper: (env, headers) => paperRoute({ request: req('/api/paper/overview', headers), env })
};

for (const [name, call] of Object.entries(routes)) {
  test(`${name} route accepts the correct token whatever whitespace the stored secret carries`, async () => {
    for (const stored of storedVariants) {
      const response = await call({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: stored }, { 'x-jpti-api-token': SECRET });
      assert.notEqual(response.status, 401, `${name}: stored ${JSON.stringify(stored)} wrongly rejected the correct token`);
      assert.notEqual(response.status, 503, `${name}: stored ${JSON.stringify(stored)} wrongly reported as unconfigured`);
    }
  });
  test(`${name} route still rejects a wrong or missing token and fails closed when no secret is set`, async () => {
    const env = { JPTI_DB: db, JPTI_JOURNAL_TOKEN: SECRET };
    assert.equal((await call(env, { 'x-jpti-api-token': 'wrong' })).status, 401);
    assert.equal((await call(env, {})).status, 401);
    assert.equal((await call({ JPTI_DB: db }, { 'x-jpti-api-token': SECRET })).status, 503);
    assert.equal((await call({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: '   ' }, { 'x-jpti-api-token': '   ' })).status, 503, 'a whitespace-only secret is not a secret');
  });
}

test('the department API keeps its established authorisation wording', async () => {
  const response = await routes.department({ JPTI_DB: db, JPTI_JOURNAL_TOKEN: SECRET }, { 'x-jpti-api-token': 'wrong' });
  assert.equal((await response.json()).error, 'Department API authorisation failed.');
});

// --- /api/auth/check --------------------------------------------------------------------------
const check = (env, headers, method = 'GET') => mainHandler({ request: req('/api/auth/check', headers, method), env });

test('auth check: 200 authorised for the correct token, via header or Bearer, with no database needed', async () => {
  for (const headers of [{ 'x-jpti-api-token': SECRET }, { authorization: `Bearer ${SECRET}` }]) {
    const response = await check({ JPTI_JOURNAL_TOKEN: SECRET }, headers);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', authorised: true });
  }
});

test('auth check: tolerates whitespace in the stored secret and honours the JPTI_API_TOKEN fallback', async () => {
  assert.equal((await check({ JPTI_JOURNAL_TOKEN: SECRET + '\n' }, { 'x-jpti-api-token': SECRET })).status, 200);
  assert.equal((await check({ JPTI_API_TOKEN: SECRET }, { 'x-jpti-api-token': SECRET })).status, 200);
});

test('auth check: 401 rejected for a wrong or missing token', async () => {
  for (const headers of [{ 'x-jpti-api-token': 'wrong' }, {}]) {
    const response = await check({ JPTI_JOURNAL_TOKEN: SECRET }, headers);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.status, 'rejected');
    assert.equal(body.authorised, false);
  }
});

test('auth check: an unconfigured server is 409 (never 5xx, so it is not read as an outage)', async () => {
  const response = await check({}, { 'x-jpti-api-token': SECRET });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.status, 'unconfigured');
  assert.equal(body.authorised, false);
});

test('auth check: GET only, never echoes any token, never cached', async () => {
  assert.equal((await check({ JPTI_JOURNAL_TOKEN: SECRET }, { 'x-jpti-api-token': SECRET }, 'POST')).status, 405);
  for (const response of [await check({ JPTI_JOURNAL_TOKEN: SECRET }, { 'x-jpti-api-token': SECRET }), await check({ JPTI_JOURNAL_TOKEN: SECRET }, { 'x-jpti-api-token': 'guess-123' })]) {
    assert.match(response.headers.get('cache-control') || '', /no-store/);
    const text = await response.text();
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes('guess-123'), false);
  }
});

test('health reports private routes as not ready when the secret is blank', async () => {
  const response = await mainHandler({ request: req('/api/health'), env: { JPTI_DB: db, JPTI_JOURNAL_TOKEN: '  \n' } });
  const data = await response.json();
  assert.equal(data.capabilities.journalAuthConfigured, false);
  assert.equal(data.capabilities.agentFleet, false);
});

// --- client-side outcome mapping --------------------------------------------------------------
test('describeTokenCheck gives one distinct, actionable outcome per server answer', () => {
  assert.equal(describeTokenCheck(200, { authorised: true }).kind, 'ok');
  assert.equal(describeTokenCheck(200, {}).kind, 'error', 'a 200 without authorised:true is never treated as success');
  assert.equal(describeTokenCheck(401, {}).kind, 'rejected');
  assert.equal(describeTokenCheck(409, {}).kind, 'unconfigured');
  assert.equal(describeTokenCheck(500, { error: 'boom' }).message, 'boom');
  assert.match(describeTokenCheck(502).message, /HTTP 502/);
  const kinds = new Set([200, 401, 409, 500].map(code => describeTokenCheck(code, { authorised: code === 200 }).kind));
  assert.equal(kinds.size, 4);
});
