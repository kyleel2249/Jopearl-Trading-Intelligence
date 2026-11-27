-- Extend durable market observations to include validated instrument metadata.
-- Rebuild the table because SQLite cannot alter an existing CHECK constraint in place.
CREATE TABLE jpti_market_observations_rebuild (
  observation_key TEXT PRIMARY KEY,
  exchange TEXT NOT NULL,
  market_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  observation_kind TEXT NOT NULL CHECK (observation_kind IN ('ticker','ohlcv','markets')),
  timeframe TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  quality TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO jpti_market_observations_rebuild (
  observation_key, exchange, market_type, symbol, observation_kind,
  timeframe, observed_at, received_at, payload, quality, created_at
)
SELECT
  observation_key, exchange, market_type, symbol, observation_kind,
  timeframe, observed_at, received_at, payload, quality, created_at
FROM jpti_market_observations;

DROP TABLE jpti_market_observations;
ALTER TABLE jpti_market_observations_rebuild RENAME TO jpti_market_observations;

CREATE INDEX jpti_market_observations_lookup
  ON jpti_market_observations(exchange, market_type, symbol, observation_kind, timeframe, observed_at DESC);
CREATE INDEX jpti_market_observations_time
  ON jpti_market_observations(observed_at DESC);

INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0020_market_catalog_observations');
