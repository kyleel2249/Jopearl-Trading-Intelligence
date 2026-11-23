import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalRunHistory } from './local-run-history.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); }
  };
}

test('local run history stores, deduplicates and bounds completed runs', async () => {
  const history = new LocalRunHistory(memoryStorage(), 'runs', 2);
  await history.saveRun({ runId: 'one', recap: { pnl: 1 } });
  await history.saveRun({ runId: 'two', recap: { pnl: 2 } });
  await history.saveRun({ runId: 'two', recap: { pnl: 3 } });
  await history.saveRun({ runId: 'three', recap: { pnl: 4 } });
  const runs = await history.listRuns();
  assert.deepEqual(runs.map(item => item.runId), ['three', 'two']);
  assert.equal(runs[1].recap.pnl, 3);
});

test('local run history rejects malformed records and handles missing storage', async () => {
  const unavailable = new LocalRunHistory(null);
  assert.equal(unavailable.enabled, false);
  assert.deepEqual(await unavailable.listRuns(), []);
  await assert.rejects(() => unavailable.saveRun({ runId: 'one' }), /unavailable/);
  const history = new LocalRunHistory(memoryStorage());
  await assert.rejects(() => history.saveRun({}), /runId is required/);
});
