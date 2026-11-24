-- Durable paper trading ledger, isolated from all exchange order APIs.
CREATE TABLE IF NOT EXISTS jpti_paper_agents (
  agent_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'RESEARCH', virtual_equity_usd REAL NOT NULL DEFAULT 10000,
  status TEXT NOT NULL DEFAULT 'active', promoted_at TEXT, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE TABLE IF NOT EXISTS jpti_paper_trades (
  trade_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, symbol TEXT NOT NULL, direction TEXT NOT NULL,
  status TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, entry_price REAL NOT NULL, exit_price REAL,
  quantity REAL NOT NULL, stop_price REAL NOT NULL, target_price REAL NOT NULL, risk_usd REAL NOT NULL,
  entry_fee_usd REAL NOT NULL DEFAULT 0, exit_fee_usd REAL, gross_pnl_usd REAL, net_pnl_usd REAL, r_multiple REAL,
  regime TEXT, source_candle_at TEXT NOT NULL, payload TEXT NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX IF NOT EXISTS jpti_paper_trades_agent_status ON jpti_paper_trades(agent_id,status,opened_at DESC);
CREATE INDEX IF NOT EXISTS jpti_paper_trades_closed ON jpti_paper_trades(closed_at DESC) WHERE status='closed';
CREATE TABLE IF NOT EXISTS jpti_paper_reviews (
  review_id TEXT PRIMARY KEY, review_date TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload TEXT NOT NULL CHECK (json_valid(payload)), UNIQUE(review_date)
);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0006_autonomous_paper_trading');

CREATE UNIQUE INDEX IF NOT EXISTS jpti_paper_agent_candle_dedupe ON jpti_paper_trades(agent_id,symbol,source_candle_at);
