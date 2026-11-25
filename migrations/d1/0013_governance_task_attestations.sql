-- JPTI Governance 4.0: signed, append-only execution authorization receipts.
CREATE TABLE IF NOT EXISTS jpti_agent_task_attestations (
 attestation_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 agent_id TEXT,
 department_id TEXT,
 capability TEXT NOT NULL,
 policy_id TEXT,
 policy_version INTEGER,
 decision TEXT NOT NULL CHECK(decision IN ('authorized','denied')),
 reason TEXT NOT NULL,
 task_fingerprint TEXT NOT NULL,
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 signature TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_task_attestations_task ON jpti_agent_task_attestations(task_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_task_attestations_agent ON jpti_agent_task_attestations(agent_id,created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_task_attestations_decision ON jpti_agent_task_attestations(decision,created_at DESC);
CREATE TRIGGER IF NOT EXISTS jpti_task_attestations_no_update BEFORE UPDATE ON jpti_agent_task_attestations BEGIN SELECT RAISE(ABORT,'task authorization attestations are append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_task_attestations_no_delete BEFORE DELETE ON jpti_agent_task_attestations BEGIN SELECT RAISE(ABORT,'task authorization attestations are append-only'); END;
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0013_governance_task_attestations');
