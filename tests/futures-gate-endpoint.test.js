import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pretradeRouter } from '../api/pretrade-risk.js';

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/risk', pretradeRouter);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { return await run('http://127.0.0.1:' + server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}
const post = (base, body) => fetch(base + '/api/risk/futures-gate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the futures gate endpoint evaluates a plan and never authorizes orders', async () => {
  await withServer(async (base) => {
    const ok = await post(base, { product: 'futures', side: 'long', entry: 100, stop: 95, equity: 10000, riskPercent: 1, leverage: 10, takerFeeBps: 0 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.decision, 'eligible');
    assert.equal(ok.body.permissions.liveExecutionAuthorized, false);
    assert.equal(ok.body.permissions.ordersCreated, 0);
    const blocked = await post(base, { product: 'futures', side: 'long', entry: 100, stop: 95, equity: 10000, riskPercent: 1, leverage: 20 });
    assert.equal(blocked.body.decision, 'blocked');
    assert.ok(blocked.body.failedChecks.includes('liquidation_buffer'));
    assert.equal((await post(base, { product: 'cfd' })).body.decision, 'unsupported');
    assert.equal((await post(base, {})).body.decision, 'blocked');
  });
});
