export const CONTINUITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS decision_cards (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS decisions_task ON decision_cards(task_id, created_at);
  CREATE TABLE IF NOT EXISTS task_lineage (task_id TEXT PRIMARY KEY REFERENCES tasks(id), source_task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
`;
