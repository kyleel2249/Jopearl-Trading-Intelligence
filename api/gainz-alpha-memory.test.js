import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JPTI_DATA_DIR = mkdtempSync(join(tmpdir(), 'jpti-gainz-memory-'));
process.env.JPTI_STORAGE_BACKEND = 'file';
const { initializeStorage } = await import('./storage.js');
const { cleanGainzOutcome, saveGainzOutcomes, loadGainzOutcomes, MAX_BATCH } = await import('./gainz-alpha-memory.js');
const rec = (o = {}) => ({ id: 'r1', symbol: 'btc/usdt', timeframe: '1h', preset: 'balanced', setupType: 'sweep-reclaim-displacement', direction: 'bearish', outcome: 'win', returnR: 1.5, candleTs: 1700000000000, factors: { trend: 0.8, bad: 'x' }, ...o });

test('cleanGainzOutcome normalizes valid records and clamps untrusted numbers', () => {
  const c = cleanGainzOutcome(rec({ returnR: 9999, confidence: 500 }));
  assert.equal(c.symbol, 'BTC/USDT'); assert.equal(c.returnR, 50); assert.equal(c.confidence, 100); assert.deepEqual(c.factors, { trend: 0.8 });
});
test('cleanGainzOutcome rejects malformed records', () => {
  for (const bad of [null, rec({ outcome: 'maybe' }), rec({ direction: 'sideways' }), rec({ returnR: 'x' }), rec({ candleTs: -1 }), rec({ symbol: '' })]) assert.throws(() => cleanGainzOutcome(bad), /./);
});
test('save is idempotent, reports rejects and load is scoped by symbol and timeframe', async () => {
  await initializeStorage();
  const first = await saveGainzOutcomes([rec(), rec({ id: 'r2', candleTs: 1700000060000 }), rec({ id: 'r3', symbol: 'ETH/USDT' }), { outcome: 'nope' }]);
  assert.equal(first.saved, 3); assert.equal(first.rejected.length, 1);
  const again = await saveGainzOutcomes([rec(), rec({ id: 'r2', candleTs: 1700000060000 })]);
  assert.equal(again.saved, 0); assert.equal(again.duplicates, 2);
  assert.equal((await loadGainzOutcomes({ symbol: 'BTC/USDT', timeframe: '1h' })).length, 2);
  assert.equal((await loadGainzOutcomes({ symbol: 'ETH/USDT' })).length, 1);
  assert.equal((await loadGainzOutcomes({ symbol: 'BTC/USDT', timeframe: '5m' })).length, 0);
});
test('save enforces batch size limits', async () => {
  await initializeStorage();
  await assert.rejects(() => saveGainzOutcomes(Array.from({ length: MAX_BATCH + 1 }, (_, i) => rec({ id: 'x' + i }))), /At most/);
  await assert.rejects(() => saveGainzOutcomes('nope'), /array/);
});
