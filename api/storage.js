import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPoolConfig, enforceRowLevelSecurity } from './db-config.js';

const dataDir = resolve(process.env.JPTI_DATA_DIR || 'data');
const eventsFile = resolve(dataDir, 'jpti-events.jsonl');
const cursorsFile = resolve(dataDir, 'jpti-cursors.json');
const backend = String(process.env.JPTI_STORAGE_BACKEND || (process.env.DATABASE_URL ? 'postgres' : 'file')).toLowerCase();
let pool;
let initialized = false;
let fileWriteQueue = Promise.resolve();
let cursorWriteQueue = Promise.resolve();

const migration = `
CREATE TABLE IF NOT EXISTS jpti_events (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT,
  account_id TEXT,
  external_id TEXT,
  symbol TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS jpti_ledger_event_dedupe
  ON jpti_events (source, account_id, external_id, COALESCE(symbol, ''))
  WHERE kind = 'ledger-transaction';
CREATE INDEX IF NOT EXISTS jpti_events_kind_time
  ON jpti_events (kind, occurred_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS jpti_outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_until TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jpti_outbox_ready ON jpti_outbox(status, available_at, created_at);
CREATE TABLE IF NOT EXISTS jpti_sync_cursors (
  cursor_key TEXT PRIMARY KEY,
  cursor_value BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jpti_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function getPool() {
  if (pool) return pool;
  const pg = await import('pg');
  pool = new pg.Pool(buildPoolConfig({ max: process.env.JPTI_DATABASE_POOL_MAX, applicationName: 'jpti-trading-intelligence' }));
  pool.on('error', (error) => {
    console.error('JPTI PostgreSQL pool error:', error.message);
  });
  return pool;
}

export async function initializeStorage() {
  if (initialized) return getStorageStatus();
  if (!['file', 'postgres'].includes(backend)) throw new Error('JPTI_STORAGE_BACKEND must be file or postgres.');
  if (backend === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required when JPTI_STORAGE_BACKEND=postgres.');
    const db = await getPool();
    await db.query(migration);
    const rlsEnforced = await enforceRowLevelSecurity(db);
    await db.query("INSERT INTO jpti_schema_migrations(version) VALUES ('001_initial_durable_storage'),('003_transactional_ledger_outbox') ON CONFLICT DO NOTHING");
    if (rlsEnforced) await db.query("INSERT INTO jpti_schema_migrations(version) VALUES ('004_supabase_rls') ON CONFLICT DO NOTHING");
  } else {
    await mkdir(dataDir, { recursive: true });
  }
  initialized = true;
  return getStorageStatus();
}

function assertInitialized() {
  if (!initialized) throw new Error('JPTI storage has not been initialized.');
}

async function readFileEvents(limit) {
  try {
    const raw = await readFile(eventsFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const selected = Number.isFinite(limit) ? lines.slice(-Math.max(1, limit)) : lines;
    return selected.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function readStoredEvents(limit = 20000, kind = null) {
  assertInitialized();
  if (backend === 'file') {
    const events = await readFileEvents(kind ? Infinity : limit);
    const filtered = kind ? events.filter(event => event.kind === kind) : events;
    return Number.isFinite(limit) ? filtered.slice(-Math.max(1, limit)) : filtered;
  }
  const db = await getPool();
  const values = kind ? [kind, Number.isFinite(limit) ? Math.max(1, limit) : 1000000] : [Number.isFinite(limit) ? Math.max(1, limit) : 1000000];
  const where = kind ? 'WHERE kind = $1' : '';
  const limitParam = kind ? '$2' : '$1';
  const result = await db.query(`SELECT payload FROM jpti_events ${where} ORDER BY created_at DESC LIMIT ${limitParam}`, values);
  return result.rows.reverse().map(row => row.payload);
}

async function appendFileEvent(event) {
  fileWriteQueue = fileWriteQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(eventsFile), { recursive: true });
    await appendFile(eventsFile, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
  });
  await fileWriteQueue;
  return event;
}

export async function appendStoredEvent(input) {
  assertInitialized();
  const event = { id: input.id || randomUUID(), ...input };
  if (backend === 'file') return appendFileEvent(event);
  const db = await getPool();
  await db.query(
    'INSERT INTO jpti_events(id,kind,source,account_id,external_id,symbol,occurred_at,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
    [event.id, event.kind || 'operational-event', event.source || null, event.accountId || null, event.externalId || null, event.symbol || null,
      event.occurredAt || event.ingestedAt || new Date().toISOString(), JSON.stringify(event)]
  );
  return event;
}

export async function appendUniqueLedgerEvent(input) {
  assertInitialized();
  const event = { id: input.id || randomUUID(), kind: 'ledger-transaction', ...input };
  if (backend === 'file') {
    let result;
    fileWriteQueue = fileWriteQueue.catch(() => {}).then(async () => {
      const events = await readFileEvents(Infinity);
      const duplicate = events.find(item => item.kind === 'ledger-transaction' && item.source === event.source &&
        item.accountId === event.accountId && item.externalId === event.externalId && item.symbol === event.symbol);
      if (duplicate) { result = { duplicate: true, event: duplicate }; return; }
      await mkdir(dirname(eventsFile), { recursive: true });
      await appendFile(eventsFile, JSON.stringify(event) + '\n', { encoding: 'utf8', mode: 0o600 });
      result = { duplicate: false, event };
    });
    await fileWriteQueue;
    return result;
  }
  const db = await getPool();
  const result = await db.query(
    "INSERT INTO jpti_events(id,kind,source,account_id,external_id,symbol,occurred_at,payload) VALUES($1,'ledger-transaction',$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (source,account_id,external_id,(COALESCE(symbol,''))) WHERE kind='ledger-transaction' DO NOTHING RETURNING payload",
    [event.id, event.source, event.accountId, event.externalId, event.symbol || null, event.occurredAt || event.ingestedAt || new Date().toISOString(), JSON.stringify(event)]
  );
  if (result.rowCount) return { duplicate: false, event: result.rows[0].payload };
  const duplicate = await db.query(
    "SELECT payload FROM jpti_events WHERE kind='ledger-transaction' AND source=$1 AND account_id=$2 AND external_id=$3 AND COALESCE(symbol,'')=COALESCE($4,'') LIMIT 1",
    [event.source, event.accountId, event.externalId, event.symbol || null]
  );
  return { duplicate: true, event: duplicate.rows[0]?.payload || null };
}


export async function commitLedgerBatchAndCursor(events, cursorKey, cursorValue) {
  assertInitialized();
  if (!Array.isArray(events) || !cursorKey) throw new Error('Ledger batch and cursor key are required.');
  const cursor = Math.max(0, Math.floor(Number(cursorValue)));
  if (!Number.isFinite(cursor)) throw new Error('Sync cursor must be a finite non-negative number.');
  const normalized = events.map(input => ({ id: input.id || randomUUID(), kind: 'ledger-transaction', ...input }));
  if (backend === 'file') {
    let inserted = 0, duplicates = 0;
    for (const event of normalized) {
      const result = await appendUniqueLedgerEvent(event);
      if (result.duplicate) duplicates++; else inserted++;
    }
    await setSyncCursor(cursorKey, cursor);
    return { inserted, duplicates, cursor, transactional: false, outboxEnqueued: 0 };
  }
  const db = await getPool();
  const client = await db.connect();
  let inserted = 0, duplicates = 0;
  try {
    await client.query('BEGIN');
    for (const event of normalized) {
      const result = await client.query(
        "INSERT INTO jpti_events(id,kind,source,account_id,external_id,symbol,occurred_at,payload) VALUES($1,'ledger-transaction',$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT (source,account_id,external_id,(COALESCE(symbol,''))) WHERE kind='ledger-transaction' DO NOTHING RETURNING id",
        [event.id, event.source, event.accountId, event.externalId, event.symbol || null,
          event.occurredAt || event.ingestedAt || new Date().toISOString(), JSON.stringify(event)]
      );
      if (result.rowCount) {
        inserted++;
        await client.query(
          "INSERT INTO jpti_outbox(event_id,event_type,payload) VALUES($1,'ledger.transaction.recorded',$2::jsonb) ON CONFLICT(event_id) DO NOTHING",
          [event.id, JSON.stringify({ eventId: event.id, source: event.source, accountId: event.accountId, externalId: event.externalId, symbol: event.symbol || null })]
        );
      } else duplicates++;
    }
    await client.query(
      'INSERT INTO jpti_sync_cursors(cursor_key,cursor_value) VALUES($1,$2) ON CONFLICT(cursor_key) DO UPDATE SET cursor_value=GREATEST(jpti_sync_cursors.cursor_value,EXCLUDED.cursor_value),updated_at=NOW()',
      [cursorKey, cursor]
    );
    await client.query('COMMIT');
    return { inserted, duplicates, cursor, transactional: true, outboxEnqueued: inserted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimOutboxMessages({ workerId, limit = 25, leaseMs = 30000 } = {}) {
  assertInitialized();
  if (backend !== 'postgres') throw new Error('Transactional outbox claiming requires PostgreSQL storage.');
  if (!workerId || typeof workerId !== 'string' || workerId.length > 128) throw new Error('A valid outbox workerId is required.');
  const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 25)));
  const safeLease = Math.max(5000, Math.min(300000, Math.floor(Number(leaseMs) || 30000)));
  const db = await getPool();
  const result = await db.query(
    "WITH candidates AS (SELECT id FROM jpti_outbox WHERE (status='pending' AND available_at<=NOW()) OR (status='processing' AND locked_until<=NOW()) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED) UPDATE jpti_outbox o SET status='processing',locked_by=$2,locked_until=NOW()+($3 * INTERVAL '1 millisecond'),attempts=o.attempts+1,updated_at=NOW() FROM candidates c WHERE o.id=c.id RETURNING o.id,o.event_id,o.event_type,o.payload,o.attempts",
    [safeLimit, workerId, safeLease]
  );
  return result.rows;
}

export async function acknowledgeOutboxMessage({ id, workerId } = {}) {
  assertInitialized();
  if (backend !== 'postgres') throw new Error('Transactional outbox acknowledgement requires PostgreSQL storage.');
  const result = await (await getPool()).query(
    "UPDATE jpti_outbox SET status='delivered',delivered_at=NOW(),locked_by=NULL,locked_until=NULL,updated_at=NOW() WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id",
    [id, workerId]
  );
  return result.rowCount === 1;
}

export async function retryOutboxMessage({ id, workerId, error, delayMs = 5000 } = {}) {
  assertInitialized();
  if (backend !== 'postgres') throw new Error('Transactional outbox retry requires PostgreSQL storage.');
  const delay = Math.max(1000, Math.min(3600000, Math.floor(Number(delayMs) || 5000)));
  const result = await (await getPool()).query(
    "UPDATE jpti_outbox SET status='pending',available_at=NOW()+($3 * INTERVAL '1 millisecond'),locked_by=NULL,locked_until=NULL,last_error=$4,updated_at=NOW() WHERE id=$1 AND status='processing' AND locked_by=$2 RETURNING id",
    [id, workerId, delay, String(error || 'Delivery failed').slice(0, 1000)]
  );
  return result.rowCount === 1;
}

export async function getOutboxStatus() {
  assertInitialized();
  if (backend !== 'postgres') return { supported: false, pending: null, processing: null, delivered: null };
  const result = await (await getPool()).query("SELECT status,COUNT(*)::int AS count FROM jpti_outbox GROUP BY status");
  const counts = Object.fromEntries(result.rows.map(row => [row.status, row.count]));
  return { supported: true, pending: counts.pending || 0, processing: counts.processing || 0, delivered: counts.delivered || 0 };
}

export async function getSyncCursor(key, fallback = null) {
  assertInitialized();
  if (backend === 'postgres') {
    const result = await (await getPool()).query('SELECT cursor_value FROM jpti_sync_cursors WHERE cursor_key=$1', [key]);
    return result.rows.length ? Number(result.rows[0].cursor_value) : fallback;
  }
  try {
    const parsed = JSON.parse(await readFile(cursorsFile, 'utf8'));
    return Number.isFinite(Number(parsed[key])) ? Number(parsed[key]) : fallback;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function setSyncCursor(key, value) {
  assertInitialized();
  const cursor = Math.max(0, Math.floor(Number(value)));
  if (!Number.isFinite(cursor)) throw new Error('Sync cursor must be a finite non-negative number.');
  if (backend === 'postgres') {
    await (await getPool()).query(
      'INSERT INTO jpti_sync_cursors(cursor_key,cursor_value) VALUES($1,$2) ON CONFLICT(cursor_key) DO UPDATE SET cursor_value=GREATEST(jpti_sync_cursors.cursor_value,EXCLUDED.cursor_value),updated_at=NOW()',
      [key, cursor]
    );
    return cursor;
  }
  cursorWriteQueue = cursorWriteQueue.catch(() => {}).then(async () => {
    let current = {};
    try { current = JSON.parse(await readFile(cursorsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    current[key] = Math.max(Number(current[key]) || 0, cursor);
    await mkdir(dataDir, { recursive: true });
    const temp = cursorsFile + '.tmp';
    await writeFile(temp, JSON.stringify(current, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, cursorsFile);
  });
  await cursorWriteQueue;
  return cursor;
}

export function getStorageStatus() {
  return { backend, durable: backend === 'postgres', initialized, databaseConfigured: Boolean(process.env.DATABASE_URL) };
}

export async function closeStorage() {
  if (pool) { await pool.end(); pool = null; }
  initialized = false;
}
