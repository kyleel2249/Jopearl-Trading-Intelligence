import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireSchedulerLease, closeSchedulerLease, getSchedulerLeaseStatus, initializeSchedulerLease, releaseSchedulerLease } from './scheduler-lease.js';

test('file-mode scheduler lease is initialized, renewable by its owner, and releasable', async () => {
  const status = await initializeSchedulerLease();
  assert.equal(status.backend, 'file');
  assert.equal(status.coordination, 'single-process-only');
  assert.equal(getSchedulerLeaseStatus().initialized, true);
  assert.equal(await acquireSchedulerLease(), true);
  assert.equal(await acquireSchedulerLease(), true);
  await releaseSchedulerLease();
  assert.equal(await acquireSchedulerLease(), true);
  await releaseSchedulerLease();
  await closeSchedulerLease();
});
