import test from 'node:test';
import assert from 'node:assert/strict';
import { tokensMatch, requestApiToken } from './token-auth.js';

const requestWith = (headers) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { get: (name) => lower[String(name).toLowerCase()] };
};

test('tokensMatch accepts only an identical non-empty string token', () => {
  assert.equal(tokensMatch('correct-horse-battery', 'correct-horse-battery'), true);
  assert.equal(tokensMatch('correct-horse-battery', 'correct-horse-batterz'), false);
  assert.equal(tokensMatch('correct-horse-battery', 'short'), false);
  assert.equal(tokensMatch('correct-horse-battery', ''), false);
});

test('tokensMatch fails closed when either side is missing or not a string', () => {
  assert.equal(tokensMatch('', ''), false);
  assert.equal(tokensMatch(undefined, undefined), false);
  assert.equal(tokensMatch(undefined, 'anything'), false);
  assert.equal(tokensMatch('secret-token', undefined), false);
  assert.equal(tokensMatch('secret-token', 12345), false);
  assert.equal(tokensMatch(12345, '12345'), false);
});

test('tokensMatch compares multi-byte tokens by bytes without throwing on length mismatch', () => {
  assert.equal(tokensMatch('tökén-€', 'tökén-€'), true);
  assert.equal(tokensMatch('tökén-€', 'token-e'), false);
});

test('requestApiToken reads the x-jpti-api-token header', () => {
  assert.equal(requestApiToken(requestWith({ 'X-JPTI-API-Token': 'abc123' })), 'abc123');
});

test('requestApiToken unwraps a Bearer authorization header case-insensitively', () => {
  assert.equal(requestApiToken(requestWith({ Authorization: 'Bearer abc123' })), 'abc123');
  assert.equal(requestApiToken(requestWith({ Authorization: 'bearer   abc123' })), 'abc123');
});

test('requestApiToken prefers the dedicated header and returns undefined when no credential is sent', () => {
  assert.equal(requestApiToken(requestWith({ 'x-jpti-api-token': 'header-token', authorization: 'Bearer other-token' })), 'header-token');
  assert.equal(requestApiToken(requestWith({})), undefined);
});

test('a Bearer credential authenticates through tokensMatch while a wrong or absent one does not', () => {
  const expected = 'long-random-private-token';
  assert.equal(tokensMatch(expected, requestApiToken(requestWith({ Authorization: 'Bearer ' + expected }))), true);
  assert.equal(tokensMatch(expected, requestApiToken(requestWith({ Authorization: 'Bearer wrong' }))), false);
  assert.equal(tokensMatch(expected, requestApiToken(requestWith({}))), false);
});
