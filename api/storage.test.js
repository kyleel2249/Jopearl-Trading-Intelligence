import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Hermetic storage: use a fresh temp data dir and the file backend so repeated runs never
// accumulate events in the shared ./data directory. Storage reads these env vars at import time,
// so the module is imported dynamically after they are set.
process.env.JPTI_DATA_DIR = mkdtempSync(join(tmpdir(), 'jpti-storage-test-'));
process.env.JPTI_STORAGE_BACKEND = 'file';
const { appendStoredEvent, appendUniqueLedgerEvent, commitLedgerBatchAndCursor, getOutboxStatus, getStorageStatus, getSyncCursor, initializeStorage, readStoredEvents, setSyncCursor, reserveExecutionIntent, updateExecutionIntent } = await import('./storage.js');

test('file storage initializes and reports its selected backend', async () => {
  const status = await initializeStorage();
  assert.equal(status.backend, 'file');
  assert.equal(status.initialized, true);
  assert.equal(status.durable, false);
});

test('ledger events are idempotent across repeated ingestion', async () => {
  await initializeStorage();
  const id = randomUUID();
  const event = { id:randomUUID(), kind:'ledger-transaction', source:'storage-test', accountId:'test-account', externalId:id,
    eventType:'fill', symbol:'BTC/USDT', occurredAt:new Date().toISOString(), quantity:1, price:100 };
  const first = await appendUniqueLedgerEvent(event);
  const second = await appendUniqueLedgerEvent({ ...event, id:randomUUID() });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.id, first.event.id);
});

test('sync cursors survive module-level scheduler state and never move backwards', async () => {
  await initializeStorage();
  const key = 'storage-test:' + randomUUID();
  assert.equal(await getSyncCursor(key, 123), 123);
  await setSyncCursor(key, 456);
  await setSyncCursor(key, 400);
  assert.equal(await getSyncCursor(key), 456);
});

test('operational events can be read back from the selected storage adapter', async () => {
  await initializeStorage();
  const marker = randomUUID();
  await appendStoredEvent({ id:randomUUID(), kind:'storage-test-event', marker, occurredAt:new Date().toISOString() });
  const events = await readStoredEvents(100, 'storage-test-event');
  assert.ok(events.some(event => event.marker === marker));
  assert.equal(getStorageStatus().initialized, true);
});

test('ledger batch commit is replay-safe and advances its cursor in file mode', async () => {
  await initializeStorage();
  const externalId = 'batch-' + randomUUID();
  const key = 'batch:' + randomUUID();
  const event = { id:randomUUID(), kind:'ledger-transaction', source:'batch-test', accountId:'batch-account',
    externalId, symbol:'ETH/USDT', eventType:'fill', quantity:1, price:2500, occurredAt:new Date().toISOString() };
  const first = await commitLedgerBatchAndCursor([event], key, 500);
  const replay = await commitLedgerBatchAndCursor([{ ...event, id:randomUUID() }], key, 500);
  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 0);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal(await getSyncCursor(key), 500);
  assert.equal(first.transactional, false);
});

test('outbox status is explicit when the file backend is selected', async () => {
  await initializeStorage();
  assert.deepEqual(await getOutboxStatus(), { supported:false, pending:null, processing:null, delivered:null });
});

test('file storage applies kind filtering before the requested result limit', async () => {
  await initializeStorage();
  const marker = randomUUID();
  await appendStoredEvent({ kind:'storage-filter-target', marker, occurredAt:new Date().toISOString() });
  for (let i=0;i<120;i++) await appendStoredEvent({ kind:'storage-filter-noise', marker:'noise-'+i, occurredAt:new Date().toISOString() });
  const events = await readStoredEvents(5, 'storage-filter-target');
  assert.ok(events.some(event => event.marker === marker), 'older matching events should not be hidden by unrelated newer events');
  assert.equal(events.length, 1);
});

test('live execution idempotency fails closed on non-PostgreSQL storage', async () => {
  await initializeStorage();
  assert.equal(getStorageStatus().executionIntentStoreAvailable, false);
  await assert.rejects(() => reserveExecutionIntent({ idempotencyKey:'k', accountId:'a', exchangeId:'bitget', symbol:'BTC/USDT', clientOrderId:'client-123456', request:{} }), /PostgreSQL-backed/);
  await assert.rejects(() => updateExecutionIntent({ idempotencyKey:'k', status:'unknown' }), /PostgreSQL-backed/);
});
