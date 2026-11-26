-- Continuous multi-exchange market-data replication.
-- Immutable observations are separate from the latest-route cache in jpti_events.
CREATE TABLE IF NOT EXISTS jpti_market_observations (
  observation_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  market_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('ticker','ohlcv')),
  timeframe TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  quality TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_market_observations_lookup
  ON jpti_market_observations(exchange, market_type, symbol, observation_kind, timeframe, observed_at DESC);
CREATE INDEX IF NOT EXISTS jpti_market_observations_time
  ON jpti_market_observations(observed_at DESC);
CREATE TABLE IF NOT EXISTS jpti_market_replication_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running','completed','partial','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  plan_json TEXT NOT NULL CHECK (json_valid(plan_json)),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  errors_json TEXT NOT NULL CHECK (json_valid(errors_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_market_replication_runs_time
  ON jpti_market_replication_runs(started_at DESC);
CREATE TABLE IF NOT EXISTS jpti_market_replication_cursors (
  cursor_key TEXT PRIMARY KEY,
  cursor_value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0014_market_data_replication');
