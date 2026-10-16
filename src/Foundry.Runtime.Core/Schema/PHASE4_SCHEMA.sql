
  CREATE TABLE IF NOT EXISTS compactions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_ordinal INTEGER NOT NULL,
    to_ordinal INTEGER NOT NULL CHECK (to_ordinal >= from_ordinal),
    message_ids TEXT NOT NULL,
    summary TEXT NOT NULL,
    estimated_before INTEGER NOT NULL CHECK (estimated_before >= 0),
    estimated_after INTEGER NOT NULL CHECK (estimated_after >= 0),
    provider_state_before TEXT,
    provider_state_after TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS compactions_task ON compactions(task_id, from_ordinal);
  CREATE TRIGGER IF NOT EXISTS compactions_immutable BEFORE UPDATE ON compactions BEGIN SELECT RAISE(ABORT, 'compactions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS compactions_no_delete BEFORE DELETE ON compactions BEGIN SELECT RAISE(ABORT, 'compactions are retained'); END;
  CREATE TABLE IF NOT EXISTS usage_records (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    request_id TEXT NOT NULL UNIQUE,
    reserved INTEGER NOT NULL CHECK (reserved >= 0),
    prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
    completion_tokens INTEGER CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
    cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_creation_tokens INTEGER CHECK (cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
    usage_known INTEGER NOT NULL CHECK (usage_known IN (0, 1)),
    reason TEXT,
    created_at TEXT NOT NULL,
    CHECK (usage_known = 0 OR (prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS usage_records_task ON usage_records(task_id, created_at);
  CREATE TRIGGER IF NOT EXISTS usage_records_immutable BEFORE UPDATE ON usage_records BEGIN SELECT RAISE(ABORT, 'usage records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS usage_records_no_delete BEFORE DELETE ON usage_records BEGIN SELECT RAISE(ABORT, 'usage records are retained'); END;
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    tools_listed_at TEXT,
    server_info TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
