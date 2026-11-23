-- Distributed scheduler leadership lease metadata for Cloudflare runtimes.
CREATE TABLE IF NOT EXISTS jpti_scheduler_leases (
  lease_name TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_scheduler_leases_expiry ON jpti_scheduler_leases(expires_at);
