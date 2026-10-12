
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path_key TEXT NOT NULL UNIQUE,
    data TEXT NOT NULL
  );
  CREATE TABLE workspace_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL
  );
  CREATE TABLE task_starts (
    request_id TEXT PRIMARY KEY,
    input_hash TEXT NOT NULL,
    task_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'failed', 'complete')),
    created_at TEXT NOT NULL
  );
