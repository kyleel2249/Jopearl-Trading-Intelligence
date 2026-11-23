-- Speed up exact route lookups for the latest durable market snapshot.
CREATE INDEX IF NOT EXISTS jpti_events_market_snapshot_lookup
  ON jpti_events (kind, external_id, occurred_at DESC)
  WHERE kind = 'market-snapshot';
