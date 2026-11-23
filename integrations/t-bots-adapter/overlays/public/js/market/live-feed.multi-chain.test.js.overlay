import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveFeed, mapPair } from './live-feed.js';

test('maps a DEX pair with chain and contract identity', () => {
  const mapped = mapPair({ chainId: 'base', baseToken: { address: '0xabc', symbol: 'ABC' },
    liquidity: { usd: 20000 }, volume: { m5: 1000, h1: 6000 }, txns: { m5: { buys: 8, sells: 2 } },
    priceUsd: '0.25', pairCreatedAt: Date.now() - 60000 });
  assert.equal(mapped.chainId, 'base');
  assert.equal(mapped.tokenAddress, '0xabc');
  assert.equal(mapped.id, '0xabc');
});

test('discovers tokens across chains and keeps unsupported security evidence fail-closed', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    if (url.includes('token-profiles/latest')) return { ok: true, json: async () => [
      { chainId: 'ethereum', tokenAddress: '0xabc' },
      { chainId: 'unknown-chain', tokenAddress: '0xdef' }
    ] };
    if (url.includes('/tokens/v1/ethereum/')) return { ok: true, json: async () => [
      { chainId: 'ethereum', baseToken: { address: '0xabc', symbol: 'ABC' }, dexId: 'uniswap',
        priceUsd: '1', pairCreatedAt: Date.now() - 60000, liquidity: { usd: 50000 },
        volume: { m5: 1000, h1: 12000 }, txns: { m5: { buys: 8, sells: 2 } }, priceChange: { h1: 2 } }
    ] };
    if (url.includes('/tokens/v1/unknown-chain/')) return { ok: true, json: async () => [
      { chainId: 'unknown-chain', baseToken: { address: '0xdef', symbol: 'DEF' }, dexId: 'dex',
        priceUsd: '1', pairCreatedAt: Date.now() - 60000, liquidity: { usd: 50000 },
        volume: { m5: 1000, h1: 12000 }, txns: { m5: { buys: 8, sells: 2 } }, priceChange: { h1: 2 } }
    ] };
    return { ok: true, json: async () => ({}) };
  };
  const feed = new LiveFeed({ fetchImpl, maxTracked: 10 });
  await feed.tick();
  const snapshot = feed.snapshot();
  assert.equal(snapshot.length, 2);
  assert.ok(snapshot.some(token => token.chain === 'ethereum'));
  assert.ok(snapshot.some(token => token.chain === 'unknown-chain'));
  assert.ok(snapshot.every(token => token.security?.failedLookup === true));
  assert.ok(calls.some(url => url.includes('/tokens/v1/ethereum/')));
  assert.ok(calls.some(url => url.includes('/tokens/v1/unknown-chain/')));
});
