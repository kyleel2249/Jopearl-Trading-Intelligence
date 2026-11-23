-- JPTI durable operational event store
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

CREATE TABLE IF NOT EXISTS jpti_sync_cursors (
  cursor_key TEXT PRIMARY KEY,
  cursor_value BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jpti_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
