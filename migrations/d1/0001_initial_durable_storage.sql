-- JPTI Cloudflare D1 durable event store. SQLite/D1-compatible.
CREATE TABLE IF NOT EXISTS jpti_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS jpti_events (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, source TEXT, account_id TEXT, external_id TEXT, symbol TEXT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS jpti_ledger_event_dedupe
  ON jpti_events (source, account_id, external_id, COALESCE(symbol, ''))
  WHERE kind = 'ledger-transaction';
CREATE INDEX IF NOT EXISTS jpti_events_kind_time ON jpti_events (kind, occurred_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS jpti_sync_cursors (
  cursor_key TEXT PRIMARY KEY, cursor_value INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
