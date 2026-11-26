-- JPTI Multi-Asset Intelligence 3.0: persistent instrument, agent, replay and governance state.
CREATE TABLE IF NOT EXISTS jpti_multi_asset_instruments (
 instrument_id TEXT PRIMARY KEY, asset_class TEXT NOT NULL CHECK(asset_class IN ('crypto','equity','commodity','index','fx','onchain')),
 symbol TEXT NOT NULL, market_type TEXT NOT NULL, venue TEXT NOT NULL DEFAULT 'unconfigured',
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), provider_status TEXT NOT NULL DEFAULT 'provider-required',
 metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)), updated_at TEXT NOT NULL,
 UNIQUE(asset_class,symbol,market_type,venue)
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_agent_roster (
 agent_id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, display_name TEXT NOT NULL, specialty TEXT NOT NULL,
 style TEXT NOT NULL, timeframe TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 execution_permission TEXT NOT NULL DEFAULT 'none' CHECK(execution_permission='none'), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_decisions (
 decision_id TEXT PRIMARY KEY, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, venue TEXT NOT NULL,
 agent_squad TEXT NOT NULL, direction TEXT NOT NULL, score REAL, confidence REAL, eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
 action TEXT NOT NULL CHECK(action IN ('PAPER_CANDIDATE','ABSTAIN')), veto_json TEXT NOT NULL CHECK(json_valid(veto_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_multi_asset_decisions_recent ON jpti_multi_asset_decisions(asset_class,symbol,created_at DESC);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_backfill_cursors (
 cursor_id TEXT PRIMARY KEY, provider TEXT NOT NULL, asset_class TEXT NOT NULL, symbol TEXT NOT NULL,
 market_type TEXT NOT NULL, stream_kind TEXT NOT NULL, cursor_value TEXT, status TEXT NOT NULL DEFAULT 'ready',
 records_ingested INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_strategy_performance (
 strategy_id TEXT NOT NULL, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, window_start TEXT NOT NULL,
 window_end TEXT NOT NULL, closed_trades INTEGER NOT NULL DEFAULT 0, expectancy_r REAL, profit_factor REAL,
 max_drawdown_pct REAL, decay_detected INTEGER NOT NULL DEFAULT 0, risk_breaches INTEGER NOT NULL DEFAULT 0,
 data_integrity TEXT NOT NULL DEFAULT 'unverified', lifecycle_status TEXT NOT NULL DEFAULT 'observing',
 metrics_json TEXT NOT NULL CHECK(json_valid(metrics_json)), updated_at TEXT NOT NULL,
 PRIMARY KEY(strategy_id,asset_class,symbol,window_end)
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_capital_allocations (
 allocation_id TEXT PRIMARY KEY, portfolio_equity_usd REAL NOT NULL, portfolio_risk_budget_usd REAL NOT NULL,
 drawdown_pct REAL NOT NULL, allocations_json TEXT NOT NULL CHECK(json_valid(allocations_json)),
 blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_replay_checkpoints (
 replay_id TEXT NOT NULL, stream_id TEXT NOT NULL, last_event_time TEXT NOT NULL, last_sequence INTEGER,
 processed_events INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
 updated_at TEXT NOT NULL, PRIMARY KEY(replay_id,stream_id)
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_reconciliation (
 reconciliation_id TEXT PRIMARY KEY, matched INTEGER NOT NULL, discrepancy_count INTEGER NOT NULL,
 discrepancies_json TEXT NOT NULL CHECK(json_valid(discrepancies_json)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jpti_multi_asset_strategy_lifecycle (
 strategy_id TEXT NOT NULL, asset_class TEXT NOT NULL, symbol TEXT NOT NULL, status TEXT NOT NULL,
 reason_json TEXT NOT NULL CHECK(json_valid(reason_json)), human_review_required INTEGER NOT NULL DEFAULT 1,
 updated_at TEXT NOT NULL, PRIMARY KEY(strategy_id,asset_class,symbol)
);

INSERT OR IGNORE INTO jpti_multi_asset_agent_roster(agent_id,squad_id,display_name,specialty,style,timeframe,enabled,execution_permission,updated_at) VALUES
('nyx','scalping','Nyx','Microstructure & tape-reading sniper','Scalping','1m-5m',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('vega','scalping','Vega','Liquidity sweep and stop-run analyst','Scalping','1m-5m',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('cipher','scalping','Cipher','FVG, displacement and mitigation specialist','Scalping','1m-5m',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('razor','scalping','Razor','Spread, slippage and execution-quality analyst','Scalping','1m-5m',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('atlas','day-trading','Atlas','Multi-timeframe market-structure commander','Day trading','5m-1h',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('lyra','day-trading','Lyra','Session, opening-range and volatility specialist','Day trading','5m-1h',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('kestrel','day-trading','Kestrel','Momentum, VWAP and trend-continuation analyst','Day trading','5m-1h',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('morpheus','day-trading','Morpheus','Reversal, exhaustion and failed-breakout analyst','Day trading','5m-1h',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('echo','cross-market','Echo','Cross-exchange price discovery and arbitrage analyst','Multi-asset research','tick-1h',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('orion','cross-market','Orion','Macro, rates and intermarket correlation analyst','Multi-asset research','15m-1d',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('satoshi','cross-market','Satoshi','On-chain flows, wallets and DeFi liquidity analyst','Multi-asset research','block-1d',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('meridian','cross-market','Meridian','Equities, indices and commodity fundamentals analyst','Multi-asset research','5m-1d',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('aegis','capital-guard','Aegis','Portfolio risk, exposure and drawdown supervisor','Risk oversight','portfolio',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('sentinel','capital-guard','Sentinel','Data quality, event risk and anomaly monitor','Risk oversight','tick-1d',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now')),
('quanta','capital-guard','Quanta','Strategy validation, decay and retirement auditor','Risk oversight','strategy',1,'none',strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0019_multi_asset_intelligence_3');
