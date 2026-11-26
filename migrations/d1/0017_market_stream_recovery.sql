-- Durable sequence-aware market stream event log and recovery state.
CREATE TABLE IF NOT EXISTS jpti_market_stream_events (
 event_key TEXT PRIMARY KEY, stream_id TEXT NOT NULL, exchange TEXT NOT NULL, market_type TEXT NOT NULL,
 symbol TEXT NOT NULL, event_kind TEXT NOT NULL, event_id TEXT NOT NULL, sequence INTEGER,
 observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 quality TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS jpti_market_stream_event_lookup ON jpti_market_stream_events(exchange,market_type,symbol,event_kind,observed_at DESC);
CREATE INDEX IF NOT EXISTS jpti_market_stream_event_sequence ON jpti_market_stream_events(stream_id,sequence);
CREATE TABLE IF NOT EXISTS jpti_market_stream_state (
 stream_id TEXT PRIMARY KEY, exchange TEXT NOT NULL, market_type TEXT NOT NULL, symbol TEXT NOT NULL,
 status TEXT NOT NULL, last_sequence INTEGER, book_valid INTEGER NOT NULL DEFAULT 0, last_event_at TEXT,
 state_json TEXT NOT NULL CHECK(json_valid(state_json)), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jpti_market_stream_gaps (
 gap_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, exchange TEXT NOT NULL, market_type TEXT NOT NULL,
 symbol TEXT NOT NULL, detected_at TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL,
 recovered_at TEXT
);
CREATE INDEX IF NOT EXISTS jpti_market_stream_gaps_open ON jpti_market_stream_gaps(stream_id,recovered_at,detected_at DESC);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0017_market_stream_recovery');

CREATE TABLE IF NOT EXISTS jpti_market_stream_books (
 stream_id TEXT PRIMARY KEY, exchange TEXT NOT NULL, market_type TEXT NOT NULL, symbol TEXT NOT NULL,
 last_sequence INTEGER, book_valid INTEGER NOT NULL DEFAULT 0, best_bid REAL, best_ask REAL, spread_bps REAL,
 depth_imbalance REAL, notional_imbalance REAL, book_json TEXT NOT NULL CHECK(json_valid(book_json)), updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_market_stream_books_lookup ON jpti_market_stream_books(exchange,market_type,symbol,book_valid,updated_at DESC);
