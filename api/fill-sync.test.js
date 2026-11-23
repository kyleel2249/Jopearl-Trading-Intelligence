import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPaginatedTrades, fillSyncConfig, parseFillWatchlist } from './fill-sync.js';

test('fill sync config clamps unsafe page and history settings', () => {
  const config = fillSyncConfig({ JPTI_FILL_SYNC_LOOKBACK_DAYS:'99999', JPTI_FILL_SYNC_PAGE_SIZE:'5000', JPTI_FILL_SYNC_MAX_PAGES:'0', JPTI_FILL_SYNC_OVERLAP_MINUTES:'999' });
  assert.deepEqual(config, { lookbackDays:3650, pageSize:1000, maxPages:1, overlapMs:3_600_000 });
});

test('fill watchlist parser normalizes exchange and market identifiers', () => {
  assert.deepEqual(parseFillWatchlist(' Binance:btc/usdt, bitget:ETH/USDT '), [
    { exchange:'binance', symbol:'BTC/USDT' }, { exchange:'bitget', symbol:'ETH/USDT' }
  ]);
  assert.throws(() => parseFillWatchlist('binance'), /Invalid fill watchlist entry/);
});

test('trade pagination walks bounded pages and deduplicates overlapping exchange results', async () => {
  const all = [
    { id:'t1', timestamp:1000 }, { id:'t2', timestamp:2000 },
    { id:'t3', timestamp:3000 }, { id:'t4', timestamp:4000 },
    { id:'t5', timestamp:5000 }
  ];
  const result = await fetchPaginatedTrades({
    since:0, until:6000, pageSize:2, maxPages:10,
    fetchPage: async (since, limit) => all.filter(x => x.timestamp >= since).slice(0,limit)
  });
  assert.equal(result.pages,3);
  assert.equal(result.rawFetched,5);
  assert.equal(result.uniqueTrades,5);
  assert.deepEqual(result.trades.map(x=>x.id),['t1','t2','t3','t4','t5']);
  assert.equal(result.exhausted,true);
  assert.equal(result.pageLimitReached,false);
});

test('trade pagination stops at page cap and reports incomplete history', async () => {
  const result = await fetchPaginatedTrades({
    since:0, until:10000, pageSize:2, maxPages:1,
    fetchPage: async () => [{id:'a',timestamp:1000},{id:'b',timestamp:2000}]
  });
  assert.equal(result.pages,1);
  assert.equal(result.pageLimitReached,true);
  assert.equal(result.exhausted,false);
});

test('trade pagination rejects invalid ranges and non-array provider responses', async () => {
  await assert.rejects(() => fetchPaginatedTrades({ since:100, until:100, fetchPage:async()=>[] }), /later than its start/);
  await assert.rejects(() => fetchPaginatedTrades({ since:0, until:100, fetchPage:async()=>null }), /not an array/);
});

test('trade pagination excludes records later than requested backfill end', async () => {
  const result = await fetchPaginatedTrades({
    since:0, until:2500, pageSize:10, maxPages:2,
    fetchPage:async()=>[{id:'a',timestamp:1000},{id:'b',timestamp:3000}]
  });
  assert.deepEqual(result.trades.map(x=>x.id),['a']);
});
