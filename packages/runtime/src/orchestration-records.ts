import { randomUUID } from 'node:crypto';
import type { AgentRun, Assignment, AssignmentSpec, AssignmentState, ChildResult, HandoffState, IntegrationOperation, IntegrationState, RunLifecycle, RunOutcome, ValidationEvidence, WaitReason } from '../../protocol/src/index';
import { ORCHESTRATION_LIMITS } from '../../protocol/src/index';
import type { Store } from './store';
import type { EffectManifest } from './git-operations';

interface RunRow { task_id: string; root_task_id: string; parent_task_id: string | null; role: 'coordinator' | 'child'; assignment_id: string | null; lifecycle: RunLifecycle; wait_reason: WaitReason | null; outcome: RunOutcome | null; generation: number; cancel_requested: number; created_at: string; updated_at: string }
interface AssignmentRow { id: string; root_task_id: string; revision: number; supersedes_id: string | null; key: string; spec: string; allocation: number; created_by: 'coordinator' | 'user'; state: AssignmentState; wait_reason: WaitReason | null; child_task_id: string | null; base_commit: string | null; base_tree: string | null; created_at: string; updated_at: string }
interface ResultRow { id: string; root_task_id: string; assignment_id: string; child_task_id: string; revision: number; base_commit: string; commit_sha: string; tree_sha: string; changed_paths: string; manifest: string; manifest_sha256: string; evidence_ids: string; summary: string; unresolved: string; created_at: string }
interface IntegrationRow { id: string; root_task_id: string; coordinator_task_id: string; generation: number; pending_call_id: string | null; result_id: string; kind: 'cherry-pick' | 'continue'; parent_operation_id: string | null; approval_id: string | null; branch: string; expected_head: string; expected_tree: string; source_sha: string; manifest: string; manifest_sha256: string; resolved_tree: string | null; fingerprint: string; state: IntegrationState; observed: string | null; created_at: string; updated_at: string }
interface EvidenceRow { id: string; root_task_id: string; run_task_id: string; approval_id: string; kind: 'child' | 'combined'; command: string; cwd: string; head: string; tree: string; branch: string | null; clean: number; state_fingerprint: string; exit_code: number | null; cleanup_verified: number; passed: number; created_at: string }

export interface HandoffRecord { id: string; rootTaskId: string; childTaskId: string; assignmentId: string; generation: number; approvalId: string; branch: string; expectedHead: string; prepared: unknown; fingerprint: string; state: HandoffState; stagedTree: string | null; commit: string | null; detail: string | null }
export interface WaitRecord { id: string; rootTaskId: string; coordinatorTaskId: string; generation: number; pendingCallId: string; assignmentIds: string[]; state: 'waiting' | 'delivered' | 'cancelled'; result: string | null }
export interface IntegrationRecord extends IntegrationOperation { coordinatorTaskId: string; generation: number; pendingCallId: string | null; branch: string; manifest: EffectManifest; fingerprint: string }

const now = (): string => new Date().toISOString();

/** Typed access to the v2 orchestration tables. `Store` remains the only database connection and writer. */
export class OrchestrationRecords {
  constructor(private readonly store: Store) {}
  private get db() { return this.store.db; }

  insertCoordinatorRun(rootTaskId: string): void {
    const at = now();
    this.db.prepare("INSERT INTO agent_runs(task_id, root_task_id, parent_task_id, role, assignment_id, lifecycle, wait_reason, created_at, updated_at) VALUES (?, ?, NULL, 'coordinator', NULL, 'waiting', 'user-continuation', ?, ?)").run(rootTaskId, rootTaskId, at, at);
  }
  insertChildRun(rootTaskId: string, childTaskId: string, assignmentId: string): void {
    const at = now();
    this.db.prepare("INSERT INTO agent_runs(task_id, root_task_id, parent_task_id, role, assignment_id, lifecycle, wait_reason, created_at, updated_at) VALUES (?, ?, ?, 'child', ?, 'preparing', NULL, ?, ?)").run(childTaskId, rootTaskId, rootTaskId, assignmentId, at, at);
  }
  run(taskId: string): AgentRun | undefined {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE task_id = ?').get(taskId) as RunRow | undefined;
    return row ? this.mapRun(row) : undefined;
  }
  requireRun(taskId: string, rootTaskId: string): AgentRun {
    const run = this.run(taskId);
    if (!run || run.rootTaskId !== rootTaskId) throw new Error('This agent does not belong to the selected coordinated task.');
    return run;
  }
  runs(rootTaskId: string): AgentRun[] {
    return (this.db.prepare("SELECT * FROM agent_runs WHERE root_task_id = ? ORDER BY CASE role WHEN 'coordinator' THEN 0 ELSE 1 END, created_at, task_id").all(rootTaskId) as RunRow[]).map(row => this.mapRun(row));
  }
  activeChildren(rootTaskId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE root_task_id = ? AND role = 'child' AND lifecycle <> 'terminal'").get(rootTaskId) as { count: number }).count;
  }
  setLifecycle(taskId: string, lifecycle: Exclude<RunLifecycle, 'terminal'>, waitReason: WaitReason | null = null): void {
    this.db.prepare('UPDATE agent_runs SET lifecycle = ?, wait_reason = ?, updated_at = ? WHERE task_id = ? AND lifecycle <> \'terminal\'').run(lifecycle, waitReason, now(), taskId);
  }
  finishRun(taskId: string, outcome: RunOutcome): boolean {
    return this.db.prepare("UPDATE agent_runs SET lifecycle = 'terminal', outcome = ?, wait_reason = NULL, updated_at = ? WHERE task_id = ? AND lifecycle <> 'terminal'").run(outcome, now(), taskId).changes === 1;
  }
  /** Fence a run: bump generation and mark cancellation. Late work bound to the old generation fails closed. */
  fence(taskId: string): number {
    this.db.prepare('UPDATE agent_runs SET generation = generation + 1, cancel_requested = 1, updated_at = ? WHERE task_id = ?').run(now(), taskId);
    return this.run(taskId)!.generation;
  }
  /** A new explicit user continuation on the coordinator starts a new generation. */
  advanceGeneration(taskId: string): number {
    this.db.prepare('UPDATE agent_runs SET generation = generation + 1, updated_at = ? WHERE task_id = ? AND cancel_requested = 0').run(now(), taskId);
    return this.run(taskId)!.generation;
  }

  revisionCount(rootTaskId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS count FROM assignments WHERE root_task_id = ?').get(rootTaskId) as { count: number }).count;
  }
  insertAssignment(input: { rootTaskId: string; key: string; spec: AssignmentSpec; createdBy: 'coordinator' | 'user'; creatorCallId: string | null; supersedesId: string | null }): Assignment {
    const count = this.revisionCount(input.rootTaskId);
    if (count >= ORCHESTRATION_LIMITS.maxAssignmentRevisions) throw new Error(`The task already has ${ORCHESTRATION_LIMITS.maxAssignmentRevisions} assignment revisions; no more can be created.`);
    const id = randomUUID(); const at = now();
    this.db.prepare("INSERT INTO assignments(id, root_task_id, revision, supersedes_id, key, spec, allocation, created_by, creator_call_id, state, wait_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'admission', ?, ?)")
      .run(id, input.rootTaskId, count + 1, input.supersedesId, input.key, JSON.stringify(input.spec), input.spec.allocation, input.createdBy, input.creatorCallId, at, at);
    return this.assignment(id)!;
  }
  addDependency(rootTaskId: string, predecessorId: string, successorId: string): void {
    this.db.prepare('INSERT INTO assignment_dependencies(root_task_id, predecessor_id, successor_id) VALUES (?, ?, ?)').run(rootTaskId, predecessorId, successorId);
  }
  dependencies(assignmentId: string): string[] {
    return (this.db.prepare('SELECT predecessor_id FROM assignment_dependencies WHERE successor_id = ? ORDER BY predecessor_id').all(assignmentId) as { predecessor_id: string }[]).map(row => row.predecessor_id);
  }
  dependencyEdges(rootTaskId: string): { predecessor: string; successor: string }[] {
    return (this.db.prepare('SELECT predecessor_id AS predecessor, successor_id AS successor FROM assignment_dependencies WHERE root_task_id = ?').all(rootTaskId) as { predecessor: string; successor: string }[]);
  }
  assignment(id: string): Assignment | undefined {
    const row = this.db.prepare('SELECT * FROM assignments WHERE id = ?').get(id) as AssignmentRow | undefined;
    return row ? this.mapAssignment(row) : undefined;
  }
  assignments(rootTaskId: string): Assignment[] {
    return (this.db.prepare('SELECT * FROM assignments WHERE root_task_id = ? ORDER BY revision').all(rootTaskId) as AssignmentRow[]).map(row => this.mapAssignment(row));
  }
  setAssignmentState(id: string, state: AssignmentState, waitReason: WaitReason | null = null): void {
    this.db.prepare('UPDATE assignments SET state = ?, wait_reason = ?, updated_at = ? WHERE id = ?').run(state, waitReason, now(), id);
  }
  setAssignmentWait(id: string, waitReason: WaitReason | null): void {
    this.db.prepare("UPDATE assignments SET wait_reason = ?, updated_at = ? WHERE id = ? AND state = 'proposed'").run(waitReason, now(), id);
  }
  /** Follow user/coordinator revisions forward: a dependency on a revised assignment means its latest revision. */
  effectiveAssignment(id: string): Assignment | undefined {
    let current = this.assignment(id);
    for (let depth = 0; current && depth < 16; depth++) {
      const next = this.db.prepare('SELECT id FROM assignments WHERE supersedes_id = ? ORDER BY revision DESC LIMIT 1').get(current.id) as { id: string } | undefined;
      if (!next) return current;
      current = this.assignment(next.id);
    }
    return current;
  }
  provisioningIntent(childTaskId: string): { id: string; state: string } | undefined {
    return this.db.prepare("SELECT id, state FROM intents WHERE kind = 'child.worktree.create' AND json_extract(data, '$.childTaskId') = ?").get(childTaskId) as { id: string; state: string } | undefined;
  }
  admitAssignment(id: string, childTaskId: string): void {
    const changed = this.db.prepare("UPDATE assignments SET state = 'admitted', wait_reason = NULL, child_task_id = ?, updated_at = ? WHERE id = ? AND state = 'proposed' AND child_task_id IS NULL").run(childTaskId, now(), id).changes;
    if (changed !== 1) throw new Error('Assignment is no longer waiting for admission.');
  }
  recordBase(id: string, baseCommit: string, baseTree: string): void {
    this.db.prepare('UPDATE assignments SET base_commit = ?, base_tree = ?, updated_at = ? WHERE id = ?').run(baseCommit, baseTree, now(), id);
  }

  insertResult(input: Omit<ChildResult, 'id' | 'createdAt' | 'revision'> & { manifest: EffectManifest }): ChildResult {
    const id = randomUUID();
    const revision = (this.db.prepare('SELECT COUNT(*) AS count FROM child_results WHERE assignment_id = ?').get(input.assignmentId) as { count: number }).count + 1;
    this.db.prepare('INSERT INTO child_results(id, root_task_id, assignment_id, child_task_id, revision, base_commit, commit_sha, tree_sha, changed_paths, manifest, manifest_sha256, evidence_ids, summary, unresolved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.rootTaskId, input.assignmentId, input.childTaskId, revision, input.baseCommit, input.commit, input.tree, JSON.stringify(input.changedPaths), JSON.stringify(input.manifest), input.manifestSha256, JSON.stringify(input.evidenceIds), input.summary, input.unresolved, now());
    return this.result(id)!;
  }
  result(id: string): ChildResult | undefined {
    const row = this.db.prepare('SELECT * FROM child_results WHERE id = ?').get(id) as ResultRow | undefined;
    return row ? this.mapResult(row) : undefined;
  }
  resultManifest(id: string): EffectManifest {
    const row = this.db.prepare('SELECT manifest FROM child_results WHERE id = ?').get(id) as { manifest: string } | undefined;
    if (!row) throw new Error('Child result not found.');
    return JSON.parse(row.manifest) as EffectManifest;
  }
  latestResult(assignmentId: string): ChildResult | undefined {
    const row = this.db.prepare('SELECT * FROM child_results WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1').get(assignmentId) as ResultRow | undefined;
    return row ? this.mapResult(row) : undefined;
  }
  results(rootTaskId: string): ChildResult[] {
    return (this.db.prepare('SELECT * FROM child_results WHERE root_task_id = ? ORDER BY created_at, id').all(rootTaskId) as ResultRow[]).map(row => this.mapResult(row));
  }

  insertWait(input: { rootTaskId: string; coordinatorTaskId: string; generation: number; pendingCallId: string; assignmentIds: string[] }): WaitRecord {
    const existing = this.db.prepare('SELECT id FROM wait_operations WHERE coordinator_task_id = ? AND pending_call_id = ?').get(input.coordinatorTaskId, input.pendingCallId) as { id: string } | undefined;
    if (existing) return this.wait(existing.id)!;
    const id = randomUUID(); const at = now();
    this.db.prepare("INSERT INTO wait_operations(id, root_task_id, coordinator_task_id, generation, pending_call_id, assignment_ids, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)")
      .run(id, input.rootTaskId, input.coordinatorTaskId, input.generation, input.pendingCallId, JSON.stringify(input.assignmentIds), at, at);
    return this.wait(id)!;
  }
  wait(id: string): WaitRecord | undefined {
    const row = this.db.prepare('SELECT * FROM wait_operations WHERE id = ?').get(id) as { id: string; root_task_id: string; coordinator_task_id: string; generation: number; pending_call_id: string; assignment_ids: string; state: WaitRecord['state']; result: string | null } | undefined;
    return row ? { id: row.id, rootTaskId: row.root_task_id, coordinatorTaskId: row.coordinator_task_id, generation: row.generation, pendingCallId: row.pending_call_id, assignmentIds: JSON.parse(row.assignment_ids) as string[], state: row.state, result: row.result } : undefined;
  }
  waitForCall(coordinatorTaskId: string, pendingCallId: string): WaitRecord | undefined {
    const row = this.db.prepare('SELECT id FROM wait_operations WHERE coordinator_task_id = ? AND pending_call_id = ?').get(coordinatorTaskId, pendingCallId) as { id: string } | undefined;
    return row ? this.wait(row.id) : undefined;
  }
  /** Deliver exactly once. Returns false if already delivered or cancelled. */
  deliverWait(id: string, result: string): boolean {
    return this.db.prepare("UPDATE wait_operations SET state = 'delivered', result = ?, updated_at = ? WHERE id = ? AND state = 'waiting'").run(result, now(), id).changes === 1;
  }
  cancelWaits(rootTaskId: string): void {
    this.db.prepare("UPDATE wait_operations SET state = 'cancelled', updated_at = ? WHERE root_task_id = ? AND state = 'waiting'").run(now(), rootTaskId);
  }

  insertHandoff(input: Omit<HandoffRecord, 'id' | 'state' | 'stagedTree' | 'commit' | 'detail'>): HandoffRecord {
    const id = randomUUID(); const at = now();
    this.db.prepare("INSERT INTO handoff_operations(id, root_task_id, child_task_id, assignment_id, generation, approval_id, branch, expected_head, prepared, fingerprint, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-approval', ?, ?)")
      .run(id, input.rootTaskId, input.childTaskId, input.assignmentId, input.generation, input.approvalId, input.branch, input.expectedHead, JSON.stringify(input.prepared), input.fingerprint, at, at);
    return this.handoff(id)!;
  }
  handoff(id: string): HandoffRecord | undefined {
    const row = this.db.prepare('SELECT * FROM handoff_operations WHERE id = ?').get(id) as { id: string; root_task_id: string; child_task_id: string; assignment_id: string; generation: number; approval_id: string; branch: string; expected_head: string; prepared: string; fingerprint: string; state: HandoffState; staged_tree: string | null; commit_sha: string | null; detail: string | null } | undefined;
    return row ? { id: row.id, rootTaskId: row.root_task_id, childTaskId: row.child_task_id, assignmentId: row.assignment_id, generation: row.generation, approvalId: row.approval_id, branch: row.branch, expectedHead: row.expected_head, prepared: JSON.parse(row.prepared) as unknown, fingerprint: row.fingerprint, state: row.state, stagedTree: row.staged_tree, commit: row.commit_sha, detail: row.detail } : undefined;
  }
  completedHandoff(assignmentId: string): HandoffRecord | undefined {
    const row = this.db.prepare("SELECT id FROM handoff_operations WHERE assignment_id = ? AND state = 'complete'").get(assignmentId) as { id: string } | undefined;
    return row ? this.handoff(row.id) : undefined;
  }
  handoffs(childTaskId: string): HandoffRecord[] {
    return (this.db.prepare('SELECT id FROM handoff_operations WHERE child_task_id = ? ORDER BY created_at').all(childTaskId) as { id: string }[]).map(row => this.handoff(row.id)!);
  }
  updateHandoff(id: string, update: { state: HandoffState; stagedTree?: string; commit?: string; detail?: string }): void {
    this.db.prepare('UPDATE handoff_operations SET state = ?, staged_tree = COALESCE(?, staged_tree), commit_sha = COALESCE(?, commit_sha), detail = COALESCE(?, detail), updated_at = ? WHERE id = ?')
      .run(update.state, update.stagedTree ?? null, update.commit ?? null, update.detail ?? null, now(), id);
  }

  insertIntegration(input: { idempotencyKey: string; rootTaskId: string; coordinatorTaskId: string; generation: number; pendingCallId: string | null; resultId: string; kind: 'cherry-pick' | 'continue'; parentOperationId: string | null; approvalId: string; branch: string; expectedHead: string; expectedTree: string; sourceSha: string; manifest: EffectManifest; resolvedTree: string | null; fingerprint: string }): IntegrationRecord {
    const id = randomUUID(); const at = now();
    this.db.prepare("INSERT INTO integration_operations(id, idempotency_key, root_task_id, coordinator_task_id, generation, pending_call_id, result_id, kind, parent_operation_id, approval_id, branch, expected_head, expected_tree, source_sha, manifest, manifest_sha256, resolved_tree, fingerprint, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting-approval', ?, ?)")
      .run(id, input.idempotencyKey, input.rootTaskId, input.coordinatorTaskId, input.generation, input.pendingCallId, input.resultId, input.kind, input.parentOperationId, input.approvalId, input.branch, input.expectedHead, input.expectedTree, input.sourceSha, JSON.stringify(input.manifest), input.manifest.sha256, input.resolvedTree, input.fingerprint, at, at);
    return this.integration(id)!;
  }
  integrationByKey(key: string): IntegrationRecord | undefined {
    const row = this.db.prepare('SELECT id FROM integration_operations WHERE idempotency_key = ?').get(key) as { id: string } | undefined;
    return row ? this.integration(row.id) : undefined;
  }
  integration(id: string): IntegrationRecord | undefined {
    const row = this.db.prepare('SELECT o.*, r.assignment_id FROM integration_operations o JOIN child_results r ON r.id = o.result_id WHERE o.id = ?').get(id) as (IntegrationRow & { assignment_id: string }) | undefined;
    return row ? this.mapIntegration(row) : undefined;
  }
  integrations(rootTaskId: string): IntegrationRecord[] {
    return (this.db.prepare('SELECT o.*, r.assignment_id FROM integration_operations o JOIN child_results r ON r.id = o.result_id WHERE o.root_task_id = ? ORDER BY o.created_at, o.id').all(rootTaskId) as (IntegrationRow & { assignment_id: string })[]).map(row => this.mapIntegration(row));
  }
  activeIntegration(rootTaskId: string): IntegrationRecord | undefined {
    const row = this.db.prepare("SELECT id FROM integration_operations WHERE root_task_id = ? AND state IN ('awaiting-approval', 'executing', 'conflict', 'empty', 'mismatch', 'unknown')").get(rootTaskId) as { id: string } | undefined;
    return row ? this.integration(row.id) : undefined;
  }
  updateIntegration(id: string, state: IntegrationState, observed?: IntegrationOperation['observed']): void {
    this.db.prepare('UPDATE integration_operations SET state = ?, observed = COALESCE(?, observed), updated_at = ? WHERE id = ?').run(state, observed ? JSON.stringify(observed) : null, now(), id);
  }
  succeededIntegration(resultId: string): IntegrationRecord | undefined {
    const row = this.db.prepare("SELECT id FROM integration_operations WHERE result_id = ? AND state = 'succeeded'").get(resultId) as { id: string } | undefined;
    return row ? this.integration(row.id) : undefined;
  }

  insertEvidence(input: Omit<ValidationEvidence, 'id' | 'createdAt'>): ValidationEvidence {
    const id = randomUUID();
    this.db.prepare('INSERT INTO validation_evidence(id, root_task_id, run_task_id, approval_id, kind, command, cwd, head, tree, branch, clean, state_fingerprint, exit_code, cleanup_verified, passed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.rootTaskId, input.runTaskId, input.approvalId, input.kind, input.command, input.cwd, input.head, input.tree, input.branch, input.clean ? 1 : 0, input.stateFingerprint, input.exitCode, input.cleanupVerified ? 1 : 0, input.passed ? 1 : 0, now());
    return this.evidence(id)!;
  }
  evidence(id: string): ValidationEvidence | undefined {
    const row = this.db.prepare('SELECT * FROM validation_evidence WHERE id = ?').get(id) as EvidenceRow | undefined;
    return row ? this.mapEvidence(row) : undefined;
  }
  evidenceFor(rootTaskId: string, limit = 20): ValidationEvidence[] {
    return (this.db.prepare('SELECT * FROM validation_evidence WHERE root_task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(rootTaskId, limit) as EvidenceRow[]).map(row => this.mapEvidence(row));
  }
  runEvidence(runTaskId: string, limit = 20): ValidationEvidence[] {
    return (this.db.prepare('SELECT * FROM validation_evidence WHERE run_task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(runTaskId, limit) as EvidenceRow[]).map(row => this.mapEvidence(row));
  }

  cooldown(profileId: string): { until: string; reason: string } | undefined {
    const row = this.db.prepare('SELECT until, reason FROM profile_cooldowns WHERE profile_id = ?').get(profileId) as { until: string; reason: string } | undefined;
    return row && row.until > now() ? row : undefined;
  }
  setCooldown(profileId: string, until: string, reason: string): void {
    this.db.prepare('INSERT INTO profile_cooldowns(profile_id, until, reason, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(profile_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, updated_at = excluded.updated_at').run(profileId, until, reason, now());
  }

  completion(rootTaskId: string): { head: string; tree: string; evidenceId: string; summary: string; createdAt: string } | undefined {
    const row = this.db.prepare('SELECT head, tree, evidence_id, summary, created_at FROM task_completions WHERE root_task_id = ?').get(rootTaskId) as { head: string; tree: string; evidence_id: string; summary: string; created_at: string } | undefined;
    return row ? { head: row.head, tree: row.tree, evidenceId: row.evidence_id, summary: row.summary, createdAt: row.created_at } : undefined;
  }
  insertCompletion(rootTaskId: string, head: string, tree: string, evidenceId: string, summary: string): void {
    this.db.prepare('INSERT INTO task_completions(root_task_id, head, tree, evidence_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(rootTaskId, head, tree, evidenceId, summary, now());
  }

  events(rootTaskId: string, before: number | undefined, limit: number): { sequence: number; type: string; data: unknown; createdAt: string }[] {
    const rows = this.db.prepare(`SELECT sequence, type, data, created_at FROM events WHERE task_id IN (SELECT task_id FROM agent_runs WHERE root_task_id = ?) ${before ? 'AND sequence < ?' : ''} ORDER BY sequence DESC LIMIT ?`)
      .all(...(before ? [rootTaskId, before, limit] : [rootTaskId, limit])) as { sequence: number; type: string; data: string; created_at: string }[];
    return rows.map(row => ({ sequence: row.sequence, type: row.type, data: JSON.parse(row.data) as unknown, createdAt: row.created_at }));
  }

  private mapRun(row: RunRow): AgentRun {
    const task = this.store.task(row.task_id);
    return { taskId: row.task_id, rootTaskId: row.root_task_id, parentTaskId: row.parent_task_id, role: row.role, assignmentId: row.assignment_id, lifecycle: row.lifecycle, waitReason: row.wait_reason, outcome: row.outcome, generation: row.generation, cancelRequested: row.cancel_requested === 1, title: task.title, profileId: task.profileId, worktreePath: task.worktreePath, branch: task.branch, baseCommit: task.baseCommit, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private mapAssignment(row: AssignmentRow): Assignment {
    const spec = JSON.parse(row.spec) as AssignmentSpec;
    return { ...spec, id: row.id, rootTaskId: row.root_task_id, revision: row.revision, supersedesId: row.supersedes_id, key: row.key, dependsOn: this.dependencies(row.id), createdBy: row.created_by, state: row.state, waitReason: row.wait_reason, childTaskId: row.child_task_id, baseCommit: row.base_commit, baseTree: row.base_tree, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  private mapResult(row: ResultRow): ChildResult {
    return { id: row.id, rootTaskId: row.root_task_id, assignmentId: row.assignment_id, childTaskId: row.child_task_id, revision: row.revision, baseCommit: row.base_commit, commit: row.commit_sha, tree: row.tree_sha, changedPaths: JSON.parse(row.changed_paths) as string[], manifestSha256: row.manifest_sha256, evidenceIds: JSON.parse(row.evidence_ids) as string[], summary: row.summary, unresolved: row.unresolved, createdAt: row.created_at };
  }
  private mapIntegration(row: IntegrationRow & { assignment_id: string }): IntegrationRecord {
    return { id: row.id, rootTaskId: row.root_task_id, resultId: row.result_id, assignmentId: row.assignment_id, kind: row.kind, parentOperationId: row.parent_operation_id, state: row.state, approvalId: row.approval_id, expectedHead: row.expected_head, expectedTree: row.expected_tree, sourceSha: row.source_sha, manifestSha256: row.manifest_sha256, resolvedTree: row.resolved_tree, observed: row.observed ? JSON.parse(row.observed) as IntegrationOperation['observed'] : null, createdAt: row.created_at, updatedAt: row.updated_at, coordinatorTaskId: row.coordinator_task_id, generation: row.generation, pendingCallId: row.pending_call_id, branch: row.branch, manifest: JSON.parse(row.manifest) as EffectManifest, fingerprint: row.fingerprint };
  }
  private mapEvidence(row: EvidenceRow): ValidationEvidence {
    return { id: row.id, rootTaskId: row.root_task_id, runTaskId: row.run_task_id, approvalId: row.approval_id, kind: row.kind, command: row.command, cwd: row.cwd, head: row.head, tree: row.tree, branch: row.branch, clean: row.clean === 1, stateFingerprint: row.state_fingerprint, exitCode: row.exit_code, cleanupVerified: row.cleanup_verified === 1, passed: row.passed === 1, createdAt: row.created_at };
  }
}
