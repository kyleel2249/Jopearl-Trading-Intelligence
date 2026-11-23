import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDexPair, scoreAssetEvidence, summarizeBotMemory } from './multi-asset-intelligence.js';

test('normalizes multi-chain DEX pairs without assuming Solana', () => {
  const asset = normalizeDexPair({ chainId: 'base', dexId: 'uniswap', pairAddress: '0xpair',
    baseToken: { address: '0xtoken', symbol: 'ABC' }, quoteToken: { address: '0xusd', symbol: 'USDC' },
    liquidity: { usd: 50000 }, volume: { h24: 200000, h1: 30000 }, priceChange: { h1: 4 }, txns: { h1: { buys: 80, sells: 20 } } });
  assert.equal(asset.chain, 'base');
  assert.equal(asset.base.address, '0xtoken');
  assert.equal(scoreAssetEvidence(asset).verdict, 'watchlist_candidate');
});

test('flags missing evidence and bounds the heuristic score', () => {
  const result = scoreAssetEvidence({ liquidityUsd: 0, volume24hUsd: 0, base: {}, quote: {} });
  assert.ok(result.score >= 0 && result.score <= 100);
  assert.ok(result.warnings.includes('missing_token_address'));
  assert.equal(result.verdict, 'insufficient_evidence');
});

test('shared memory summarizes closed paper trades and consecutive losses', () => {
  const events = [-2, -1, -3].map((pnl, i) => ({ eventType: 'bot_trade', occurredAt: new Date().toISOString(),
    metadata: { action: 'paper_closed', pnl }, ingestedAt: new Date().toISOString(), id: String(i) }));
  const result = summarizeBotMemory(events);
  assert.equal(result.totalClosedTrades, 3);
  assert.equal(result.recentLossStreak, 3);
  assert.equal(result.guard, 'pause_new_entries');
  assert.equal(result.rolling24hRealizedPnl, -6);
});
