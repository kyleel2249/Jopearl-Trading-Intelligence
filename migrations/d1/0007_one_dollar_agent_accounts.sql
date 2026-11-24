-- One-dollar virtual starting accounts for every research agent.
-- Existing simulated trade history is retained; only the starting account allocation changes.
UPDATE jpti_paper_agents SET virtual_equity_usd = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
-- Record that the paper fleet has no authority to submit live exchange orders.
UPDATE jpti_paper_agents
SET payload = json_set(payload, '$.permissions', json('{"paper":true,"live":false}'))
WHERE json_valid(payload);
CREATE INDEX IF NOT EXISTS jpti_paper_agents_status_tier
ON jpti_paper_agents(status, tier, updated_at DESC);
INSERT OR IGNORE INTO jpti_schema_migrations(version) VALUES ('0007_one_dollar_agent_accounts');
