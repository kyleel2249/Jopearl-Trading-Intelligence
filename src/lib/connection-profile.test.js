import test from 'node:test';
import assert from 'node:assert/strict';
import { plainProfileVariables, unsavedSecretCount } from './connection-profile.js';

const variables = { VITE_APP_NAME: 'JPTI', JPTI_JOURNAL_TOKEN: 'new-secret', JPTI_BITGET_API_KEY: 'edited' };

test('new secrets are never written to the plain device profile', () => {
  assert.deepEqual(plainProfileVariables(variables, {}), { VITE_APP_NAME: 'JPTI' });
  assert.equal(unsavedSecretCount(variables, {}), 2);
});

test('legacy secrets survive unchanged until the vault is saved, then are purged', () => {
  const legacy = { JPTI_BITGET_API_KEY: 'old' };
  assert.deepEqual(plainProfileVariables(variables, legacy), { VITE_APP_NAME: 'JPTI', JPTI_BITGET_API_KEY: 'old' });
  assert.deepEqual(plainProfileVariables(variables, legacy, true), { VITE_APP_NAME: 'JPTI' });
});

test('a removed variable is removed from the profile too', () => {
  assert.deepEqual(plainProfileVariables({}, { JPTI_BITGET_API_KEY: 'old' }), {});
});
