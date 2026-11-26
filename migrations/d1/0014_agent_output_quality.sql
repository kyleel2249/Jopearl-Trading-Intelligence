CREATE TABLE IF NOT EXISTS jpti_agent_output_quality(
  id TEXT PRIMARY KEY,
  agent_key TEXT NOT NULL,
  source TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL CHECK(outcome IN ('clean','repaired','fallback')),
  reasons TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_agent_output_quality_agent ON jpti_agent_output_quality(agent_key, created_at DESC);
