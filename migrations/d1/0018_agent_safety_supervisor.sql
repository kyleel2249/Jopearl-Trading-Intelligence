-- Persistent agent health, quarantine, fleet breaker and incident evidence.
CREATE TABLE IF NOT EXISTS jpti_agent_safety_state (
 agent_id TEXT PRIMARY KEY,
 status TEXT NOT NULL DEFAULT 'HEALTHY' CHECK(status IN ('HEALTHY','WATCH','BLOCKED','QUARANTINED','SUSPENDED')),
 health_score REAL NOT NULL DEFAULT 100 CHECK(health_score>=0 AND health_score<=100),
 trust_score REAL NOT NULL DEFAULT 0 CHECK(trust_score>=0 AND trust_score<=100),
 reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reasons_json)),
 quarantined_until TEXT,
 last_evaluated_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_agent_safety_status ON jpti_agent_safety_state(status,updated_at DESC);
CREATE TABLE IF NOT EXISTS jpti_agent_safety_incidents (
 incident_id TEXT PRIMARY KEY,
 agent_id TEXT,
 incident_type TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('low','medium','high','critical')),
 summary TEXT NOT NULL,
 evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','contained','resolved','false-positive')),
 detected_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS jpti_agent_safety_incidents_open ON jpti_agent_safety_incidents(status,severity,detected_at DESC);
CREATE TABLE IF NOT EXISTS jpti_fleet_circuit_breakers (
 scope_id TEXT PRIMARY KEY,
 status TEXT NOT NULL DEFAULT 'CLOSED' CHECK(status IN ('CLOSED','TRIPPED')),
 kill_switch INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch IN (0,1)),
 circuit_breaker INTEGER NOT NULL DEFAULT 0 CHECK(circuit_breaker IN (0,1)),
 manual_resume_required INTEGER NOT NULL DEFAULT 0 CHECK(manual_resume_required IN (0,1)),
 reasons_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(reasons_json)),
 tripped_at TEXT,
 resume_at TEXT,
 updated_by TEXT NOT NULL DEFAULT 'system',
 updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO jpti_fleet_circuit_breakers(scope_id,status,kill_switch,circuit_breaker,manual_resume_required,reasons_json,updated_by,updated_at)
VALUES('global','CLOSED',0,0,0,'[]','migration',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TRIGGER IF NOT EXISTS jpti_agent_safety_incidents_no_update BEFORE UPDATE ON jpti_agent_safety_incidents BEGIN SELECT RAISE(ABORT,'agent safety incidents are append-only'); END;
CREATE TRIGGER IF NOT EXISTS jpti_agent_safety_incidents_no_delete BEFORE DELETE ON jpti_agent_safety_incidents BEGIN SELECT RAISE(ABORT,'agent safety incidents are append-only'); END;
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0018_agent_safety_supervisor');
