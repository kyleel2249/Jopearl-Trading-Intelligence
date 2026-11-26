-- Server-recomputed strategy validation evidence. Client-supplied verdicts are never authoritative.
CREATE TABLE IF NOT EXISTS jpti_strategy_validation_runs (
 run_id TEXT PRIMARY KEY,
 strategy_id TEXT NOT NULL,
 symbol TEXT NOT NULL,
 exchange TEXT NOT NULL,
 market_type TEXT NOT NULL,
 timeframe TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('LIVE_READY','RESEARCH_ONLY','INSUFFICIENT_DATA','ERROR')),
 candle_count INTEGER NOT NULL DEFAULT 0,
 backtest_json TEXT NOT NULL CHECK(json_valid(backtest_json)),
 heldout_json TEXT NOT NULL CHECK(json_valid(heldout_json)),
 monte_carlo_json TEXT NOT NULL CHECK(json_valid(monte_carlo_json)),
 forward_json TEXT NOT NULL CHECK(json_valid(forward_json)),
 risk_json TEXT NOT NULL CHECK(json_valid(risk_json)),
 verdict_json TEXT NOT NULL CHECK(json_valid(verdict_json)),
 data_from TEXT,
 data_to TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_strategy_validation_latest ON jpti_strategy_validation_runs(strategy_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_strategy_validation_symbol ON jpti_strategy_validation_runs(exchange,market_type,symbol,timeframe,created_at DESC);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0016_strategy_validation');
