/** Additive v3 automation tables. Apply in the same verified, backed-up migration as other v3 tables. */
export const AUTOMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS automation_rules (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_scripts (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, data TEXT NOT NULL, source_sha256 TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_revisions (id TEXT PRIMARY KEY, script_id TEXT NOT NULL, data TEXT NOT NULL, grant TEXT);
CREATE TABLE IF NOT EXISTS automation_grant_history (id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, grant_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('issued','revoked')), reason TEXT, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS automation_grant_history_revision ON automation_grant_history(revision_id,created_at);
CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, event_sequence INTEGER NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(rule_id, rule_version, event_sequence));
CREATE INDEX IF NOT EXISTS automation_runs_state ON automation_runs(state);
CREATE TABLE IF NOT EXISTS automation_drafts (id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(source, source_id));
CREATE TABLE IF NOT EXISTS automation_schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL, revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_schedule_occurrences (schedule_id TEXT NOT NULL, local_key TEXT NOT NULL, draft_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(schedule_id, local_key));
CREATE TABLE IF NOT EXISTS automation_event_cursor (id INTEGER PRIMARY KEY CHECK(id = 1), sequence INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS automation_activation (id TEXT PRIMARY KEY, enabled_at_sequence INTEGER NOT NULL);
`;
