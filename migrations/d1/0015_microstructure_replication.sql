-- JPTI microstructure history: order books, public trades, funding, open interest and liquidations.
CREATE TABLE IF NOT EXISTS jpti_microstructure_observations (
  observation_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  market_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('orderbook','trade','funding','open_interest','liquidation')),
  event_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  quality TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_microstructure_lookup
  ON jpti_microstructure_observations(exchange,market_type,symbol,observation_kind,observed_at DESC);
CREATE INDEX IF NOT EXISTS jpti_microstructure_time
  ON jpti_microstructure_observations(observed_at DESC);
CREATE TABLE IF NOT EXISTS jpti_microstructure_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_microstructure_runs_time ON jpti_microstructure_runs(started_at DESC);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0015_microstructure_replication');
