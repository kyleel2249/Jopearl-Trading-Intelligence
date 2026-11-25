-- Keep fleet-wide position and concentration checks efficient as the ledger grows.
CREATE INDEX IF NOT EXISTS jpti_paper_trades_open_exposure
ON jpti_paper_trades(status, symbol, direction)
WHERE status = 'open';

INSERT OR IGNORE INTO jpti_schema_migrations(version)
VALUES ('0008_paper_fleet_exposure_index');
