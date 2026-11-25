-- JPTI autonomous departments: shared institutional memory, agent registry, missions, exchange and daily scorecards.
CREATE TABLE IF NOT EXISTS jpti_org_departments (
  department_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mission TEXT NOT NULL,
  goals_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(goals_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS jpti_org_agents (
  agent_id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS jpti_org_agents_department ON jpti_org_agents(department_id, status);
CREATE TABLE IF NOT EXISTS jpti_org_missions (
  mission_id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  assigned_agents_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(assigned_agents_json)),
  status TEXT NOT NULL DEFAULT 'queued',
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS jpti_org_missions_department_time ON jpti_org_missions(department_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_org_missions_status ON jpti_org_missions(status, priority, created_at);
CREATE TABLE IF NOT EXISTS jpti_org_memory (
  memory_id TEXT PRIMARY KEY,
  department_id TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_org_memory_time ON jpti_org_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS jpti_org_memory_department ON jpti_org_memory(department_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jpti_org_messages (
  message_id TEXT PRIMARY KEY,
  from_department TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  to_department TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'unread',
  mission_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jpti_org_messages_inbox ON jpti_org_messages(to_department, status, created_at DESC);
CREATE TABLE IF NOT EXISTS jpti_org_reviews (
  review_date TEXT NOT NULL,
  department_id TEXT NOT NULL REFERENCES jpti_org_departments(department_id),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  summary TEXT NOT NULL,
  metrics_json TEXT NOT NULL CHECK (json_valid(metrics_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (review_date, department_id)
);
CREATE TABLE IF NOT EXISTS jpti_org_pulse_runs (
  pulse_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0009_autonomous_departments');
