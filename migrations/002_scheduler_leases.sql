-- Distributed scheduler leadership lease for PostgreSQL deployments.
CREATE TABLE IF NOT EXISTS jpti_scheduler_leases (
  lease_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
