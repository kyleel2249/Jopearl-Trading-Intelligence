import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrossVenueComparison } from './market-intelligence.js';

test('cross-venue comparison calculates median, spread and indicative top-of-book edge', () => {
  const result = buildCrossVenueComparison('BTC/USDT', [
    { exchange: 'alpha', last: 100, bid: 99, ask: 101 },
    { exchange: 'beta', last: 104, bid: 103, ask: 105 },
    { exchange: 'gamma', last: 101, bid: 100, ask: 102 }
  ]);
  assert.equal(result.venueCount, 3);
  assert.equal(result.medianLast, 101);
  assert.ok(result.lastPriceSpreadPercent > 0);
  assert.equal(result.bestIndicativeTopOfBook.buyVenue, 'alpha');
  assert.equal(result.bestIndicativeTopOfBook.sellVenue, 'beta');
  assert.ok(result.bestIndicativeTopOfBook.grossEdgePercent > 0);
});

test('cross-venue comparison excludes invalid last prices and avoids false arbitrage across one venue', () => {
  const result = buildCrossVenueComparison('ETH/USDT', [
    { exchange: 'alpha', last: 0, bid: 0, ask: 0 },
    { exchange: 'beta', last: 2000, bid: 1999, ask: 2001 }
  ]);
  assert.equal(result.venueCount, 1);
  assert.equal(result.bestIndicativeTopOfBook, null);
  assert.equal(result.medianLast, 2000);
});

test('cross-venue comparison never reports a same-venue quote as arbitrage', () => {
  const result = buildCrossVenueComparison('SOL/USDT', [
    { exchange: 'only', last: 150, bid: 149, ask: 151 }
  ]);
  assert.equal(result.bestIndicativeTopOfBook, null);
});

test('production ticker comparison rejects stale, unsynchronised and outlier venue quotes', async () => {
  const { buildSynchronizedCrossVenueComparison } = await import('./market-intelligence.js');
  const now = Date.now();
  const observations = [
    { exchange:'alpha', last:100, bid:99.9, ask:100.1, timestamp:new Date(now).toISOString() },
    { exchange:'beta', last:100.1, bid:100, ask:100.2, timestamp:new Date(now-100).toISOString() },
    { exchange:'gamma', last:150, bid:149, ask:151, timestamp:new Date(now-200).toISOString() },
    { exchange:'stale', last:100, bid:99, ask:101, timestamp:new Date(now-60000).toISOString() }
  ];
  const result = buildSynchronizedCrossVenueComparison('BTC/USDT', observations, 0.5, now);
  assert.equal(result.synchronization.synchronized, true);
  assert.deepEqual(result.synchronization.acceptedVenues.sort(), ['alpha','beta']);
  assert.equal(result.venueCount, 2);
  assert.ok(result.synchronization.rejectedVenues.some(item => item.venue === 'gamma'));
  const unavailable = buildSynchronizedCrossVenueComparison('BTC/USDT', observations.map(item => ({...item,timestamp:new Date(now-60000).toISOString()})), 0.5, now);
  assert.equal(unavailable.synchronization.synchronized, false);
  assert.equal(unavailable.venueCount, 0);
  assert.equal(unavailable.bestIndicativeTopOfBook, null);
});
