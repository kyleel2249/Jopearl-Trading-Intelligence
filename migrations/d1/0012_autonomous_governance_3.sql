-- JPTI Autonomous Governance 3.0: policy registry, behavioural telemetry, trust history, incident response and sandbox simulations.
CREATE TABLE IF NOT EXISTS jpti_governance_policies (
 policy_id TEXT PRIMARY KEY, policy_name TEXT NOT NULL, policy_version INTEGER NOT NULL DEFAULT 1,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), severity TEXT NOT NULL DEFAULT 'high',
 rules_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(rules_json)),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(policy_name,policy_version)
);
CREATE INDEX IF NOT EXISTS jpti_governance_policies_active ON jpti_governance_policies(enabled,policy_name,policy_version DESC);
CREATE TABLE IF NOT EXISTS jpti_governance_incidents (
 incident_id TEXT PRIMARY KEY, incident_type TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','investigating','contained','resolved','false-positive')),
 agent_id TEXT, department_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL,
 response_action TEXT NOT NULL DEFAULT 'review', evidence_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(evidence_json)),
 assigned_to TEXT, resolution TEXT, detected_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS jpti_governance_incidents_queue ON jpti_governance_incidents(status,severity,detected_at DESC);
CREATE INDEX IF NOT EXISTS jpti_governance_incidents_agent ON jpti_governance_incidents(agent_id,detected_at DESC);
CREATE TABLE IF NOT EXISTS jpti_agent_behavior_events (
 event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, department_id TEXT, event_type TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('info','low','medium','high','critical')),
 risk_score REAL NOT NULL CHECK(risk_score>=0 AND risk_score<=100),
 summary TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(details_json)),
 source TEXT NOT NULL DEFAULT 'agent-telemetry', observed_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_agent_behavior_agent ON jpti_agent_behavior_events(agent_id,observed_at DESC);
CREATE INDEX IF NOT EXISTS jpti_agent_behavior_risk ON jpti_agent_behavior_events(severity,risk_score DESC,observed_at DESC);
CREATE TABLE IF NOT EXISTS jpti_agent_trust_snapshots (
 snapshot_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, trust_score REAL NOT NULL CHECK(trust_score>=0 AND trust_score<=100),
 risk_score REAL NOT NULL CHECK(risk_score>=0 AND risk_score<=100), components_json TEXT NOT NULL CHECK(json_valid(components_json)),
 authority_band TEXT NOT NULL, calculated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_agent_trust_latest ON jpti_agent_trust_snapshots(agent_id,calculated_at DESC);
CREATE TABLE IF NOT EXISTS jpti_governance_simulations (
 simulation_id TEXT PRIMARY KEY, scenario_type TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
 result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_governance_simulations_time ON jpti_governance_simulations(created_at DESC);
CREATE TRIGGER IF NOT EXISTS jpti_agent_behavior_no_update BEFORE UPDATE ON jpti_agent_behavior_events BEGIN SELECT RAISE(ABORT,'behaviour evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_agent_behavior_no_delete BEFORE DELETE ON jpti_agent_behavior_events BEGIN SELECT RAISE(ABORT,'behaviour evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_governance_simulations_no_update BEFORE UPDATE ON jpti_governance_simulations BEGIN SELECT RAISE(ABORT,'simulation records are append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_governance_simulations_no_delete BEFORE DELETE ON jpti_governance_simulations BEGIN SELECT RAISE(ABORT,'simulation records are append-only'); END;
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0012_autonomous_governance_3');
