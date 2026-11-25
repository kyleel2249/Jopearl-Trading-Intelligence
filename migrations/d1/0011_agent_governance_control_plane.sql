-- JPTI governance control plane: least-privilege capabilities, approval workflow, immutable decisions and agent liveness.
CREATE TABLE IF NOT EXISTS jpti_agent_capabilities (
  capability_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES jpti_org_agents(agent_id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  approval_required INTEGER NOT NULL DEFAULT 1 CHECK(approval_required IN (0,1)),
  constraints_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(constraints_json)),
  granted_by TEXT,
  granted_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, capability)
);
CREATE INDEX IF NOT EXISTS jpti_agent_capabilities_agent ON jpti_agent_capabilities(agent_id,enabled);
CREATE TABLE IF NOT EXISTS jpti_governance_requests (
  request_id TEXT PRIMARY KEY,
  request_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  requested_by TEXT NOT NULL,
  reviewed_by TEXT,
  review_note TEXT,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_governance_requests_queue ON jpti_governance_requests(status,requested_at DESC);
CREATE INDEX IF NOT EXISTS jpti_governance_requests_target ON jpti_governance_requests(target_type,target_id,requested_at DESC);
CREATE TABLE IF NOT EXISTS jpti_decision_ledger (
  decision_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
  policy_version TEXT NOT NULL DEFAULT '1',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_decision_ledger_target ON jpti_decision_ledger(target_type,target_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_decision_ledger_time ON jpti_decision_ledger(created_at DESC);
CREATE TRIGGER IF NOT EXISTS jpti_decision_ledger_no_update BEFORE UPDATE ON jpti_decision_ledger BEGIN SELECT RAISE(ABORT,'decision ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_decision_ledger_no_delete BEFORE DELETE ON jpti_decision_ledger BEGIN SELECT RAISE(ABORT,'decision ledger is append-only'); END;
CREATE TABLE IF NOT EXISTS jpti_agent_heartbeats (
  agent_id TEXT PRIMARY KEY REFERENCES jpti_org_agents(agent_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK(status IN ('healthy','degraded','busy','offline','blocked')),
  last_seen TEXT NOT NULL,
  latency_ms INTEGER,
  error_count INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json))
);
CREATE INDEX IF NOT EXISTS jpti_agent_heartbeats_status ON jpti_agent_heartbeats(status,last_seen DESC);
CREATE TABLE IF NOT EXISTS jpti_intelligence_sources (
  source_id TEXT PRIMARY KEY,
  memory_id TEXT REFERENCES jpti_intelligence_memory(memory_id) ON DELETE SET NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  checksum TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status IN ('verified','partially-verified','unverified','disputed','inferred')),
  observed_at TEXT,
  retrieved_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json))
);
CREATE INDEX IF NOT EXISTS jpti_intelligence_sources_memory ON jpti_intelligence_sources(memory_id,retrieved_at DESC);
CREATE INDEX IF NOT EXISTS jpti_intelligence_sources_checksum ON jpti_intelligence_sources(checksum);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0011_agent_governance_control_plane');
