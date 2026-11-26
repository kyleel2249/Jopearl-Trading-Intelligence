import test from 'node:test';
import assert from 'node:assert/strict';
import { describePrivateFailure } from './private-access.js';

test('a 401 without a session token asks the user to enter one', () => {
  const result = describePrivateFailure(401, { error: 'Department API authorisation failed.' }, false);
  assert.equal(result.kind, 'missing');
  assert.equal(result.needsSettings, true);
  assert.match(result.message, /no access token/);
});

test('a 401 with a token reports a mismatch and keeps the server wording', () => {
  const result = describePrivateFailure(401, { error: 'Department API authorisation failed.' }, true);
  assert.equal(result.kind, 'rejected');
  assert.match(result.message, /^Department API authorisation failed\. .*does not match/);
});

test('a missing server secret is distinguished from a storage outage', () => {
  assert.equal(describePrivateFailure(503, { error: 'Set the JPTI_JOURNAL_TOKEN Cloudflare secret.' }, true).kind, 'unconfigured');
  assert.equal(describePrivateFailure(503, { error: 'Cloudflare D1 binding JPTI_DB is unavailable.' }, true).kind, 'error');
  assert.equal(describePrivateFailure(500, {}, true).message, 'Request failed (HTTP 500).');
});
