
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
  
  CREATE TRIGGER assignments_immutable BEFORE UPDATE ON assignments
  WHEN NEW.id IS NOT OLD.id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.revision IS NOT OLD.revision OR NEW.supersedes_id IS NOT OLD.supersedes_id OR NEW.key IS NOT OLD.key OR NEW.spec IS NOT OLD.spec OR NEW.allocation IS NOT OLD.allocation OR NEW.created_by IS NOT OLD.created_by OR NEW.creator_call_id IS NOT OLD.creator_call_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'assignments identity is immutable'); END;
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
  
  CREATE TRIGGER agent_runs_immutable BEFORE UPDATE ON agent_runs
  WHEN NEW.task_id IS NOT OLD.task_id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.parent_task_id IS NOT OLD.parent_task_id OR NEW.role IS NOT OLD.role OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'agent_runs identity is immutable'); END;
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
  
  CREATE TRIGGER budget_holds_immutable BEFORE UPDATE ON budget_holds
  WHEN NEW.id IS NOT OLD.id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.child_task_id IS NOT OLD.child_task_id OR NEW.amount IS NOT OLD.amount OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'budget_holds identity is immutable'); END;
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
  
  CREATE TRIGGER budget_reservations_immutable BEFORE UPDATE ON budget_reservations
  WHEN NEW.request_id IS NOT OLD.request_id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.run_task_id IS NOT OLD.run_task_id OR NEW.generation IS NOT OLD.generation OR NEW.amount IS NOT OLD.amount OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'budget_reservations identity is immutable'); END;
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
  
  CREATE TRIGGER wait_operations_immutable BEFORE UPDATE ON wait_operations
  WHEN NEW.id IS NOT OLD.id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.coordinator_task_id IS NOT OLD.coordinator_task_id OR NEW.generation IS NOT OLD.generation OR NEW.pending_call_id IS NOT OLD.pending_call_id OR NEW.assignment_ids IS NOT OLD.assignment_ids OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'wait_operations identity is immutable'); END;
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
  
  CREATE TRIGGER handoff_operations_immutable BEFORE UPDATE ON handoff_operations
  WHEN NEW.id IS NOT OLD.id OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.child_task_id IS NOT OLD.child_task_id OR NEW.assignment_id IS NOT OLD.assignment_id OR NEW.generation IS NOT OLD.generation OR NEW.approval_id IS NOT OLD.approval_id OR NEW.branch IS NOT OLD.branch OR NEW.expected_head IS NOT OLD.expected_head OR NEW.prepared IS NOT OLD.prepared OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'handoff_operations identity is immutable'); END;

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
  
  CREATE TRIGGER integration_operations_immutable BEFORE UPDATE ON integration_operations
  WHEN NEW.id IS NOT OLD.id OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.root_task_id IS NOT OLD.root_task_id OR NEW.coordinator_task_id IS NOT OLD.coordinator_task_id OR NEW.generation IS NOT OLD.generation OR NEW.result_id IS NOT OLD.result_id OR NEW.kind IS NOT OLD.kind OR NEW.parent_operation_id IS NOT OLD.parent_operation_id OR NEW.branch IS NOT OLD.branch OR NEW.expected_head IS NOT OLD.expected_head OR NEW.expected_tree IS NOT OLD.expected_tree OR NEW.source_sha IS NOT OLD.source_sha OR NEW.manifest IS NOT OLD.manifest OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256 OR NEW.resolved_tree IS NOT OLD.resolved_tree OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_at IS NOT OLD.created_at
  BEGIN SELECT RAISE(ABORT, 'integration_operations identity is immutable'); END;
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
