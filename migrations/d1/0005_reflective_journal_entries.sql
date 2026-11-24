-- Private, owner-scoped reflective journal records stored durably in Cloudflare D1.
CREATE TABLE IF NOT EXISTS jpti_journal_entries (
  owner_key TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (owner_key, entry_id)
);
CREATE INDEX IF NOT EXISTS jpti_journal_entries_updated
  ON jpti_journal_entries (owner_key, updated_at DESC);
INSERT OR IGNORE INTO jpti_schema_migrations(version)
VALUES ('0005_reflective_journal_entries');
