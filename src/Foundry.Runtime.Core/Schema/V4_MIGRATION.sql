
  CREATE TABLE provider_requests (
    request_id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id), root_task_id TEXT, parent_task_id TEXT,
    task_title TEXT, root_task_title TEXT, role TEXT, purpose TEXT NOT NULL CHECK(purpose IN ('conversation','probe','legacy')),
    profile_id TEXT, profile_name TEXT, api_kind TEXT, deployment TEXT, effort TEXT,
    attribution_known INTEGER NOT NULL CHECK(attribution_known IN (0,1)),
    reported_model TEXT, response_id TEXT,
    created_at TEXT NOT NULL, attempted_at TEXT, finished_at TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('pending','completed','failed','cancelled','interrupted','unknown')),
    reserved INTEGER NOT NULL CHECK(reserved >= 0),
    input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens >= 0),
    cache_read_tokens INTEGER CHECK(cache_read_tokens IS NULL OR cache_read_tokens >= 0),
    cache_creation_tokens INTEGER CHECK(cache_creation_tokens IS NULL OR cache_creation_tokens >= 0),
    reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens >= 0),
    usage_known INTEGER NOT NULL CHECK(usage_known IN (0,1)), reason TEXT,
    CHECK(usage_known = 0 OR (input_tokens IS NOT NULL AND output_tokens IS NOT NULL)),
    CHECK(finished_at IS NULL OR outcome != 'pending')
  );
  CREATE INDEX provider_requests_time ON provider_requests(created_at DESC, request_id DESC);
  CREATE INDEX provider_requests_task ON provider_requests(task_id, created_at DESC);
  CREATE INDEX provider_requests_root ON provider_requests(root_task_id, created_at DESC);
  CREATE TRIGGER provider_requests_identity BEFORE UPDATE ON provider_requests
  WHEN NEW.request_id IS NOT OLD.request_id OR NEW.task_id IS NOT OLD.task_id
    OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.parent_task_id IS NOT OLD.parent_task_id
    OR NEW.task_title IS NOT OLD.task_title OR NEW.root_task_title IS NOT OLD.root_task_title OR NEW.role IS NOT OLD.role OR NEW.purpose IS NOT OLD.purpose
    OR NEW.profile_id IS NOT OLD.profile_id OR NEW.profile_name IS NOT OLD.profile_name
    OR NEW.api_kind IS NOT OLD.api_kind OR NEW.deployment IS NOT OLD.deployment
    OR NEW.effort IS NOT OLD.effort OR NEW.attribution_known IS NOT OLD.attribution_known
    OR NEW.created_at IS NOT OLD.created_at OR NEW.reserved IS NOT OLD.reserved
  BEGIN SELECT RAISE(ABORT, 'request identity is immutable'); END;
  CREATE TRIGGER provider_requests_terminal BEFORE UPDATE ON provider_requests
  WHEN OLD.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'terminal usage is immutable'); END;
  CREATE TRIGGER provider_requests_no_delete BEFORE DELETE ON provider_requests
  BEGIN SELECT RAISE(ABORT, 'provider requests are retained'); END;
