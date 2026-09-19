/**
 * Numbered, additive schema. v1 is the 0.2.0 layout; v2 adds explicit orchestration
 * records with relational constraints and database-enforced immutability/fencing.
 * Nothing here rewrites v1 rows or opaque provider state.
 */
export const V1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL, ordinal INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, ordinal);
  CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL);
`;

/**
 * Phase 04 retained records. Purely additive tables that no earlier build reads, created with
 * IF NOT EXISTS on every open so a v1 and a v2 database gain them without a version change or
 * a rewrite of existing rows. Compactions and usage records are immutable and never deleted.
 */
export const PHASE4_SCHEMA = `
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
`;

const ABORT_IMMUTABLE = (table: string, columns: string[]): string => `
  CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table}
  WHEN ${columns.map(column => `NEW.${column} IS NOT OLD.${column}`).join(' OR ')}
  BEGIN SELECT RAISE(ABORT, '${table} identity is immutable'); END;`;

export const V2_MIGRATION = `
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 8),
    supersedes_id TEXT REFERENCES assignments(id),
    key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
    spec TEXT NOT NULL,
    allocation INTEGER NOT NULL CHECK (allocation > 0),
    created_by TEXT NOT NULL CHECK (created_by IN ('coordinator', 'user')),
    creator_call_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('proposed', 'admitted', 'result-submitted', 'integrated', 'incomplete', 'failed', 'cancelled', 'revoked', 'superseded')),
    wait_reason TEXT,
    child_task_id TEXT UNIQUE REFERENCES tasks(id),
    base_commit TEXT CHECK (base_commit IS NULL OR length(base_commit) = 40),
    base_tree TEXT CHECK (base_tree IS NULL OR length(base_tree) = 40),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (root_task_id, revision),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
  );
  CREATE INDEX assignments_root_state ON assignments(root_task_id, state);
  ${ABORT_IMMUTABLE('assignments', ['id', 'root_task_id', 'revision', 'supersedes_id', 'key', 'spec', 'allocation', 'created_by', 'creator_call_id', 'created_at'])}
  CREATE TRIGGER assignments_base_once BEFORE UPDATE OF child_task_id, base_commit, base_tree ON assignments
  WHEN (OLD.child_task_id IS NOT NULL AND NEW.child_task_id IS NOT OLD.child_task_id)
    OR (OLD.base_commit IS NOT NULL AND NEW.base_commit IS NOT OLD.base_commit)
    OR (OLD.base_tree IS NOT NULL AND NEW.base_tree IS NOT OLD.base_tree)
  BEGIN SELECT RAISE(ABORT, 'assignment child and base are recorded once'); END;
  CREATE TRIGGER assignments_terminal BEFORE UPDATE OF state ON assignments
  WHEN OLD.state IN ('integrated', 'incomplete', 'failed', 'cancelled', 'revoked', 'superseded') AND NEW.state IS NOT OLD.state
  BEGIN SELECT RAISE(ABORT, 'terminal assignment state cannot change'); END;
  CREATE TRIGGER assignments_supersedes_root BEFORE INSERT ON assignments
  WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM assignments WHERE id = NEW.supersedes_id AND root_task_id = NEW.root_task_id)
  BEGIN SELECT RAISE(ABORT, 'superseded assignment must belong to the same root'); END;

  CREATE TABLE assignment_dependencies (
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    predecessor_id TEXT NOT NULL REFERENCES assignments(id),
    successor_id TEXT NOT NULL REFERENCES assignments(id),
    PRIMARY KEY (predecessor_id, successor_id),
    CHECK (predecessor_id <> successor_id)
  );
  CREATE INDEX dependencies_successor ON assignment_dependencies(successor_id);
  CREATE TRIGGER dependencies_same_root BEFORE INSERT ON assignment_dependencies
  WHEN NOT EXISTS (SELECT 1 FROM assignments WHERE id = NEW.predecessor_id AND root_task_id = NEW.root_task_id)
    OR NOT EXISTS (SELECT 1 FROM assignments WHERE id = NEW.successor_id AND root_task_id = NEW.root_task_id)
  BEGIN SELECT RAISE(ABORT, 'dependency endpoints must belong to the same root'); END;
  CREATE TRIGGER dependencies_immutable BEFORE UPDATE ON assignment_dependencies
  BEGIN SELECT RAISE(ABORT, 'dependencies are immutable'); END;

  CREATE TABLE agent_runs (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    parent_task_id TEXT REFERENCES tasks(id),
    role TEXT NOT NULL CHECK (role IN ('coordinator', 'child')),
    assignment_id TEXT UNIQUE REFERENCES assignments(id),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('queued', 'preparing', 'running', 'waiting', 'terminal')),
    wait_reason TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'incomplete', 'failed', 'cancelled')),
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((role = 'coordinator' AND parent_task_id IS NULL AND root_task_id = task_id AND assignment_id IS NULL)
      OR (role = 'child' AND parent_task_id = root_task_id AND assignment_id IS NOT NULL AND task_id <> root_task_id)),
    CHECK ((lifecycle = 'terminal') = (outcome IS NOT NULL))
  );
  CREATE UNIQUE INDEX agent_runs_one_coordinator ON agent_runs(root_task_id) WHERE role = 'coordinator';
  CREATE INDEX agent_runs_root ON agent_runs(root_task_id, lifecycle);
  ${ABORT_IMMUTABLE('agent_runs', ['task_id', 'root_task_id', 'parent_task_id', 'role', 'assignment_id', 'created_at'])}
  CREATE TRIGGER agent_runs_child_depth BEFORE INSERT ON agent_runs WHEN NEW.role = 'child'
    AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE task_id = NEW.parent_task_id AND role = 'coordinator')
  BEGIN SELECT RAISE(ABORT, 'a child parent must be its root coordinator'); END;
  CREATE TRIGGER agent_runs_child_assignment BEFORE INSERT ON agent_runs WHEN NEW.role = 'child'
    AND NOT EXISTS (SELECT 1 FROM assignments WHERE id = NEW.assignment_id AND root_task_id = NEW.root_task_id)
  BEGIN SELECT RAISE(ABORT, 'a child assignment must belong to its root'); END;
  CREATE TRIGGER agent_runs_admission_bound BEFORE INSERT ON agent_runs WHEN NEW.role = 'child'
    AND (SELECT COUNT(*) FROM agent_runs WHERE root_task_id = NEW.root_task_id AND role = 'child' AND lifecycle <> 'terminal') >= 2
  BEGIN SELECT RAISE(ABORT, 'at most two admitted nonterminal children per root'); END;
  CREATE TRIGGER agent_runs_parent_fence BEFORE INSERT ON agent_runs WHEN NEW.role = 'child'
    AND EXISTS (SELECT 1 FROM agent_runs WHERE task_id = NEW.parent_task_id AND (cancel_requested = 1 OR lifecycle = 'terminal'))
  BEGIN SELECT RAISE(ABORT, 'a cancelled or terminal root cannot admit children'); END;
  CREATE TRIGGER agent_runs_no_resurrection BEFORE UPDATE OF lifecycle, outcome ON agent_runs
  WHEN OLD.lifecycle = 'terminal' AND (NEW.lifecycle IS NOT 'terminal' OR NEW.outcome IS NOT OLD.outcome)
  BEGIN SELECT RAISE(ABORT, 'a terminal run cannot be resurrected'); END;
  CREATE TRIGGER agent_runs_generation_monotonic BEFORE UPDATE OF generation, cancel_requested ON agent_runs
  WHEN NEW.generation < OLD.generation OR (OLD.cancel_requested = 1 AND NEW.cancel_requested = 0)
  BEGIN SELECT RAISE(ABORT, 'run fencing cannot be reversed'); END;

  CREATE TABLE budget_accounts (
    root_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    cap INTEGER NOT NULL CHECK (cap > 0),
    protected_coordinator INTEGER NOT NULL CHECK (protected_coordinator >= 0 AND protected_coordinator <= cap),
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE budget_holds (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES budget_accounts(root_task_id),
    assignment_id TEXT NOT NULL UNIQUE REFERENCES assignments(id),
    child_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL CHECK (state IN ('held', 'released')),
    released_unused INTEGER CHECK (released_unused IS NULL OR released_unused >= 0),
    created_at TEXT NOT NULL,
    released_at TEXT,
    CHECK ((state = 'released') = (released_at IS NOT NULL))
  );
  ${ABORT_IMMUTABLE('budget_holds', ['id', 'root_task_id', 'assignment_id', 'child_task_id', 'amount', 'created_at'])}
  CREATE TRIGGER budget_holds_release_once BEFORE UPDATE OF state ON budget_holds WHEN OLD.state = 'released'
  BEGIN SELECT RAISE(ABORT, 'a released hold cannot be re-held'); END;
  CREATE TABLE budget_reservations (
    request_id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES budget_accounts(root_task_id),
    run_task_id TEXT NOT NULL REFERENCES tasks(id),
    generation INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'retained')),
    charged INTEGER CHECK (charged IS NULL OR charged >= 0),
    usage_known INTEGER NOT NULL DEFAULT 0 CHECK (usage_known IN (0, 1)),
    reason TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT,
    CHECK ((state = 'reserved') = (charged IS NULL))
  );
  CREATE INDEX budget_reservations_root ON budget_reservations(root_task_id, state);
  ${ABORT_IMMUTABLE('budget_reservations', ['request_id', 'root_task_id', 'run_task_id', 'generation', 'amount', 'created_at'])}
  CREATE TRIGGER budget_reservations_settle_once BEFORE UPDATE OF state, charged ON budget_reservations WHEN OLD.state <> 'reserved'
  BEGIN SELECT RAISE(ABORT, 'a settled reservation cannot change'); END;

  CREATE TABLE child_results (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    assignment_id TEXT NOT NULL REFERENCES assignments(id),
    child_task_id TEXT NOT NULL REFERENCES tasks(id),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    base_commit TEXT NOT NULL CHECK (length(base_commit) = 40),
    commit_sha TEXT NOT NULL CHECK (length(commit_sha) = 40),
    tree_sha TEXT NOT NULL CHECK (length(tree_sha) = 40),
    changed_paths TEXT NOT NULL,
    manifest TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
    evidence_ids TEXT NOT NULL,
    summary TEXT NOT NULL,
    unresolved TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (assignment_id, revision)
  );
  CREATE TRIGGER child_results_immutable BEFORE UPDATE ON child_results BEGIN SELECT RAISE(ABORT, 'child results are immutable'); END;
  CREATE TRIGGER child_results_no_delete BEFORE DELETE ON child_results BEGIN SELECT RAISE(ABORT, 'child results are retained'); END;

  CREATE TABLE wait_operations (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    coordinator_task_id TEXT NOT NULL REFERENCES tasks(id),
    generation INTEGER NOT NULL,
    pending_call_id TEXT NOT NULL,
    assignment_ids TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'delivered', 'cancelled')),
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (coordinator_task_id, pending_call_id)
  );
  ${ABORT_IMMUTABLE('wait_operations', ['id', 'root_task_id', 'coordinator_task_id', 'generation', 'pending_call_id', 'assignment_ids', 'created_at'])}
  CREATE TRIGGER wait_operations_deliver_once BEFORE UPDATE OF state, result ON wait_operations WHEN OLD.state <> 'waiting'
  BEGIN SELECT RAISE(ABORT, 'a wait is delivered at most once'); END;

  CREATE TABLE handoff_operations (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    child_task_id TEXT NOT NULL REFERENCES tasks(id),
    assignment_id TEXT NOT NULL REFERENCES assignments(id),
    generation INTEGER NOT NULL,
    approval_id TEXT NOT NULL UNIQUE,
    branch TEXT NOT NULL,
    expected_head TEXT NOT NULL CHECK (length(expected_head) = 40),
    prepared TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('awaiting-approval', 'executing', 'staged', 'committed', 'complete', 'rejected', 'revoked', 'failed', 'unknown')),
    staged_tree TEXT,
    commit_sha TEXT,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX handoff_one_complete ON handoff_operations(assignment_id) WHERE state = 'complete';
  ${ABORT_IMMUTABLE('handoff_operations', ['id', 'root_task_id', 'child_task_id', 'assignment_id', 'generation', 'approval_id', 'branch', 'expected_head', 'prepared', 'fingerprint', 'created_at'])}

  CREATE TABLE integration_operations (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    coordinator_task_id TEXT NOT NULL REFERENCES tasks(id),
    generation INTEGER NOT NULL,
    pending_call_id TEXT,
    result_id TEXT NOT NULL REFERENCES child_results(id),
    kind TEXT NOT NULL CHECK (kind IN ('cherry-pick', 'continue')),
    parent_operation_id TEXT REFERENCES integration_operations(id),
    approval_id TEXT UNIQUE,
    branch TEXT NOT NULL,
    expected_head TEXT NOT NULL CHECK (length(expected_head) = 40),
    expected_tree TEXT NOT NULL CHECK (length(expected_tree) = 40),
    source_sha TEXT NOT NULL CHECK (length(source_sha) = 40),
    manifest TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
    resolved_tree TEXT,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('awaiting-approval', 'executing', 'succeeded', 'conflict', 'continued', 'empty', 'mismatch', 'unknown', 'rejected', 'revoked', 'failed')),
    observed TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((kind = 'continue') = (parent_operation_id IS NOT NULL AND resolved_tree IS NOT NULL))
  );
  CREATE UNIQUE INDEX integration_one_active ON integration_operations(root_task_id)
    WHERE state IN ('awaiting-approval', 'executing', 'conflict', 'empty', 'mismatch', 'unknown');
  CREATE UNIQUE INDEX integration_result_once ON integration_operations(result_id) WHERE state = 'succeeded';
  ${ABORT_IMMUTABLE('integration_operations', ['id', 'idempotency_key', 'root_task_id', 'coordinator_task_id', 'generation', 'result_id', 'kind', 'parent_operation_id', 'branch', 'expected_head', 'expected_tree', 'source_sha', 'manifest', 'manifest_sha256', 'resolved_tree', 'fingerprint', 'created_at'])}
  CREATE TRIGGER integration_terminal BEFORE UPDATE OF state ON integration_operations
  WHEN OLD.state IN ('succeeded', 'rejected', 'revoked', 'failed') AND NEW.state IS NOT OLD.state
  BEGIN SELECT RAISE(ABORT, 'terminal integration state cannot change'); END;

  CREATE TABLE validation_evidence (
    id TEXT PRIMARY KEY,
    root_task_id TEXT NOT NULL REFERENCES tasks(id),
    run_task_id TEXT NOT NULL REFERENCES tasks(id),
    approval_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('child', 'combined')),
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    head TEXT NOT NULL,
    tree TEXT NOT NULL,
    branch TEXT,
    clean INTEGER NOT NULL CHECK (clean IN (0, 1)),
    state_fingerprint TEXT NOT NULL,
    exit_code INTEGER,
    cleanup_verified INTEGER NOT NULL CHECK (cleanup_verified IN (0, 1)),
    passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
    created_at TEXT NOT NULL,
    CHECK (passed = 0 OR (exit_code = 0 AND cleanup_verified = 1 AND clean = 1))
  );
  CREATE INDEX validation_root ON validation_evidence(root_task_id, kind, created_at);
  CREATE TRIGGER validation_immutable BEFORE UPDATE ON validation_evidence BEGIN SELECT RAISE(ABORT, 'validation evidence is immutable'); END;

  CREATE TABLE profile_cooldowns (
    profile_id TEXT PRIMARY KEY,
    until TEXT NOT NULL,
    reason TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TRIGGER assignments_no_delete BEFORE DELETE ON assignments BEGIN SELECT RAISE(ABORT, 'assignments are retained'); END;
  CREATE TRIGGER agent_runs_no_delete BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT, 'agent runs are retained'); END;
  CREATE TRIGGER budget_holds_no_delete BEFORE DELETE ON budget_holds BEGIN SELECT RAISE(ABORT, 'budget holds are retained'); END;
  CREATE TRIGGER budget_reservations_no_delete BEFORE DELETE ON budget_reservations BEGIN SELECT RAISE(ABORT, 'budget reservations are retained'); END;
  CREATE TRIGGER wait_operations_no_delete BEFORE DELETE ON wait_operations BEGIN SELECT RAISE(ABORT, 'waits are retained'); END;
  CREATE TRIGGER handoff_operations_no_delete BEFORE DELETE ON handoff_operations BEGIN SELECT RAISE(ABORT, 'handoff operations are retained'); END;
  CREATE TRIGGER integration_operations_no_delete BEFORE DELETE ON integration_operations BEGIN SELECT RAISE(ABORT, 'integration operations are retained'); END;
  CREATE TRIGGER validation_no_delete BEFORE DELETE ON validation_evidence BEGIN SELECT RAISE(ABORT, 'validation evidence is retained'); END;

  CREATE TABLE task_completions (
    root_task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    head TEXT NOT NULL,
    tree TEXT NOT NULL,
    evidence_id TEXT NOT NULL REFERENCES validation_evidence(id),
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER task_completions_immutable BEFORE UPDATE ON task_completions BEGIN SELECT RAISE(ABORT, 'completion records are immutable'); END;
  CREATE TRIGGER task_completions_no_delete BEFORE DELETE ON task_completions BEGIN SELECT RAISE(ABORT, 'completion records are retained'); END;
`;
