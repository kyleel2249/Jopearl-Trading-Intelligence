import { randomUUID } from 'node:crypto';
import { buildPoolConfig, enforceRowLevelSecurity } from './db-config.js';

const backend = String(process.env.JPTI_STORAGE_BACKEND || (process.env.DATABASE_URL ? 'postgres' : 'file')).toLowerCase();
const ownerId = process.env.JPTI_SCHEDULER_INSTANCE_ID || randomUUID();
const leaseName = 'operations-scheduler';
let pool;
let initialized = false;
let localOwner = null;

export function schedulerLeaseConfig() {
  const leaseMs = Math.max(15000, Math.min(120000, Number(process.env.JPTI_SCHEDULER_LEASE_MS) || 30000));
  const heartbeatMs = Math.max(3000, Math.min(Math.floor(leaseMs / 2), Number(process.env.JPTI_SCHEDULER_HEARTBEAT_MS) || 10000));
  return { backend, ownerId, leaseName, leaseMs, heartbeatMs, coordination: backend === 'postgres' ? 'postgres-distributed' : 'single-process-only' };
}

export async function initializeSchedulerLease() {
  if (initialized) return schedulerLeaseConfig();
  if (backend === 'postgres') {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL scheduler coordination.');
    const pg = await import('pg');
    pool = new pg.Pool(buildPoolConfig({ max: 2, applicationName: 'jpti-scheduler-coordinator' }));
    pool.on('error', error => console.error('JPTI scheduler lease database error:', error.message));
    await pool.query("CREATE TABLE IF NOT EXISTS jpti_scheduler_leases (lease_name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    await enforceRowLevelSecurity(pool);
  }
  initialized = true;
  return schedulerLeaseConfig();
}

export async function acquireSchedulerLease() {
  if (!initialized) throw new Error('Scheduler lease coordinator has not been initialized.');
  if (backend !== 'postgres') {
    if (localOwner && localOwner !== ownerId) return false;
    localOwner = ownerId;
    return true;
  }
  const { leaseMs } = schedulerLeaseConfig();
  const sql = "INSERT INTO jpti_scheduler_leases(lease_name, owner_id, expires_at, updated_at) VALUES($1, $2, NOW() + ($3 * INTERVAL '1 millisecond'), NOW()) ON CONFLICT(lease_name) DO UPDATE SET owner_id=EXCLUDED.owner_id, expires_at=EXCLUDED.expires_at, updated_at=NOW() WHERE jpti_scheduler_leases.expires_at <= NOW() OR jpti_scheduler_leases.owner_id=EXCLUDED.owner_id RETURNING owner_id";
  const result = await pool.query(sql, [leaseName, ownerId, leaseMs]);
  return result.rowCount === 1 && result.rows[0].owner_id === ownerId;
}

export async function releaseSchedulerLease() {
  if (!initialized) return;
  if (backend !== 'postgres') {
    if (localOwner === ownerId) localOwner = null;
    return;
  }
  await pool.query('DELETE FROM jpti_scheduler_leases WHERE lease_name=$1 AND owner_id=$2', [leaseName, ownerId]);
}

export async function closeSchedulerLease() {
  if (pool) { await pool.end(); pool = null; }
  initialized = false;
}

export function getSchedulerLeaseStatus() {
  return { ...schedulerLeaseConfig(), initialized, owner: ownerId };
}
