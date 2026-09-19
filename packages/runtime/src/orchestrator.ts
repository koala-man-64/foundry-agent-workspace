import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Approval, Assignment, AssignmentSpec, ChildDetail, CompletionState, ModelProfile, OrchestrationView, ProviderRequest, ProviderToolResult, Task, ToolCall, WaitReason } from '../../protocol/src/index';
import { ORCHESTRATION_LIMITS, boundText } from '../../protocol/src/index';
import { ProviderHttpError } from '../../providers/src/index';
import { estimateRequest, type TurnHooks } from './agent-loop';
import { BudgetError, BudgetLedger } from './budget-ledger';
import type { CommandResult } from './command-runner';
import { GitOperationError, type CherryPickOutcome, type GitOperations, type PreparedContinue, type PreparedHandoff, type WorktreeState } from './git-operations';
import { OrchestrationRecords, type IntegrationRecord } from './orchestration-records';
import { OrchestrationToolArguments, agentRole, childBrief, coordinatorBrief, type OrchestrationToolName } from './orchestration-tools';
import { Redactor } from './redaction';
import { assertAcyclic, inScope, normalizeScope, normalizeScopePath, ordered, scopesOverlap } from './scope';
import type { Store } from './store';
import type { ApprovalBinding, OrchestrationToolHooks, ToolRuntime } from './tool-runtime';

export interface TurnPort {
  startTurn(taskId: string, content: string, hooks: TurnHooks): void;
  abort(taskId: string): boolean;
  isRunning(taskId: string): boolean;
  profileReady(profile: ModelProfile): boolean;
  profileFingerprint(profile: ModelProfile): string;
}

const OPEN_ASSIGNMENT = new Set(['proposed', 'admitted', 'result-submitted']);
const FAILED_ASSIGNMENT = new Set(['incomplete', 'failed', 'cancelled', 'revoked', 'superseded']);
const BLOCKING_INTEGRATION = new Set(['awaiting-approval', 'executing', 'conflict', 'empty', 'mismatch', 'unknown']);
const sha256 = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

class ToolFailure extends Error {}

/**
 * Runtime-owned coordinator/child orchestration. The runtime alone writes SQLite, schedules
 * children, and performs repository actions; model and repository text never grant authority.
 */
export class Orchestrator implements OrchestrationToolHooks {
  readonly records: OrchestrationRecords;
  readonly ledger: BudgetLedger;
  private readonly rootLocks = new Map<string, Promise<unknown>>();
  private readonly waiters = new Map<string, { rootTaskId: string; check: () => boolean; resolve: () => void }>();
  private readonly queue: string[] = [];
  private draining?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly continuations = new Map<string, PreparedContinue>();
  private readonly warned = new Set<string>();
  private closing = false;

  constructor(private readonly store: Store, private readonly git: GitOperations, private readonly tools: ToolRuntime, private readonly redactor: Redactor, private readonly publish: (type: string, data: unknown, taskId: string) => void, private readonly port: TurnPort) {
    this.records = new OrchestrationRecords(store);
    this.ledger = new BudgetLedger(store);
  }

  /** Stop scheduling and leave interrupted runs for durable recovery rather than marking them finished. */
  beginShutdown(): void { this.closing = true; }
  async close(): Promise<void> { this.closing = true; for (const waiter of this.waiters.values()) waiter.resolve(); await Promise.allSettled([...this.pending, this.draining]); }

  // ---------------------------------------------------------------- creation

  createRoot(task: Task): void {
    this.store.requireOrchestration();
    this.records.insertCoordinatorRun(task.id);
    this.ledger.openAccount(task.id, task.tokenBudget);
  }

  // ---------------------------------------------------------------- tool hooks

  binding(task: Task): ApprovalBinding | undefined {
    if (!this.store.orchestrationAvailable) return undefined;
    const run = this.records.run(task.id);
    if (!run || run.cancelRequested || run.lifecycle === 'terminal') return undefined;
    const root = this.store.task(run.rootTaskId);
    const assignment = run.assignmentId ? this.records.assignment(run.assignmentId) : undefined;
    return { rootTaskId: run.rootTaskId, assignmentId: run.assignmentId, generation: run.generation, targetLabel: assignment ? `Child ${assignment.key} · revision ${assignment.revision} · ${root.title}` : `Coordinator · ${root.title}` };
  }

  scopes(task: Task): { read: string[]; write: string[] } | undefined {
    const run = this.store.orchestrationAvailable ? this.records.run(task.id) : undefined;
    const assignment = run?.assignmentId ? this.records.assignment(run.assignmentId) : undefined;
    return assignment ? { read: assignment.readPaths, write: assignment.writePaths } : undefined;
  }

  withRootLock<T>(task: Task, action: () => Promise<T>): Promise<T> {
    const key = task.rootTaskId ?? task.id;
    const previous = this.rootLocks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.rootLocks.set(key, next.catch(() => undefined));
    return next;
  }

  commandStarting(task: Task): Promise<WorktreeState> { return this.git.state(task.worktreePath); }

  async commandFinished(task: Task, approval: Approval, before: unknown, executed: CommandResult, requestedEnvironment: Record<string, string>): Promise<{ evidenceId: string; passed: boolean } | undefined> {
    const run = this.records.run(task.id);
    if (!run || !approval.command || approval.cwd === undefined) return undefined;
    // Validation is configured without environment changes. A run with any model-supplied variables
    // is not the configured command, so it never becomes child or combined validation evidence.
    if (Object.keys(requestedEnvironment).length) return undefined;
    const root = this.store.task(run.rootTaskId);
    const relativeCwd = await this.relativeCwd(task.worktreePath, approval.cwd);
    let kind: 'child' | 'combined';
    if (run.role === 'coordinator') {
      const required = root.coordination!.requiredValidation;
      // Only the exact configured validation command produces combined evidence.
      if (approval.command !== required.command || relativeCwd !== normalizeScopePath(required.cwd, true) || approval.timeoutMs !== required.timeoutMs) return undefined;
      kind = 'combined';
    } else kind = 'child';
    const start = before as WorktreeState | undefined;
    const after = await this.git.state(task.worktreePath).catch(() => undefined);
    const clean = Boolean(start?.clean && after?.clean && start.operation === 'none' && after.operation === 'none');
    const unchanged = Boolean(start && after && start.head === after.head && start.tree === after.tree);
    const passed = clean && unchanged && executed.exitCode === 0 && !executed.cancelled && !executed.timedOut && executed.cleanupVerified;
    const evidence = this.records.insertEvidence({ rootTaskId: run.rootTaskId, runTaskId: task.id, approvalId: approval.id, kind, command: approval.command, cwd: relativeCwd, head: start?.head ?? '', tree: start?.tree ?? '', branch: start?.branch ?? null, clean: clean && unchanged, stateFingerprint: approval.fingerprint, exitCode: executed.exitCode, cleanupVerified: executed.cleanupVerified, passed });
    this.publish('orchestration.evidence', { evidenceId: evidence.id, kind, passed, head: evidence.head, tree: evidence.tree }, task.id);
    if (kind === 'combined') this.schedule(run.rootTaskId);
    return { evidenceId: evidence.id, passed };
  }

  denied(task: Task, tool: string, reason: string): void {
    this.publish('orchestration.policy-denied', { tool: boundText(tool, 128).text, reason }, task.id);
  }

  async execute(task: Task, call: ToolCall, signal: AbortSignal): Promise<ProviderToolResult> {
    const ok = (value: unknown): ProviderToolResult => ({ id: call.id, name: call.name, content: this.redactor.text(JSON.stringify(value)), isError: false });
    const fail = (message: string): ProviderToolResult => ({ id: call.id, name: call.name, content: this.redactor.text(message), isError: true });
    try {
      const name = call.name as OrchestrationToolName;
      const binding = this.binding(task);
      if (!binding) throw new ToolFailure('This agent is cancelled, fenced or finished; the call had no effect.');
      switch (name) {
        case 'delegate_assignments': return ok(await this.delegate(task, call, OrchestrationToolArguments.delegate_assignments.parse(call.arguments)));
        case 'await_children': return ok(await this.awaitChildren(task, call, OrchestrationToolArguments.await_children.parse(call.arguments), signal));
        case 'integrate_result': return ok(await this.integrate(task, call, OrchestrationToolArguments.integrate_result.parse(call.arguments), signal));
        case 'complete_task': return ok(await this.complete(task, OrchestrationToolArguments.complete_task.parse(call.arguments)));
        case 'commit_handoff': return ok(await this.commitHandoff(task, call, OrchestrationToolArguments.commit_handoff.parse(call.arguments), signal));
        case 'submit_handoff': return ok(await this.submitHandoff(task, OrchestrationToolArguments.submit_handoff.parse(call.arguments)));
      }
      throw new ToolFailure('Tool is not available.');
    } catch (error) {
      if (signal.aborted) return fail('Action cancelled before completion.');
      if (error instanceof Error && error.name === 'ZodError') return fail('Invalid tool arguments.');
      return fail(error instanceof Error ? error.message : 'Orchestration tool failed.');
    }
  }

  // ---------------------------------------------------------------- coordinator tools

  private requireCoordinator(task: Task): Task {
    if (agentRole(task) !== 'coordinator') throw new ToolFailure('Only the coordinator can use this tool.');
    const run = this.records.run(task.id);
    if (!run || run.role !== 'coordinator' || run.cancelRequested || run.lifecycle === 'terminal') throw new ToolFailure('The coordinated task is cancelled or finished.');
    return task;
  }

  private async delegate(task: Task, call: ToolCall, args: ReturnType<typeof OrchestrationToolArguments.delegate_assignments.parse>): Promise<unknown> {
    const root = this.requireCoordinator(task);
    const config = root.coordination!;
    const existing = this.records.assignments(root.id);
    if (existing.length + args.assignments.length > ORCHESTRATION_LIMITS.maxAssignmentRevisions) throw new ToolFailure(`Delegation would exceed ${ORCHESTRATION_LIMITS.maxAssignmentRevisions} assignment revisions for this task; nothing was created.`);
    const allowedProfiles = new Set([root.profileId, ...config.childProfileIds]);
    const keys = new Set(existing.map(item => item.key));
    const planned = args.assignments.map(item => {
      if (keys.has(item.key)) throw new ToolFailure(`Assignment key ${item.key} is already used.`);
      keys.add(item.key);
      const profileId = item.profileId ?? root.profileId;
      if (!allowedProfiles.has(profileId)) throw new ToolFailure(`Profile ${profileId} is not permitted for children of this task; no fallback profile is used.`);
      const profile = this.store.profile(profileId);
      if (!profile || !this.port.profileReady(profile)) throw new ToolFailure('The selected child profile is unavailable or not verified for tools and continuation.');
      if (item.allocation > root.tokenBudget) throw new ToolFailure('An allocation cannot exceed the task budget.');
      const writePaths = normalizeScope(item.writePaths, false);
      const readPaths = normalizeScope([...(item.readPaths ?? []), ...writePaths.filter(entry => !inScope(item.readPaths ? normalizeScope(item.readPaths, true) : [], entry))], true);
      const validation = item.validation ? { ...item.validation, cwd: normalizeScopePath(item.validation.cwd, true) } : null;
      const spec: AssignmentSpec = { objective: this.redactor.text(item.objective), acceptance: item.acceptance.map(entry => this.redactor.text(entry)), readPaths, writePaths, profileId, profileFingerprint: this.port.profileFingerprint(profile), allocation: item.allocation, validation };
      return { key: item.key, spec, dependsOn: item.dependsOn };
    });
    // Dependency graph over existing ids and new keys; reject unknown nodes and cycles.
    const node = (value: string): string => planned.some(item => item.key === value) ? `new:${value}` : value;
    const edges = new Map<string, string[]>();
    for (const item of existing) edges.set(item.id, []);
    for (const edge of this.records.dependencyEdges(root.id)) edges.get(edge.successor)?.push(edge.predecessor);
    for (const item of planned) edges.set(`new:${item.key}`, item.dependsOn.map(node));
    for (const item of planned) for (const dependency of item.dependsOn) {
      const target = existing.find(entry => entry.id === dependency);
      if (!planned.some(entry => entry.key === dependency) && (!target || target.state === 'superseded')) throw new ToolFailure(`Dependency ${dependency.slice(0, 64)} is not an assignment of this task.`);
    }
    try { assertAcyclic(edges); } catch (error) { throw new ToolFailure(error instanceof Error ? error.message : 'Invalid dependencies.'); }
    const active = existing.filter(item => OPEN_ASSIGNMENT.has(item.state));
    const candidates = [...planned.map(item => ({ id: `new:${item.key}`, writePaths: item.spec.writePaths })), ...active.map(item => ({ id: item.id, writePaths: item.writePaths }))];
    for (const item of planned) for (const other of candidates) {
      if (other.id === `new:${item.key}`) continue;
      if (scopesOverlap(item.spec.writePaths, other.writePaths) && !ordered(edges, `new:${item.key}`, other.id)) throw new ToolFailure(`Write scope of ${item.key} overlaps another open assignment without a dependency; overlapping changes must run serially.`);
    }
    const created = this.store.transaction(() => {
      const ids = new Map<string, string>();
      const rows = planned.map(item => { const row = this.records.insertAssignment({ rootTaskId: root.id, key: item.key, spec: item.spec, createdBy: 'coordinator', creatorCallId: call.id, supersedesId: null }); ids.set(item.key, row.id); return row; });
      for (const item of planned) for (const dependency of item.dependsOn) this.records.addDependency(root.id, ids.get(dependency) ?? dependency, ids.get(item.key)!);
      return rows;
    });
    for (const row of created) this.publish('orchestration.assignment-created', { assignmentId: row.id, key: row.key, revision: row.revision }, root.id);
    this.schedule(root.id);
    await this.drained();
    return { assignments: created.map(row => { const fresh = this.records.assignment(row.id)!; return { key: fresh.key, assignmentId: fresh.id, revision: fresh.revision, state: fresh.state, waitReason: fresh.waitReason }; }), note: 'At most two children run at once; other assignments wait unprovisioned without a worktree or allocation hold.' };
  }

  private settled(assignment: Assignment): boolean {
    if (!['result-submitted', 'integrated', 'incomplete', 'failed', 'cancelled', 'revoked', 'superseded'].includes(assignment.state)) return false;
    if (!assignment.childTaskId) return true;
    return this.records.run(assignment.childTaskId)?.lifecycle === 'terminal';
  }

  private async awaitChildren(task: Task, call: ToolCall, args: { assignmentIds: string[] }, signal: AbortSignal): Promise<unknown> {
    const root = this.requireCoordinator(task);
    const assignments = args.assignmentIds.map(id => {
      const assignment = this.records.assignment(id);
      if (!assignment || assignment.rootTaskId !== root.id) throw new ToolFailure('Every awaited assignment must belong to this task.');
      if (assignment.state === 'proposed') {
        const predecessors = assignment.dependsOn.map(item => this.records.effectiveAssignment(item)!);
        if (predecessors.some(item => item.state !== 'integrated')) throw new ToolFailure(`Assignment ${assignment.key} depends on predecessors that must be integrated and validated first; waiting now would never finish.`);
        // With no active child, nothing would release budget or reschedule a profile wait while the coordinator is parked.
        if (this.records.activeChildren(root.id) === 0 && (assignment.waitReason === 'task-budget' || assignment.waitReason === 'profile-quota')) throw new ToolFailure(`Assignment ${assignment.key} cannot be admitted now (${assignment.waitReason}); waiting would never finish.`);
      }
      return assignment;
    });
    const run = this.records.run(root.id)!;
    const wait = this.records.insertWait({ rootTaskId: root.id, coordinatorTaskId: root.id, generation: run.generation, pendingCallId: call.id, assignmentIds: assignments.map(item => item.id) });
    if (wait.state === 'delivered' && wait.result) return JSON.parse(wait.result) as unknown;
    this.records.setLifecycle(root.id, 'waiting', 'children');
    this.publish('orchestration.waiting', { reason: 'children', assignmentIds: wait.assignmentIds }, root.id);
    this.schedule(root.id);
    try {
      await new Promise<void>((resolve, reject) => {
        const check = (): boolean => wait.assignmentIds.every(id => this.settled(this.records.assignment(id)!));
        if (check()) { resolve(); return; }
        const abort = (): void => { this.waiters.delete(wait.id); reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled.')); };
        this.waiters.set(wait.id, { rootTaskId: root.id, check, resolve: () => { signal.removeEventListener('abort', abort); this.waiters.delete(wait.id); resolve(); } });
        signal.addEventListener('abort', abort, { once: true });
      });
    } finally {
      if (!signal.aborted) this.records.setLifecycle(root.id, 'running');
    }
    if (this.closing) throw new ToolFailure('Runtime is shutting down; the wait remains recorded for explicit resume.');
    const fresh = this.records.run(root.id)!;
    if (fresh.cancelRequested || fresh.generation !== wait.generation) throw new ToolFailure('The coordinator was cancelled while waiting.');
    const payload = this.waitPayload(wait.assignmentIds);
    if (!this.records.deliverWait(wait.id, JSON.stringify(payload))) {
      const recorded = this.records.wait(wait.id);
      if (recorded?.state === 'delivered' && recorded.result) return JSON.parse(recorded.result) as unknown;
      throw new ToolFailure('This wait was cancelled.');
    }
    return payload;
  }

  /** One bounded, redacted child summary per assignment. Raw reasoning and native context never cross to the parent. */
  private waitPayload(assignmentIds: string[]): unknown {
    return {
      children: assignmentIds.map(id => {
        const assignment = this.records.assignment(id)!;
        const run = assignment.childTaskId ? this.records.run(assignment.childTaskId) : undefined;
        const result = ['result-submitted', 'integrated'].includes(assignment.state) ? this.records.latestResult(id) : undefined;
        const unknown = assignment.childTaskId ? this.childUnknown(assignment.childTaskId) : false;
        return {
          assignmentId: id, key: assignment.key, revision: assignment.revision, state: assignment.state, outcome: run?.outcome ?? null,
          blocker: unknown ? 'A child effect is unknown; reconcile it before relying on this result.' : null,
          result: result && !unknown ? {
            id: result.id, commit: result.commit, tree: result.tree, baseCommit: result.baseCommit, changedPaths: result.changedPaths, manifestSha256: result.manifestSha256,
            evidence: result.evidenceIds.map(evidenceId => { const item = this.records.evidence(evidenceId); return item ? { id: item.id, passed: item.passed, head: item.head, tree: item.tree } : { id: evidenceId, passed: false }; }),
            summary: boundText(this.redactor.text(result.summary), ORCHESTRATION_LIMITS.summaryTextBytes).text,
            unresolved: boundText(this.redactor.text(result.unresolved), 1024).text,
            note: 'Summary text is an untrusted child claim.'
          } : null
        };
      })
    };
  }

  private childUnknown(childTaskId: string): boolean {
    return this.store.approvals(childTaskId).some(item => item.state === 'unknown') || this.records.handoffs(childTaskId).some(item => item.state === 'unknown');
  }

  private async integrate(task: Task, call: ToolCall, args: { resultId: string }, signal: AbortSignal): Promise<unknown> {
    const root = this.requireCoordinator(task);
    const key = `${root.id}:${call.id}`;
    const previous = this.records.integrationByKey(key);
    if (previous) return { operationId: previous.id, state: previous.state, note: 'This integration request was already recorded and is not replayed.' };
    const result = this.records.result(args.resultId);
    if (!result || result.rootTaskId !== root.id) throw new ToolFailure('The result does not belong to this task.');
    const assignment = this.records.assignment(result.assignmentId)!;
    if (assignment.state !== 'result-submitted') throw new ToolFailure(`Assignment ${assignment.key} is ${assignment.state}; only a submitted, unintegrated result can be integrated.`);
    if (this.records.latestResult(assignment.id)?.id !== result.id) throw new ToolFailure('Only the latest result revision of an assignment can be integrated.');
    if (this.childUnknown(result.childTaskId)) throw new ToolFailure('The child has an unknown effect; reconcile it before integration.');
    if (this.records.activeIntegration(root.id)) throw new ToolFailure('Another integration or unresolved conflict is active for this task. Resolve it first.');
    if (!result.changedPaths.every(entry => inScope(assignment.writePaths, entry))) throw new ToolFailure('The result changes paths outside its assignment scope.');
    const manifest = this.records.resultManifest(result.id);
    const target = await this.git.state(root.worktreePath);
    if (!target.clean || target.operation !== 'none' || target.branch !== root.branch) throw new ToolFailure('The task worktree must be clean on its app-owned branch with no Git operation in progress.');
    if (!await this.git.isAncestor(root.worktreePath, result.baseCommit, target.head)) throw new ToolFailure('The result base is not an ancestor of the current integration HEAD.');
    const prepared = await this.git.prepareCherryPick(root.worktreePath, { branch: root.branch, expectedHead: target.head, sha: result.commit });
    if (prepared.sourceParent !== result.baseCommit || prepared.sourceManifest.sha256 !== result.manifestSha256 || prepared.sourceManifest.sha256 !== manifest.sha256) throw new ToolFailure('The handoff commit no longer matches its recorded base or effect manifest.');
    if (!prepared.sourceManifest.entries.every(entry => inScope(assignment.writePaths, entry.path))) throw new ToolFailure('The handoff effect contains out-of-scope paths.');
    const patch = this.displayPatch(prepared.patch, prepared.patchTruncated);
    const run = this.records.run(root.id)!;
    const approvalId = randomUUID();
    const binding = { kind: 'cherry-pick' as const, resultId: result.id, assignmentId: assignment.id, sourceSha: result.commit, expectedHead: target.head, expectedTree: target.tree, manifestSha256: manifest.sha256, resolvedTree: null, changedPaths: result.changedPaths, gitPath: prepared.git.path, gitSha256: prepared.git.sha256 };
    const fingerprint = sha256({ rootTaskId: root.id, generation: run.generation, branch: root.branch, approvalId, ...binding });
    let record: IntegrationRecord;
    try {
      record = this.records.insertIntegration({ idempotencyKey: key, rootTaskId: root.id, coordinatorTaskId: root.id, generation: run.generation, pendingCallId: call.id, resultId: result.id, kind: 'cherry-pick', parentOperationId: null, approvalId, branch: root.branch, expectedHead: target.head, expectedTree: target.tree, sourceSha: result.commit, manifest, resolvedTree: null, fingerprint });
    } catch { throw new ToolFailure('Another integration became active; nothing was proposed.'); }
    const approval: Approval = { id: approvalId, taskId: root.id, toolCallId: call.id, nonce: randomUUID(), tool: 'integrate_result', state: 'awaiting-approval', createdAt: new Date().toISOString(), summary: `Cherry-pick ${assignment.key} revision ${assignment.revision} (${result.commit.slice(0, 12)}) onto the task worktree.`, fingerprint, rootTaskId: root.id, assignmentId: null, generation: run.generation, targetLabel: `Coordinator integration · ${root.title}`, integration: { ...binding, operationId: record.id, patch: patch.text, patchTruncated: patch.truncated } };
    this.records.setLifecycle(root.id, 'waiting', 'approval');
    const approved = await this.tools.requestApproval(approval, signal);
    if (!signal.aborted) this.records.setLifecycle(root.id, 'running');
    if (!approved) {
      this.records.updateIntegration(record.id, signal.aborted ? 'revoked' : 'rejected');
      this.publish('orchestration.integration', { operationId: record.id, state: signal.aborted ? 'revoked' : 'rejected' }, root.id);
      throw new ToolFailure(signal.aborted ? 'Integration cancelled before execution.' : 'User rejected this integration. Do not repeat it without new user instructions.');
    }
    return this.withRootLock(root, async () => {
      const current = this.records.run(root.id)!;
      if (current.cancelRequested || current.generation !== run.generation) {
        this.records.updateIntegration(record.id, 'revoked'); approval.state = 'revoked'; this.tools.saveApproval(approval);
        throw new ToolFailure('The coordinator was cancelled before integration; nothing was executed.');
      }
      this.store.transaction(() => { this.records.updateIntegration(record.id, 'executing'); approval.state = 'executing'; this.tools.saveApproval(approval); });
      let outcome: CherryPickOutcome;
      try { outcome = await this.git.cherryPick(root.worktreePath, { branch: root.branch, expectedHead: target.head, expectedTree: target.tree, sha: result.commit, expectedManifest: manifest }); }
      catch (error) {
        const known = error instanceof GitOperationError && error.outcome === 'none';
        outcome = known ? { kind: 'no-effect', detail: error.message } : { kind: 'unknown', detail: error instanceof Error ? error.message : 'Integration failed.' };
      }
      return this.applyIntegrationOutcome(record, approval, outcome, assignment);
    });
  }

  private applyIntegrationOutcome(record: IntegrationRecord, approval: Approval, outcome: CherryPickOutcome | { kind: 'not-started' }, assignment: Assignment): unknown {
    const detail = 'detail' in outcome ? this.redactor.text(outcome.detail).slice(0, 2000) : undefined;
    this.store.transaction(() => {
      switch (outcome.kind) {
        case 'succeeded':
          this.records.updateIntegration(record.id, 'succeeded', { commit: outcome.commit, tree: outcome.tree });
          this.records.setAssignmentState(assignment.id, 'integrated');
          approval.state = 'complete'; approval.result = { content: JSON.stringify({ integrated: true, commit: outcome.commit, tree: outcome.tree }), isError: false };
          break;
        case 'conflict':
          this.records.updateIntegration(record.id, 'conflict', { cherryPickHead: outcome.cherryPickHead, unmergedPaths: outcome.unmergedPaths.slice(0, 200), detail: `index ${outcome.indexFingerprint}` });
          approval.state = 'failed'; approval.result = { content: 'Cherry-pick stopped with conflicts. The worktree, index and CHERRY_PICK_HEAD were preserved for external resolution.', isError: true };
          break;
        case 'empty':
          this.records.updateIntegration(record.id, 'empty', { cherryPickHead: outcome.cherryPickHead, detail });
          approval.state = 'failed'; approval.result = { content: 'Cherry-pick produced no change. The state is preserved and blocked; nothing was skipped, continued or committed.', isError: true };
          break;
        case 'mismatch':
          this.records.updateIntegration(record.id, 'mismatch', { commit: outcome.commit, tree: outcome.tree, detail });
          approval.state = 'failed'; approval.result = { content: 'Git created a commit whose parent or effect does not match the approved integration. It is blocked for inspection.', isError: true };
          break;
        case 'no-effect': case 'not-started':
          this.records.updateIntegration(record.id, 'failed', { detail: detail ?? 'Proven not started.' });
          approval.state = 'failed'; approval.result = { content: `Integration did not run: ${detail ?? 'no effect'}.`, isError: true };
          break;
        case 'unknown':
          this.records.updateIntegration(record.id, 'unknown', { detail });
          approval.state = 'unknown'; approval.result = { content: 'Integration outcome is unknown. It is blocked for read-only reconciliation and will not be replayed.', isError: true };
          break;
      }
      this.tools.saveApproval(approval);
    });
    const state = this.records.integration(record.id)!.state;
    this.publish('orchestration.integration', { operationId: record.id, state, assignmentId: assignment.id }, record.rootTaskId);
    this.schedule(record.rootTaskId);
    if (state !== 'succeeded') throw new ToolFailure(`${approval.result!.content} Operation ${record.id}.`);
    return { operationId: record.id, state, commit: this.records.integration(record.id)!.observed?.commit, note: 'Run the required combined validation on this exact tree before completion or dependent work.' };
  }

  private async complete(task: Task, args: { summary: string }): Promise<unknown> {
    const root = this.requireCoordinator(task);
    return this.withRootLock(root, async () => {
      const state = await this.completionState(root.id, true);
      if (!state.complete) throw new ToolFailure(`The task cannot be completed yet: ${state.blockers.join(' ')}`);
      const target = await this.git.state(root.worktreePath);
      const evidence = this.latestCombined(root.id)!;
      this.records.insertCompletion(root.id, target.head, target.tree, evidence.id, this.redactor.text(args.summary));
      this.publish('orchestration.completed', { head: target.head, tree: target.tree, evidenceId: evidence.id }, root.id);
      return { completed: true, head: target.head, tree: target.tree, evidenceId: evidence.id };
    });
  }

  private latestCombined(rootTaskId: string) { return this.records.evidenceFor(rootTaskId, 50).find(item => item.kind === 'combined'); }

  async completionState(rootTaskId: string, forCompletion = false): Promise<CompletionState> {
    const done = this.records.completion(rootTaskId);
    const blockers: string[] = [];
    const root = this.store.task(rootTaskId);
    const run = this.records.run(rootTaskId);
    if (!run || run.cancelRequested) blockers.push('The task is cancelled.');
    const assignments = this.records.assignments(rootTaskId);
    const supersededBy = new Map(assignments.filter(item => item.supersedesId).map(item => [item.supersedesId!, item]));
    const resolved = (item: Assignment): boolean => item.state === 'integrated' || (FAILED_ASSIGNMENT.has(item.state) && Boolean(supersededBy.get(item.id)) && resolved(supersededBy.get(item.id)!));
    if (!assignments.length) blockers.push('No assignments were delegated or integrated.');
    for (const item of assignments) if (!resolved(item)) blockers.push(`Assignment ${item.key} r${item.revision} is ${item.state}, not integrated.`);
    if (this.records.runs(rootTaskId).some(item => item.role === 'child' && item.lifecycle !== 'terminal')) blockers.push('A child agent is still active.');
    for (const operation of this.records.integrations(rootTaskId)) if (BLOCKING_INTEGRATION.has(operation.state)) blockers.push(`Integration ${operation.id} is ${operation.state}.`);
    const tasks = [rootTaskId, ...assignments.map(item => item.childTaskId).filter((id): id is string => Boolean(id))];
    for (const id of tasks) {
      const approvals = this.store.approvals(id);
      if (approvals.some(item => item.state === 'awaiting-approval' || item.state === 'approved' || item.state === 'executing')) blockers.push('An approval is still pending.');
      if (approvals.some(item => item.state === 'unknown') || this.records.handoffs(id).some(item => item.state === 'unknown')) blockers.push('An effect is unknown and must be reconciled.');
    }
    let target: WorktreeState | undefined;
    try { target = await this.git.state(root.worktreePath); } catch { blockers.push('The task worktree state could not be verified.'); }
    if (target && (!target.clean || target.operation !== 'none' || target.branch !== root.branch)) blockers.push('The task worktree is not clean on its branch or has a Git operation in progress.');
    const evidence = this.latestCombined(rootTaskId);
    if (!evidence) blockers.push('The required combined validation has not run.');
    else if (!evidence.passed) blockers.push('The latest combined validation did not pass with verified cleanup on a clean tree.');
    else if (target && (evidence.head !== target.head || evidence.tree !== target.tree)) blockers.push('The combined validation is stale: the integrated tree changed after it ran.');
    if (done && !forCompletion) {
      if (target && (done.head !== target.head || done.tree !== target.tree)) return { complete: false, completedAt: done.createdAt, blockers: ['The task worktree changed after completion was recorded.'] };
      return { complete: true, completedAt: done.createdAt, blockers: [] };
    }
    if (done && forCompletion) blockers.push('Completion is already recorded.');
    return { complete: blockers.length === 0, completedAt: null, blockers: [...new Set(blockers)] };
  }

  // ---------------------------------------------------------------- child tools

  private requireChild(task: Task): { assignment: Assignment } {
    if (agentRole(task) !== 'child') throw new ToolFailure('Only a child agent can use this tool.');
    const run = this.records.run(task.id);
    if (!run || run.role !== 'child' || run.cancelRequested || run.lifecycle === 'terminal') throw new ToolFailure('This child is cancelled or finished.');
    const assignment = this.records.assignment(run.assignmentId!)!;
    if (assignment.state !== 'admitted') throw new ToolFailure(`This assignment is ${assignment.state}; no further handoff actions are accepted.`);
    return { assignment };
  }

  private async commitHandoff(task: Task, call: ToolCall, args: { paths: string[]; summary: string }, signal: AbortSignal): Promise<unknown> {
    const { assignment } = this.requireChild(task);
    if (this.records.completedHandoff(assignment.id)) throw new ToolFailure('This assignment already has its one handoff commit.');
    if (this.records.handoffs(task.id).some(item => item.state === 'unknown')) throw new ToolFailure('An earlier handoff has an unknown outcome; it must be reconciled.');
    const base = assignment.baseCommit!;
    const declared = [...new Set(args.paths.map(entry => entry.replaceAll('\\', '/')))].sort();
    const message = `Foundry handoff ${assignment.key} r${assignment.revision}: ${this.redactor.text(args.summary).split(/\r?\n/)[0]!.slice(0, 200)}\n\nAssignment: ${assignment.id}`;
    const prepared = await this.git.prepareHandoff(task.worktreePath, { branch: task.branch, expectedHead: base, message, allowed: entry => inScope(assignment.writePaths, entry) });
    if (JSON.stringify(prepared.paths) !== JSON.stringify(declared)) throw new ToolFailure(`Declared paths do not exactly match the changed paths (${prepared.paths.slice(0, 20).join(', ')}).`);
    if (this.redactor.text(prepared.patch) !== prepared.patch) throw new ToolFailure('The handoff patch contains secret-like content and cannot be committed.');
    const run = this.records.run(task.id)!;
    const patch = this.displayPatch(prepared.patch, prepared.patchTruncated);
    const approvalId = randomUUID();
    const operation = this.records.insertHandoff({ rootTaskId: run.rootTaskId, childTaskId: task.id, assignmentId: assignment.id, generation: run.generation, approvalId, branch: task.branch, expectedHead: base, prepared: this.durablePrepared(prepared), fingerprint: prepared.fingerprint });
    const handoff = { operationId: operation.id, branch: task.branch, expectedHead: base, paths: prepared.paths, manifestSha256: prepared.manifest.sha256, message, patch: patch.text, patchTruncated: patch.truncated, gitPath: prepared.git.path, gitSha256: prepared.git.sha256 };
    const approval: Approval = { id: approvalId, taskId: task.id, toolCallId: call.id, nonce: randomUUID(), tool: 'commit_handoff', state: 'awaiting-approval', createdAt: new Date().toISOString(), summary: `Commit ${prepared.paths.length} path(s) as the one handoff for ${assignment.key} revision ${assignment.revision}.`, fingerprint: sha256({ childTaskId: task.id, generation: run.generation, assignmentId: assignment.id, preparedFingerprint: prepared.fingerprint, operationId: operation.id }), rootTaskId: run.rootTaskId, assignmentId: assignment.id, generation: run.generation, targetLabel: this.binding(task)!.targetLabel, handoff };
    const approved = await this.tools.requestApproval(approval, signal);
    if (!approved) {
      this.records.updateHandoff(operation.id, { state: signal.aborted ? 'revoked' : 'rejected' });
      throw new ToolFailure(signal.aborted ? 'Handoff cancelled before execution.' : 'User rejected this handoff commit.');
    }
    const current = this.records.run(task.id)!;
    if (current.cancelRequested || current.generation !== run.generation) { this.records.updateHandoff(operation.id, { state: 'revoked' }); approval.state = 'revoked'; this.tools.saveApproval(approval); throw new ToolFailure('The child was cancelled before the commit ran.'); }
    this.store.transaction(() => { this.records.updateHandoff(operation.id, { state: 'executing' }); approval.state = 'executing'; this.tools.saveApproval(approval); });
    try {
      const committed = await this.git.commitHandoff(prepared, {
        staged: tree => this.records.updateHandoff(operation.id, { state: 'staged', stagedTree: tree }),
        committed: commit => this.records.updateHandoff(operation.id, { state: 'committed', commit })
      });
      this.store.transaction(() => {
        this.records.updateHandoff(operation.id, { state: 'complete', commit: committed.commit, stagedTree: committed.tree });
        approval.state = 'complete'; approval.result = { content: JSON.stringify(committed), isError: false }; this.tools.saveApproval(approval);
      });
      this.publish('orchestration.handoff', { operationId: operation.id, state: 'complete', commit: committed.commit }, task.id);
      return { committed: true, commit: committed.commit, tree: committed.tree, paths: prepared.paths, next: 'Run validation on this committed tree, then submit_handoff with the evidence id.' };
    } catch (error) {
      const known = error instanceof GitOperationError && error.outcome === 'none';
      const detail = this.redactor.text(error instanceof Error ? error.message : 'Commit failed.').slice(0, 1000);
      this.store.transaction(() => {
        this.records.updateHandoff(operation.id, { state: known ? 'failed' : 'unknown', detail });
        approval.state = known ? 'failed' : 'unknown'; approval.result = { content: known ? `Commit did not run: ${detail}` : `Commit outcome unknown: ${detail}. It will be reconciled, never replayed.`, isError: true }; this.tools.saveApproval(approval);
      });
      throw new ToolFailure(approval.result!.content);
    }
  }

  private durablePrepared(prepared: PreparedHandoff): unknown {
    return { worktreePath: prepared.worktreePath, branch: prepared.branch, expectedHead: prepared.expectedHead, paths: prepared.paths, entries: prepared.entries, manifest: prepared.manifest, message: prepared.message, git: prepared.git, fingerprint: prepared.fingerprint };
  }

  private async submitHandoff(task: Task, args: { summary: string; unresolved: string; evidenceIds: string[] }): Promise<unknown> {
    const { assignment } = this.requireChild(task);
    const handoff = this.records.completedHandoff(assignment.id);
    if (!handoff?.commit) throw new ToolFailure('Create the reviewed handoff commit first.');
    if (Buffer.byteLength(args.summary, 'utf8') > ORCHESTRATION_LIMITS.childReportBytes) throw new ToolFailure('The report exceeds the 16 KiB limit; shorten it.');
    if (this.childUnknown(task.id)) throw new ToolFailure('An effect of this child is unknown; it cannot submit a result.');
    const state = await this.git.state(task.worktreePath);
    if (state.head !== handoff.commit || !state.clean || state.operation !== 'none' || state.branch !== task.branch) throw new ToolFailure('The child worktree must be clean at the handoff commit.');
    const info = await this.git.commitInfo(task.worktreePath, handoff.commit);
    if (info.parents.length !== 1 || info.parents[0] !== assignment.baseCommit) throw new ToolFailure('The handoff commit must have the assignment base as its only parent.');
    const manifest = await this.git.manifest(task.worktreePath, assignment.baseCommit!, handoff.commit);
    const expected = (handoff.prepared as { manifest: { sha256: string } }).manifest;
    if (manifest.sha256 !== expected.sha256) throw new ToolFailure('The committed effect differs from the approved handoff.');
    const paths = manifest.entries.map(entry => entry.path);
    if (!paths.every(entry => inScope(assignment.writePaths, entry))) throw new ToolFailure('The committed effect is outside the assignment write scope.');
    const evidence = args.evidenceIds.map(id => this.records.evidence(id));
    if (evidence.some(item => !item || item.runTaskId !== task.id || !item.passed || item.head !== handoff.commit || item.tree !== info.tree)) throw new ToolFailure('Every evidence id must be passing runtime evidence from this child on the committed tree.');
    if (assignment.validation && !evidence.some(item => item!.command === assignment.validation!.command && item!.cwd === assignment.validation!.cwd)) throw new ToolFailure('Run the assigned validation command on the committed tree and reference its evidence id.');
    const run = this.records.run(task.id)!;
    const result = this.store.transaction(() => {
      const inserted = this.records.insertResult({ rootTaskId: run.rootTaskId, assignmentId: assignment.id, childTaskId: task.id, baseCommit: assignment.baseCommit!, commit: handoff.commit!, tree: info.tree, changedPaths: paths, manifestSha256: manifest.sha256, manifest, evidenceIds: args.evidenceIds, summary: this.redactor.text(args.summary), unresolved: this.redactor.text(args.unresolved) });
      this.records.setAssignmentState(assignment.id, 'result-submitted');
      return inserted;
    });
    this.publish('orchestration.result', { resultId: result.id, assignmentId: assignment.id, commit: result.commit }, run.rootTaskId);
    return { submitted: true, resultId: result.id, next: 'Stop now; the coordinator decides integration.' };
  }

  // ---------------------------------------------------------------- scheduler

  schedule(rootTaskId: string): void {
    if (this.closing || !this.store.orchestrationAvailable) return;
    if (!this.queue.includes(rootTaskId)) this.queue.push(rootTaskId);
    this.notifyWaits(rootTaskId);
    this.draining ??= this.drain().finally(() => { this.draining = undefined; if (this.queue.length) this.schedule(this.queue[0]!); });
  }
  private async drained(): Promise<void> { while (this.draining) await this.draining; }

  /** Round-robin across roots: one admission step per root per pass. */
  private async drain(): Promise<void> {
    while (this.queue.length && !this.closing) {
      const rootTaskId = this.queue.shift()!;
      let again = false;
      try { again = await this.admitOne(rootTaskId); }
      catch (error) { this.publish('orchestration.scheduler-error', { detail: this.redactor.text(error instanceof Error ? error.message : 'Scheduling failed.').slice(0, 500) }, rootTaskId); }
      if (again && !this.queue.includes(rootTaskId)) this.queue.push(rootTaskId);
    }
  }

  private async admitOne(rootTaskId: string): Promise<boolean> {
    const rootRun = this.records.run(rootTaskId);
    if (!rootRun || rootRun.cancelRequested || rootRun.lifecycle === 'terminal') return false;
    const proposed = this.records.assignments(rootTaskId).filter(item => item.state === 'proposed');
    if (!proposed.length) return false;
    if (this.records.activeChildren(rootTaskId) >= ORCHESTRATION_LIMITS.maxAdmittedChildren) {
      for (const item of proposed) if (item.waitReason !== 'dependencies') this.records.setAssignmentWait(item.id, 'admission');
      return false;
    }
    const root = this.store.task(rootTaskId);
    const target = await this.git.state(root.worktreePath);
    const active = this.records.activeIntegration(rootTaskId);
    for (const assignment of proposed) {
      const predecessors = assignment.dependsOn.map(id => this.records.effectiveAssignment(id)!);
      if (predecessors.some(item => FAILED_ASSIGNMENT.has(item.state))) {
        this.records.setAssignmentState(assignment.id, 'revoked', 'dependencies');
        this.publish('orchestration.assignment-revoked', { assignmentId: assignment.id, reason: 'A predecessor did not complete; the dependent assignment will not start.' }, rootTaskId);
        this.notifyWaits(rootTaskId);
        continue;
      }
      if (predecessors.length) {
        const evidence = this.latestCombined(rootTaskId);
        if (predecessors.some(item => item.state !== 'integrated') || !evidence?.passed || evidence.head !== target.head || evidence.tree !== target.tree) { this.setWait(assignment, 'dependencies'); continue; }
      }
      if (active || !target.clean || target.operation !== 'none' || target.branch !== root.branch) { this.setWait(assignment, 'reconciliation'); continue; }
      const profile = this.store.profile(assignment.profileId);
      if (!profile || this.port.profileFingerprint(profile) !== assignment.profileFingerprint || !this.port.profileReady(profile)) { this.setWait(assignment, 'profile-quota'); continue; }
      if (this.records.cooldown(profile.id)) { this.setWait(assignment, 'profile-quota'); continue; }
      const childId = randomUUID(); const now = new Date().toISOString();
      let intent: string;
      try {
        intent = this.store.transaction(() => {
          this.store.saveTask({ id: childId, title: `${assignment.key} · r${assignment.revision}`, projectPath: root.projectPath, worktreePath: '', branch: '', baseCommit: target.head, profileId: assignment.profileId, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: assignment.allocation, usedTokens: 0, mode: 'coding', role: 'child', parentTaskId: rootTaskId, rootTaskId, assignmentId: assignment.id });
          this.records.admitAssignment(assignment.id, childId);
          this.records.insertChildRun(rootTaskId, childId, assignment.id);
          this.ledger.hold(rootTaskId, assignment.id, childId, assignment.allocation);
          return this.store.intent('child.worktree.create', { rootTaskId, childTaskId: childId, assignmentId: assignment.id, baseCommit: target.head });
        });
      } catch (error) {
        if (error instanceof BudgetError) { this.setWait(assignment, 'task-budget'); continue; }
        throw error;
      }
      this.publish('orchestration.child-admitted', { childTaskId: childId, assignmentId: assignment.id, baseCommit: target.head }, rootTaskId);
      const provisioning = this.provision(root, childId, assignment.id, target.head, intent);
      this.pending.add(provisioning); void provisioning.finally(() => this.pending.delete(provisioning));
      await provisioning;
      return true;
    }
    return false;
  }

  private setWait(assignment: Assignment, reason: WaitReason): void {
    if (assignment.waitReason !== reason) { this.records.setAssignmentWait(assignment.id, reason); this.publish('orchestration.assignment-waiting', { assignmentId: assignment.id, reason }, assignment.rootTaskId); }
  }

  private async provision(root: Task, childId: string, assignmentId: string, base: string, intent: string): Promise<void> {
    let created: { worktreePath: string; branch: string; baseCommit: string; baseTree: string };
    try { created = await this.git.createChildWorktree(root.projectPath, childId, base); }
    catch (error) {
      const known = error instanceof GitOperationError && error.outcome === 'none';
      const detail = this.redactor.text(error instanceof Error ? error.message : 'Worktree creation failed.').slice(0, 500);
      if (known) {
        this.store.transaction(() => { this.store.finishIntent(intent, 'complete'); this.records.finishRun(childId, 'failed'); this.records.setAssignmentState(assignmentId, 'failed'); });
        this.releaseHold(childId);
      } else {
        this.store.transaction(() => { this.store.finishIntent(intent, 'unknown'); this.records.setLifecycle(childId, 'waiting', 'reconciliation'); });
      }
      this.publish('orchestration.child-provision-failed', { childTaskId: childId, known, detail }, root.id);
      this.notifyWaits(root.id);
      return;
    }
    this.store.transaction(() => {
      this.store.saveTask({ ...this.store.task(childId), worktreePath: created.worktreePath, branch: created.branch, baseCommit: created.baseCommit });
      this.records.recordBase(assignmentId, created.baseCommit, created.baseTree);
      this.store.finishIntent(intent, 'complete');
      this.records.setLifecycle(childId, 'queued');
    });
    const run = this.records.run(childId)!; const rootRun = this.records.run(root.id)!;
    if (run.cancelRequested || rootRun.cancelRequested) { this.finishChild(childId, 'cancelled'); return; }
    // Shutting down: the child stays queued and never started; explicit Resume may start it.
    if (this.closing) return;
    try { this.port.startTurn(childId, childBrief(this.records.assignment(assignmentId)!), this.hooks()); }
    catch (error) {
      this.publish('task.stopped', { reason: this.redactor.text(error instanceof Error ? error.message : 'Child could not start.') }, childId);
      if (error instanceof BudgetError) { this.finishChild(childId, 'incomplete'); return; }
      this.finishChild(childId, 'failed');
    }
  }

  private finishChild(childId: string, outcome: 'succeeded' | 'incomplete' | 'failed' | 'cancelled'): void {
    const run = this.records.run(childId);
    if (!run || run.lifecycle === 'terminal') return;
    const assignment = this.records.assignment(run.assignmentId!)!;
    const effective = assignment.state === 'result-submitted' && outcome !== 'cancelled' ? 'succeeded' : outcome === 'succeeded' ? 'incomplete' : outcome;
    this.store.transaction(() => {
      this.records.finishRun(childId, effective);
      if (assignment.state === 'admitted') this.records.setAssignmentState(assignment.id, effective === 'cancelled' ? 'cancelled' : effective === 'failed' ? 'failed' : 'incomplete');
    });
    this.releaseHold(childId);
    this.publish('orchestration.child-finished', { childTaskId: childId, assignmentId: assignment.id, outcome: effective }, run.rootTaskId);
    this.notifyWaits(run.rootTaskId);
    this.schedule(run.rootTaskId);
  }

  private releaseHold(childId: string): void {
    try { this.ledger.release(childId); } catch (error) { this.publish('orchestration.budget-hold-retained', { reason: error instanceof Error ? error.message : 'Hold retained.' }, childId); }
  }

  private notifyWaits(rootTaskId: string): void {
    for (const waiter of [...this.waiters.values()]) if (waiter.rootTaskId === rootTaskId && waiter.check()) waiter.resolve();
  }

  // ---------------------------------------------------------------- turn hooks

  hooks(): TurnHooks {
    return {
      reserve: (task: Task, request: ProviderRequest) => {
        const run = this.records.run(task.id);
        if (!run) throw new Error('Agent run not found.');
        const amount = estimateRequest(request);
        const requestId = this.ledger.reserve(run.rootTaskId, task.id, run.generation, amount);
        this.syncUsage(task.id, run.rootTaskId);
        return { amount, requestId };
      },
      settle: (task, handle, usage, reason) => {
        if (handle.requestId) this.ledger.settle(handle.requestId, usage, reason);
        const run = this.records.run(task.id); if (run) this.syncUsage(task.id, run.rootTaskId);
      },
      context: task => {
        if (agentRole(task) !== 'coordinator') return [];
        const profiles = [task.profileId, ...task.coordination!.childProfileIds].map(id => this.store.profile(id)).filter((item): item is ModelProfile => Boolean(item)).map(item => ({ id: item.id, name: item.name }));
        return [{ role: 'system', content: coordinatorBrief(task, task.coordination!, profiles) }];
      },
      recoverResult: (task, call) => {
        if (call.name !== 'await_children') return undefined;
        const wait = this.records.waitForCall(task.id, call.id);
        return wait?.state === 'delivered' && wait.result ? { id: call.id, name: call.name, content: wait.result, isError: false } : undefined;
      },
      providerFailed: (task, error) => {
        if (error instanceof ProviderHttpError && error.status === 429) {
          const seconds = error.retryAfterSeconds ?? 60;
          this.records.setCooldown(task.profileId, new Date(Date.now() + seconds * 1000).toISOString(), 'Provider rate limit (HTTP 429). No automatic retry.');
        }
      },
      turnEnded: (task, outcome, _detail, error) => this.turnEnded(task, outcome, error)
    };
  }

  private syncUsage(taskId: string, rootTaskId: string): void {
    const task = this.store.task(taskId);
    this.store.saveTask({ ...task, usedTokens: this.ledger.runUsage(taskId) });
    const summary = this.ledger.summary(rootTaskId);
    if (summary.warning && !this.warned.has(rootTaskId)) { this.warned.add(rootTaskId); this.publish('task.budget-warning', { usedTokens: summary.charged + summary.inFlight + summary.unusedHolds, budget: summary.cap }, rootTaskId); }
  }

  private turnEnded(task: Task, outcome: 'complete' | 'failed' | 'cancelled', error: unknown): void {
    const run = this.records.run(task.id);
    if (!run || this.closing) return;
    if (run.role === 'child') {
      this.finishChild(task.id, run.cancelRequested || outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'succeeded');
      return;
    }
    if (run.cancelRequested) { if (this.records.finishRun(task.id, 'cancelled')) this.publish('orchestration.cancelled', {}, task.id); return; }
    if (outcome === 'complete' && this.records.completion(task.id)) { this.records.finishRun(task.id, 'succeeded'); return; }
    const reason: WaitReason = error instanceof BudgetError ? 'task-budget' : error instanceof ProviderHttpError && error.status === 429 ? 'profile-quota' : 'user-continuation';
    this.records.setLifecycle(task.id, 'waiting', reason);
    this.schedule(task.id);
  }

  // ---------------------------------------------------------------- user operations

  /** task.send on a coordinated root and explicit Resume share one path: read-only reconciliation, recorded delivery, then an explicit continuation turn. */
  async resume(rootTaskId: string, content: string): Promise<{ accepted: boolean; delivered: number }> {
    this.store.requireOrchestration();
    const root = this.store.task(rootTaskId);
    const run = this.records.run(rootTaskId);
    if (root.mode !== 'coordinated' || !run) throw new Error('Not a coordinated task.');
    if (run.cancelRequested || run.lifecycle === 'terminal') throw new Error('This coordinated task is finished or cancelled.');
    if (this.port.isRunning(rootTaskId)) throw new Error('This task already has an active response.');
    for (const operation of this.records.integrations(rootTaskId)) if (operation.state === 'unknown') await this.reconcile(rootTaskId, operation.id).catch(() => undefined);
    for (const child of this.records.runs(rootTaskId)) {
      if (child.role !== 'child') continue;
      for (const handoff of this.records.handoffs(child.taskId)) if (handoff.state === 'unknown') await this.reconcile(rootTaskId, handoff.id).catch(() => undefined);
      if (child.lifecycle === 'terminal' || this.port.isRunning(child.taskId)) continue;
      if (child.waitReason === 'reconciliation') { await this.reconcileProvisioning(rootTaskId, child.taskId).catch(() => undefined); continue; }
      const assignment = this.records.assignment(child.assignmentId!)!;
      const neverStarted = Boolean(assignment.baseCommit) && this.store.detail(child.taskId).messages.length === 0;
      if (neverStarted && !run.cancelRequested) {
        // Proven never started: no provider request or tool call exists for this child.
        try { this.port.startTurn(child.taskId, childBrief(assignment), this.hooks()); } catch { this.finishChild(child.taskId, 'failed'); }
        continue;
      }
      // Interrupted child turns are never resumed silently; they become incomplete (or succeeded when a result was already recorded).
      this.finishChild(child.taskId, 'incomplete');
    }
    let delivered = 0;
    const state = this.store.providerState(rootTaskId);
    for (const call of state?.pending ?? []) {
      if (call.name !== 'await_children' || state!.results.some(item => item.id === call.id)) continue;
      const wait = this.records.waitForCall(rootTaskId, call.id);
      if (wait?.state === 'waiting' && wait.assignmentIds.every(id => this.settled(this.records.assignment(id)!)) && this.records.deliverWait(wait.id, JSON.stringify(this.waitPayload(wait.assignmentIds)))) delivered++;
    }
    this.port.startTurn(rootTaskId, content, this.hooks());
    this.records.setLifecycle(rootTaskId, 'running');
    this.schedule(rootTaskId);
    return { accepted: true, delivered };
  }

  async cancelChild(rootTaskId: string, childTaskId: string, generation: number): Promise<{ accepted: boolean }> {
    this.store.requireOrchestration();
    const run = this.records.requireRun(childTaskId, rootTaskId);
    if (run.role !== 'child') throw new Error('Select a child agent to cancel it.');
    if (run.lifecycle === 'terminal') throw new Error('This child is already finished.');
    if (run.generation !== generation || run.cancelRequested) throw new Error('This cancellation targets a stale child generation.');
    this.records.fence(childTaskId);
    this.tools.revokeWaiting(childTaskId);
    this.publish('orchestration.cancel-requested', { scope: 'child', childTaskId }, rootTaskId);
    if (!this.port.abort(childTaskId)) this.finishChild(childTaskId, 'cancelled');
    return { accepted: true };
  }

  async cancelRoot(rootTaskId: string): Promise<{ accepted: boolean }> {
    this.store.requireOrchestration();
    const run = this.records.requireRun(rootTaskId, rootTaskId);
    if (run.lifecycle === 'terminal') throw new Error('This coordinated task is already finished.');
    // Fence durably first, then stop work: late child creation, results and approvals cannot resurrect anything.
    const children = this.records.runs(rootTaskId).filter(item => item.role === 'child' && item.lifecycle !== 'terminal');
    this.store.transaction(() => {
      this.records.fence(rootTaskId);
      for (const child of children) this.records.fence(child.taskId);
      for (const assignment of this.records.assignments(rootTaskId)) if (assignment.state === 'proposed') this.records.setAssignmentState(assignment.id, 'cancelled');
      this.records.cancelWaits(rootTaskId);
    });
    for (const [approvalId] of this.continuations) {
      const approval = this.store.approval(approvalId);
      if (approval.rootTaskId === rootTaskId && approval.state === 'awaiting-approval') { approval.state = 'revoked'; this.tools.saveApproval(approval); if (approval.integration) this.records.updateIntegration(approval.integration.operationId, 'revoked'); this.continuations.delete(approvalId); }
    }
    this.publish('orchestration.cancel-requested', { scope: 'root' }, rootTaskId);
    for (const child of children) { this.tools.revokeWaiting(child.taskId); if (!this.port.abort(child.taskId)) this.finishChild(child.taskId, 'cancelled'); }
    for (const waiter of [...this.waiters.values()]) if (waiter.rootTaskId === rootTaskId) waiter.resolve();
    this.tools.revokeWaiting(rootTaskId);
    if (!this.port.abort(rootTaskId) && this.records.finishRun(rootTaskId, 'cancelled')) this.publish('orchestration.cancelled', {}, rootTaskId);
    return { accepted: true };
  }

  reviseAssignment(rootTaskId: string, assignmentId: string, objective: string, acceptance: string[]): { assignmentId: string; revision: number } {
    this.store.requireOrchestration();
    const run = this.records.requireRun(rootTaskId, rootTaskId);
    if (run.cancelRequested || run.lifecycle === 'terminal') throw new Error('This coordinated task is finished or cancelled.');
    const previous = this.records.assignment(assignmentId);
    if (!previous || previous.rootTaskId !== rootTaskId) throw new Error('Assignment not found for this task.');
    if (!['proposed', 'incomplete', 'failed', 'cancelled', 'revoked'].includes(previous.state)) throw new Error('Only a waiting or unsuccessful assignment can be revised; running and integrated work keeps its revision.');
    const created = this.store.transaction(() => {
      if (previous.state === 'proposed') this.records.setAssignmentState(previous.id, 'superseded');
      const row = this.records.insertAssignment({ rootTaskId, key: previous.key, spec: { objective: this.redactor.text(objective), acceptance: acceptance.map(item => this.redactor.text(item)), readPaths: previous.readPaths, writePaths: previous.writePaths, profileId: previous.profileId, profileFingerprint: previous.profileFingerprint, allocation: previous.allocation, validation: previous.validation }, createdBy: 'user', creatorCallId: null, supersedesId: previous.id });
      for (const dependency of previous.dependsOn) this.records.addDependency(rootTaskId, dependency, row.id);
      return row;
    });
    this.publish('orchestration.assignment-revised', { assignmentId: created.id, supersedesId: previous.id, revision: created.revision }, rootTaskId);
    this.schedule(rootTaskId);
    return { assignmentId: created.id, revision: created.revision };
  }

  decide(input: { rootTaskId: string; taskId: string; approvalId: string; nonce: string; assignmentId: string | null; generation: number; fingerprint: string; decision: 'approve' | 'reject' }): { accepted: boolean } {
    this.store.requireOrchestration();
    const approval = this.store.approval(input.approvalId);
    if (approval.rootTaskId !== input.rootTaskId || approval.taskId !== input.taskId) throw new Error('This approval is stale or does not match the selected agent, revision or generation.');
    const run = this.records.requireRun(approval.taskId, input.rootTaskId);
    if (run.cancelRequested || run.lifecycle === 'terminal') throw new Error('This approval is stale or does not match the selected agent, revision or generation.');
    if (approval.tool === 'continue_integration') return this.decideContinue(approval, input, run.generation);
    return this.tools.decideBound(input, run.generation);
  }

  async prepareContinue(rootTaskId: string, operationId: string): Promise<{ approvalId: string }> {
    this.store.requireOrchestration();
    const run = this.records.requireRun(rootTaskId, rootTaskId);
    if (run.cancelRequested || run.lifecycle === 'terminal') throw new Error('This coordinated task is finished or cancelled.');
    const root = this.store.task(rootTaskId);
    const operation = this.records.integration(operationId);
    if (!operation || operation.rootTaskId !== rootTaskId || operation.kind !== 'cherry-pick') throw new Error('Integration operation not found.');
    const children = this.records.integrations(rootTaskId).filter(item => item.parentOperationId === operation.id);
    if (!(operation.state === 'conflict' || (operation.state === 'continued' && children.every(item => ['rejected', 'revoked', 'failed'].includes(item.state))))) throw new Error('Only a preserved conflict can be continued.');
    const cherryPickHead = operation.observed?.cherryPickHead;
    if (!cherryPickHead) throw new Error('The conflict has no recorded CHERRY_PICK_HEAD; reconcile it first.');
    return this.withRootLock(root, async () => {
      const prepared = await this.git.prepareContinue(root.worktreePath, { branch: operation.branch, expectedHead: operation.expectedHead, cherryPickHead });
      const assignment = this.records.assignment(operation.assignmentId)!;
      if (!prepared.manifest.entries.every(entry => inScope(assignment.writePaths, entry.path))) throw new Error('The resolution changes paths outside the assignment write scope; it cannot be continued.');
      if (this.redactor.text(prepared.patch) !== prepared.patch) throw new Error('The resolution contains secret-like content and cannot be committed.');
      const patch = this.displayPatch(prepared.patch, prepared.patchTruncated);
      const approvalId = randomUUID();
      const record = this.store.transaction(() => {
        if (operation.state === 'conflict') this.records.updateIntegration(operation.id, 'continued');
        return this.records.insertIntegration({ idempotencyKey: `continue:${operation.id}:${approvalId}`, rootTaskId, coordinatorTaskId: rootTaskId, generation: run.generation, pendingCallId: null, resultId: operation.resultId, kind: 'continue', parentOperationId: operation.id, approvalId, branch: operation.branch, expectedHead: operation.expectedHead, expectedTree: operation.expectedTree, sourceSha: operation.sourceSha, manifest: prepared.manifest, resolvedTree: prepared.resolvedTree, fingerprint: prepared.fingerprint });
      });
      const approval: Approval = { id: approvalId, taskId: rootTaskId, toolCallId: `continue:${record.id}`, nonce: randomUUID(), tool: 'continue_integration', state: 'awaiting-approval', createdAt: new Date().toISOString(), summary: `Continue the preserved cherry-pick for ${assignment.key} with this exact resolved tree.`, fingerprint: sha256({ operationId: record.id, generation: run.generation, prepared: prepared.fingerprint }), rootTaskId, assignmentId: null, generation: run.generation, targetLabel: `Coordinator conflict continuation · ${root.title}`, integration: { operationId: record.id, kind: 'continue', resultId: operation.resultId, assignmentId: assignment.id, sourceSha: operation.sourceSha, expectedHead: operation.expectedHead, expectedTree: operation.expectedTree, manifestSha256: prepared.manifest.sha256, resolvedTree: prepared.resolvedTree, changedPaths: prepared.manifest.entries.map(entry => entry.path), patch: patch.text, patchTruncated: patch.truncated, gitPath: prepared.git.path, gitSha256: prepared.git.sha256 } };
      this.tools.saveApproval(approval);
      this.continuations.set(approvalId, prepared);
      this.records.setLifecycle(rootTaskId, 'waiting', 'approval');
      return { approvalId };
    });
  }

  private decideContinue(approval: Approval, input: { nonce: string; assignmentId: string | null; generation: number; fingerprint: string; decision: 'approve' | 'reject' }, generation: number): { accepted: boolean } {
    const prepared = this.continuations.get(approval.id);
    if (!prepared || approval.state !== 'awaiting-approval' || approval.nonce !== input.nonce || input.assignmentId !== null || approval.generation !== input.generation || approval.generation !== generation || approval.fingerprint !== input.fingerprint) throw new Error('This approval is stale or does not match the selected agent, revision or generation.');
    this.continuations.delete(approval.id);
    const operation = this.records.integration(approval.integration!.operationId)!;
    if (input.decision === 'reject') {
      this.store.transaction(() => { approval.state = 'rejected'; this.tools.saveApproval(approval); this.records.updateIntegration(operation.id, 'rejected'); });
      this.records.setLifecycle(approval.rootTaskId!, 'waiting', 'conflict');
      return { accepted: true };
    }
    approval.state = 'approved'; this.tools.saveApproval(approval);
    const root = this.store.task(approval.rootTaskId!);
    const execution = this.withRootLock(root, async () => {
      this.store.transaction(() => { this.records.updateIntegration(operation.id, 'executing'); approval.state = 'executing'; this.tools.saveApproval(approval); });
      const parent = this.records.integration(operation.parentOperationId!)!;
      let outcome: CherryPickOutcome;
      try { outcome = await this.git.continueCherryPick(root.worktreePath, { branch: operation.branch, expectedHead: operation.expectedHead, cherryPickHead: parent.observed!.cherryPickHead!, prepared }); }
      catch (error) { outcome = error instanceof GitOperationError && error.outcome === 'none' ? { kind: 'no-effect', detail: error.message } : { kind: 'unknown', detail: error instanceof Error ? error.message : 'Continue failed.' }; }
      try { this.applyIntegrationOutcome(operation, approval, outcome, this.records.assignment(operation.assignmentId)!); } catch { /* outcome recorded for the user */ }
      if (outcome.kind === 'succeeded') this.records.setLifecycle(root.id, 'waiting', 'user-continuation');
    });
    this.pending.add(execution); void execution.finally(() => this.pending.delete(execution));
    return { accepted: true };
  }

  async reconcile(rootTaskId: string, operationId: string): Promise<{ kind: string; detail: string }> {
    this.store.requireOrchestration();
    const root = this.store.task(rootTaskId);
    const childRun = this.records.run(operationId);
    if (childRun?.role === 'child') return this.reconcileProvisioning(rootTaskId, operationId);
    const integration = this.records.integration(operationId);
    if (integration) {
      if (integration.rootTaskId !== rootTaskId) throw new Error('Operation not found for this task.');
      if (!['unknown', 'conflict', 'empty', 'mismatch'].includes(integration.state)) throw new Error('Only an unknown or blocked integration can be checked.');
      const parent = integration.parentOperationId ? this.records.integration(integration.parentOperationId) : undefined;
      const outcome = await this.withRootLock(root, () => this.git.reconcileIntegration(root.worktreePath, { branch: integration.branch, expectedHead: integration.expectedHead, sha: integration.sourceSha, expectedManifest: integration.manifest, ...(integration.resolvedTree ? { resolvedTree: integration.resolvedTree } : {}) }));
      if (outcome.kind === 'conflict' && parent) return { kind: 'conflict', detail: 'The continuation did not complete; the conflict is still present.' };
      const approval = integration.approvalId ? this.store.approval(integration.approvalId) : undefined;
      if (outcome.kind === integration.state && outcome.kind !== 'unknown') return { kind: outcome.kind, detail: 'State unchanged; still blocked for external resolution.' };
      const shadow: Approval = approval ?? { id: randomUUID(), taskId: rootTaskId, toolCallId: 'reconcile', nonce: randomUUID(), tool: 'integrate_result', state: 'unknown', createdAt: new Date().toISOString(), summary: 'Reconciliation', fingerprint: integration.fingerprint };
      try { this.applyIntegrationOutcome(integration, shadow, outcome, this.records.assignment(integration.assignmentId)!); } catch { /* recorded */ }
      const fresh = this.records.integration(operationId)!;
      return { kind: fresh.state, detail: 'Read-only reconciliation from observed Git state. Nothing was replayed, reset, aborted or skipped.' };
    }
    const handoff = this.store.orchestrationAvailable ? this.records.handoff(operationId) : undefined;
    if (!handoff || handoff.rootTaskId !== rootTaskId) throw new Error('Operation not found for this task.');
    if (handoff.state !== 'unknown') throw new Error('Only an unknown handoff can be checked.');
    const child = this.store.task(handoff.childTaskId);
    const prepared = handoff.prepared as { manifest: { entries: never[]; sha256: string } };
    const outcome = await this.git.reconcileHandoff(child.worktreePath, { branch: handoff.branch, expectedHead: handoff.expectedHead, manifest: prepared.manifest });
    const approval = this.store.approval(handoff.approvalId);
    this.store.transaction(() => {
      if (outcome.kind === 'complete') { this.records.updateHandoff(handoff.id, { state: 'complete', commit: outcome.commit, stagedTree: outcome.tree }); approval.state = 'complete'; approval.result = { content: JSON.stringify({ reconciled: true, commit: outcome.commit, tree: outcome.tree }), isError: false }; }
      else if (outcome.kind === 'not-started') { this.records.updateHandoff(handoff.id, { state: 'failed', detail: 'Read-only reconciliation proved the commit did not start.' }); approval.state = 'failed'; approval.result = { content: 'Proven not started. Nothing was retried.', isError: true }; }
      else { approval.result = { content: `Outcome remains unknown: ${this.redactor.text(outcome.detail).slice(0, 500)}`, isError: true }; }
      this.tools.saveApproval(approval);
    });
    return { kind: outcome.kind, detail: outcome.kind === 'unknown' ? this.redactor.text(outcome.detail).slice(0, 500) : 'Read-only reconciliation from observed Git state.' };
  }

  /**
   * Read-only reconciliation of a child whose worktree creation outcome is unknown. A proven
   * creation continues as never started; a proven absence fails with no effect; anything else
   * stays visibly blocked. Nothing is retried, created or deleted here.
   */
  private async reconcileProvisioning(rootTaskId: string, childTaskId: string): Promise<{ kind: string; detail: string }> {
    const run = this.records.requireRun(childTaskId, rootTaskId);
    if (run.role !== 'child' || run.lifecycle !== 'waiting' || run.waitReason !== 'reconciliation') throw new Error('Only a child whose worktree creation outcome is unknown can be checked.');
    const root = this.store.task(rootTaskId); const child = this.store.task(childTaskId);
    const assignment = this.records.assignment(run.assignmentId!)!;
    const intent = this.records.provisioningIntent(childTaskId);
    const outcome = await this.git.reconcileChildWorktree(root.projectPath, childTaskId, child.baseCommit);
    if (outcome.kind === 'unknown') {
      this.publish('orchestration.child-provision-unknown', { childTaskId, detail: this.redactor.text(outcome.detail).slice(0, 500) }, rootTaskId);
      return { kind: 'unknown', detail: `Worktree creation remains unknown: ${this.redactor.text(outcome.detail).slice(0, 500)}. The child stays blocked for inspection.` };
    }
    if (outcome.kind === 'not-started') {
      if (intent) this.store.finishIntent(intent.id, 'complete');
      this.finishChild(childTaskId, 'failed');
      return { kind: 'not-started', detail: 'Read-only reconciliation proved the worktree was never created. The assignment failed with no repository effect.' };
    }
    this.store.transaction(() => {
      this.store.saveTask({ ...this.store.task(childTaskId), worktreePath: outcome.worktreePath, branch: outcome.branch, baseCommit: outcome.baseCommit });
      if (!assignment.baseCommit) this.records.recordBase(assignment.id, outcome.baseCommit, outcome.baseTree);
      if (intent) this.store.finishIntent(intent.id, 'complete');
      this.records.setLifecycle(childTaskId, 'queued');
    });
    this.publish('orchestration.child-provision-reconciled', { childTaskId, worktreePath: outcome.worktreePath }, rootTaskId);
    // Re-read both runs: a cancellation may have landed during the asynchronous Git check.
    const rootRun = this.records.run(rootTaskId)!; const childRun = this.records.run(childTaskId)!;
    if (childRun.cancelRequested || rootRun.cancelRequested) { this.finishChild(childTaskId, 'cancelled'); return { kind: 'complete', detail: 'Worktree creation was proven complete; the child was already cancelled and did not start.' }; }
    if (this.store.detail(childTaskId).messages.length === 0) {
      try { this.port.startTurn(childTaskId, childBrief(this.records.assignment(assignment.id)!), this.hooks()); }
      catch { this.finishChild(childTaskId, 'failed'); }
    }
    return { kind: 'complete', detail: 'Read-only reconciliation proved the exact child worktree exists; the never-started child was scheduled.' };
  }

  // ---------------------------------------------------------------- views

  async view(rootTaskId: string, runsCursor = 0, eventsBefore?: number): Promise<OrchestrationView> {
    this.store.requireOrchestration();
    const root = this.store.task(rootTaskId);
    if (root.mode !== 'coordinated' || !root.coordination) throw new Error('Not a coordinated task.');
    const allRuns = this.records.runs(rootTaskId);
    const pageSize = ORCHESTRATION_LIMITS.childSummariesPerPage;
    const coordinator = allRuns.filter(item => item.role === 'coordinator');
    const children = allRuns.filter(item => item.role === 'child');
    const pageRuns = [...coordinator, ...children.slice(runsCursor, runsCursor + pageSize)];
    const bound = (value: string, bytes = ORCHESTRATION_LIMITS.summaryTextBytes) => boundText(this.redactor.text(value), bytes).text;
    let truncated = false;
    const assignments = this.records.assignments(rootTaskId).map(item => ({ ...item, objective: bound(item.objective), acceptance: item.acceptance.map(entry => bound(entry, 1024)) }));
    const results = this.records.results(rootTaskId).map(item => ({ ...item, summary: bound(item.summary), unresolved: bound(item.unresolved, 1024) }));
    const integrations = this.records.integrations(rootTaskId).map(({ manifest: _manifest, coordinatorTaskId: _c, generation: _g, pendingCallId: _p, branch: _b, fingerprint: _f, ...rest }) => rest);
    let events = this.records.events(rootTaskId, eventsBefore, ORCHESTRATION_LIMITS.eventsPerPage).map(item => ({ ...item, data: this.boundEventData(item.data) }));
    const base = { rootTaskId, config: root.coordination, runs: pageRuns, runsCursor: children.length > runsCursor + pageSize ? runsCursor + pageSize : null, assignments, results, integrations, evidence: this.records.evidenceFor(rootTaskId, 20), budget: this.ledger.summary(rootTaskId), completion: await this.completionState(rootTaskId) };
    // Return fewer events with a cursor rather than exceed the orchestration response ceiling.
    while (Buffer.byteLength(JSON.stringify({ ...base, events }), 'utf8') > ORCHESTRATION_LIMITS.responseBytes && events.length) { events = events.slice(0, Math.floor(events.length / 2)); truncated = true; }
    const view: OrchestrationView = { ...base, events, eventsCursor: events.length ? events[events.length - 1]!.sequence : null, truncated };
    if (Buffer.byteLength(JSON.stringify(view), 'utf8') > ORCHESTRATION_LIMITS.responseBytes) throw new Error('The orchestration summary exceeds the response ceiling; retained records were not deleted.');
    return view;
  }

  childDetail(rootTaskId: string, childTaskId: string): ChildDetail {
    this.store.requireOrchestration();
    const run = this.records.requireRun(childTaskId, rootTaskId);
    const detail = this.store.detail(childTaskId);
    let truncated = false;
    let budget = ORCHESTRATION_LIMITS.responseBytes / 2;
    const messages = [...detail.messages].reverse().map(message => {
      const bounded = boundText(message.content, ORCHESTRATION_LIMITS.childReportBytes);
      budget -= Buffer.byteLength(bounded.text, 'utf8');
      if (bounded.truncated) truncated = true;
      return { id: message.id, role: message.role, content: bounded.text, status: message.status, createdAt: message.createdAt, truncated: bounded.truncated };
    }).filter(() => { if (budget < 0) { truncated = true; return false; } return true; }).reverse();
    const approvals = (detail.approvals ?? []).slice(-10).map(item => ({ ...item, ...(item.before !== undefined ? { before: boundText(item.before, 8192).text } : {}), ...(item.after !== undefined ? { after: boundText(item.after, 8192).text } : {}) }));
    const assignment = run.assignmentId ? this.records.assignment(run.assignmentId) ?? null : null;
    const result: ChildDetail = { run, assignment, messages, approvals, results: assignment ? this.records.results(rootTaskId).filter(item => item.assignmentId === assignment.id) : [], evidence: this.records.runEvidence(childTaskId, 10), truncated };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > ORCHESTRATION_LIMITS.responseBytes) return { ...result, approvals: result.approvals.map(item => ({ ...item, before: undefined, after: undefined, handoff: item.handoff ? { ...item.handoff, patch: '[omitted from this page]', patchTruncated: true } : undefined })), messages: result.messages.slice(-4), truncated: true };
    return result;
  }

  private boundEventData(data: unknown): unknown {
    const text = JSON.stringify(data ?? {});
    return Buffer.byteLength(text, 'utf8') <= ORCHESTRATION_LIMITS.summaryTextBytes ? data : { truncated: true, preview: boundText(this.redactor.text(text), 512).text };
  }

  private displayPatch(patch: string, truncated: boolean): { text: string; truncated: boolean } {
    const bounded = boundText(this.redactor.text(patch), ORCHESTRATION_LIMITS.patchBytes);
    return { text: bounded.text, truncated: truncated || bounded.truncated };
  }

  private async relativeCwd(worktreePath: string, cwd: string): Promise<string> {
    const root = await fs.realpath(worktreePath);
    return path.relative(root, cwd).split(path.sep).join('/');
  }
}
