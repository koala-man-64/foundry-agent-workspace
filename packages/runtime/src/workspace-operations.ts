import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Approval, CommitResult, CompactionRecord, DiagnosticsExport, ModelProfile, PushResult, RetireResult, Task, UsageReport } from '../../protocol/src/index';
import { CONTEXT_WARNING_PERCENT, boundText } from '../../protocol/src/index';
import { estimateContext, prepareRequest } from './agent-loop';
import { applyCompactions, compactContinuation, estimateContinuationTokens, planMessageCompaction, summarizeMessages } from './compaction';
import { McpManager } from './mcp';
import { usesTools } from './orchestration-tools';
import { Redactor } from './redaction';
import { RepositoryService, RepositoryError } from './repository';
import { Store } from './store';

export interface OperationPorts {
  isRunning(taskId: string): boolean;
  profileFingerprint(profile: ModelProfile): string;
  activeRuns(rootTaskId: string): number;
}

/**
 * Explicit user operations added in phase 04: compaction, usage visibility, sanitized diagnostics,
 * and the commit/push/retire actions that are never proposed or executed by a model.
 */
export class WorkspaceOperations {
  constructor(private readonly store: Store, private readonly repositories: RepositoryService, private readonly redactor: Redactor, private readonly mcp: McpManager, private readonly publish: (type: string, data: unknown, taskId?: string) => void, private readonly ports: OperationPorts, private readonly dataDirectory: string) {}

  // ---------------------------------------------------------------- compaction

  compact(taskId: string, keepRecent: number): CompactionRecord {
    const task = this.store.task(taskId);
    if (this.ports.isRunning(taskId) || task.status === 'running') throw new Error('Wait for the active response to finish or cancel it before compacting.');
    if (task.status === 'retired') throw new Error('This task is retired.');
    if (this.store.approvals(taskId).some(item => item.state === 'unknown')) throw new Error('This task has an unknown mutation outcome. Check the outcome and inspect its worktree before compacting; nothing was changed.');
    const profile = this.store.profile(task.profileId);
    if (!profile) throw new Error('Profile not found.');
    const messages = this.store.messagesWithOrdinals(taskId);
    const existing = this.store.compactions(taskId);
    const plan = planMessageCompaction(messages, existing, keepRecent);
    const summary = this.redactor.text(summarizeMessages(plan.messages, this.store.approvals(taskId)));
    const state = usesTools(task) ? this.store.providerState(taskId) : undefined;
    if (state && state.fingerprint !== this.ports.profileFingerprint(profile)) throw new Error('This task has native conversation state for an earlier profile configuration and cannot be compacted.');
    const before = state ? estimateContinuationTokens(state.continuation) : Buffer.byteLength(JSON.stringify(applyCompactions(messages, existing)), 'utf8');
    // The provider-native history is compacted shape by shape and validated before anything is stored. It keeps as many
    // recent user turns as the retained recent messages contain (at least one), so both views agree on what stays verbatim.
    const keptTurns = Math.max(1, messages.filter(message => message.status === 'complete' && message.ordinal > plan.toOrdinal && message.role === 'user').length);
    const compacted = state ? compactContinuation(state.continuation, summary, keptTurns) : undefined;
    const nextState = state && compacted ? { ...state, continuation: compacted.continuation } : undefined;
    const record: CompactionRecord = { id: randomUUID(), taskId, fromOrdinal: plan.fromOrdinal, toOrdinal: plan.toOrdinal, messageIds: plan.messages.map(message => message.id), summary, estimatedTokensBefore: before, estimatedTokensAfter: 0, createdAt: new Date().toISOString() };
    record.estimatedTokensAfter = nextState ? estimateContinuationTokens(nextState.continuation) : Buffer.byteLength(JSON.stringify(applyCompactions(messages, [...existing, record])), 'utf8');
    this.store.transaction(() => {
      this.store.saveCompaction(record, state, nextState);
      if (nextState) this.store.saveProviderState(taskId, nextState);
      this.store.saveTask({ ...this.store.task(taskId), updatedAt: record.createdAt });
    });
    this.publish('task.compacted', { compactedMessages: record.messageIds.length, removedNativeItems: compacted?.removedItems ?? 0, estimatedTokensBefore: record.estimatedTokensBefore, estimatedTokensAfter: record.estimatedTokensAfter }, taskId);
    return record;
  }

  // ---------------------------------------------------------------- usage

  usage(taskId: string): UsageReport {
    const task = this.store.task(taskId);
    const profile = this.store.profile(task.profileId);
    if (!profile) throw new Error('Profile not found.');
    let estimated: number;
    try {
      const request = prepareRequest(this.store, task, profile, this.ports.profileFingerprint(profile), 'estimate', undefined, new AbortController().signal, undefined, this.mcp.toolDefinitions());
      estimated = estimateContext(request);
    } catch {
      estimated = estimateContinuationTokens(this.store.providerState(taskId)?.continuation) + profile.outputLimit;
    }
    const { records } = this.store.usageRecords(taskId, 100);
    return {
      taskId, tokenBudget: task.tokenBudget, usedTokens: task.usedTokens, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit,
      estimatedContextTokens: estimated, contextPercent: Math.round(estimated / profile.contextLimit * 100), warningPercent: CONTEXT_WARNING_PERCENT,
      totals: this.store.usageTotals(taskId), records, compactions: this.store.compactions(taskId)
    };
  }

  // ---------------------------------------------------------------- diagnostics

  async exportDiagnostics(): Promise<DiagnosticsExport> {
    const tasks = this.store.allTasks();
    const scrub = (value: unknown): unknown => JSON.parse(this.redactor.text(JSON.stringify(value)));
    const bundle = {
      generatedAt: new Date().toISOString(), application: 'foundry-agent-workspace', schemaVersion: this.store.schemaVersion, platform: `${process.platform} ${process.arch}`, node: process.versions.node,
      // Private file contents, patches, before/after evidence, credentials and environment values are deliberately absent.
      profiles: this.store.snapshot().profiles.map(profile => ({ id: profile.id, name: profile.name, apiKind: profile.apiKind, endpointHost: safeHost(profile.endpoint), deployment: profile.deployment, contextLimit: profile.contextLimit, outputLimit: profile.outputLimit, verifiedAt: profile.verifiedAt ?? null, capabilities: profile.capabilities ?? null })),
      tasks: tasks.map(task => ({
        id: task.id, title: boundText(task.title, 200).text, mode: task.mode ?? 'chat', role: task.role ?? null, rootTaskId: task.rootTaskId ?? null, status: task.status, profileId: task.profileId, branch: task.branch, baseCommit: task.baseCommit,
        worktreePath: task.worktreePath, createdAt: task.createdAt, updatedAt: task.updatedAt, retiredAt: task.retiredAt ?? null, tokenBudget: task.tokenBudget, usedTokens: task.usedTokens,
        messageCount: this.store.messagesWithOrdinals(task.id).length, usage: this.store.usageTotals(task.id),
        compactions: this.store.compactions(task.id).map(record => ({ id: record.id, fromOrdinal: record.fromOrdinal, toOrdinal: record.toOrdinal, messages: record.messageIds.length, estimatedTokensBefore: record.estimatedTokensBefore, estimatedTokensAfter: record.estimatedTokensAfter, createdAt: record.createdAt })),
        approvals: this.store.approvals(task.id).slice(-50).map(approval => summarizeApproval(approval))
      })),
      mcpServers: this.store.mcpServers().map(server => ({ id: server.id, key: server.key, name: server.name, command: server.command, argumentCount: server.arguments.length, enabled: server.enabled, readOnlyTools: server.readOnlyTools, tools: server.tools.map(tool => tool.name), toolsListedAt: server.toolsListedAt, lastError: server.lastError, running: this.mcp.statusOf(server.id).running })),
      unknownWorktreeIntents: this.store.unknownIntents(),
      recentEvents: this.store.recentEvents(200).map(event => ({ sequence: event.sequence, type: event.type, taskId: event.taskId ?? null, createdAt: event.createdAt, data: boundText(JSON.stringify(event.data ?? {}), 512).text }))
    };
    const text = JSON.stringify(scrub(bundle), null, 2);
    if (this.redactor.text(text) !== text) throw new Error('Diagnostics export still contained secret-like content and was not written.');
    const directory = path.join(this.dataDirectory, 'diagnostics');
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, `diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
    await fs.writeFile(target, text, { flag: 'wx', mode: 0o600 });
    return { path: target, bytes: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text).digest('hex') };
  }

  // ---------------------------------------------------------------- explicit Git actions

  private publishable(taskId: string): Task {
    const task = this.store.task(taskId);
    if (this.ports.isRunning(taskId) || task.status === 'running') throw new Error('Wait for the active response to finish or cancel it first.');
    if (task.status === 'retired') throw new Error('This task worktree is retired.');
    if (task.parentTaskId || task.role === 'child') throw new Error('Child agent worktrees are published only through reviewed handoff commits and coordinator integration.');
    if (task.mode === 'coordinated') throw new Error('Coordinated task worktrees are integrated through reviewed operations; commit and push are available for chat and coding tasks.');
    const unknowns = this.store.unknownPublicationIntents(taskId);
    if (unknowns.length > 0) throw new Error(`This task has an unknown ${unknowns[0]!.kind} outcome. Reconcile publication state before attempting another operation.`);
    return task;
  }

  async reconcilePublication(taskId: string): Promise<{ reconciled: boolean; detail: string }> {
    const task = this.store.task(taskId);
    const unknowns = this.store.unknownPublicationIntents(taskId);
    if (!unknowns.length) return { reconciled: true, detail: 'No unknown publication intents.' };
    let resolved = 0;
    for (const item of unknowns) {
      if (item.kind === 'git.push') {
        const data = item.data as { remote: string; branch: string };
        const succeeded = await this.repositories.verifyPushOutcome(task.projectPath, task.worktreePath, data.remote, data.branch);
        this.store.clearPublicationIntent(item.id, succeeded ? 'complete' : 'failed');
        resolved++;
      } else if (item.kind === 'git.commit') {
        const clean = await this.repositories.verifyCommitOutcome(task.worktreePath);
        this.store.clearPublicationIntent(item.id, clean ? 'complete' : 'failed');
        resolved++;
      }
    }
    return { reconciled: true, detail: `Reconciled ${resolved} publication intent(s).` };
  }

  async commit(taskId: string, message: string): Promise<CommitResult> {
    const task = this.publishable(taskId);
    const clean = this.redactor.text(message);
    if (clean !== message) throw new Error('The commit message contains secret-like content.');
    const intent = this.store.intent('git.commit', { taskId, branch: task.branch });
    try {
      const result = await this.repositories.commitAll(task.worktreePath, task.branch, clean);
      this.store.finishIntent(intent, 'complete');
      this.store.saveTask({ ...this.store.task(taskId), updatedAt: new Date().toISOString() });
      this.publish('task.committed', { commit: result.commit, changedPaths: result.changedPaths.length }, taskId);
      return { ...result, branch: task.branch };
    } catch (error) {
      this.store.finishIntent(intent, error instanceof RepositoryError && error.outcome === 'none' ? 'complete' : 'unknown');
      throw error;
    }
  }

  async push(taskId: string, remote: string): Promise<PushResult> {
    const task = this.publishable(taskId);
    const intent = this.store.intent('git.push', { taskId, branch: task.branch, remote });
    try {
      const detail = await this.repositories.push(task.worktreePath, task.projectPath, remote, task.branch);
      this.store.finishIntent(intent, 'complete');
      this.publish('task.pushed', { remote, branch: task.branch }, taskId);
      return { remote, branch: task.branch, detail: this.redactor.text(detail) };
    } catch (error) {
      this.store.finishIntent(intent, error instanceof RepositoryError && error.outcome === 'none' ? 'complete' : 'unknown');
      throw error;
    }
  }

  /** Remove the task worktree(s) only when Git proves they hold no uncommitted or untracked files. The branch and all records remain. */
  async retire(taskId: string): Promise<RetireResult> {
    const task = this.store.task(taskId);
    if (this.ports.isRunning(taskId) || task.status === 'running') throw new Error('Wait for the active response to finish or cancel it before retiring the worktree.');
    if (task.status === 'retired') throw new Error('This task worktree is already retired.');
    if (task.parentTaskId || task.role === 'child') throw new Error('Retire a child worktree from its coordinated task; children are retired together with their root.');
    const members = [task, ...(task.mode === 'coordinated' ? this.store.allTasks().filter(item => item.parentTaskId === task.id) : [])];
    if (task.mode === 'coordinated' && this.ports.activeRuns(task.id) > 0) throw new Error('Every coordinator and child run must be terminal before the worktrees are retired.');
    if (members.some(member => member.status === 'running' || this.ports.isRunning(member.id))) throw new Error('A child agent is still active.');
    if (this.store.approvals(taskId).some(item => item.state === 'unknown')) throw new Error('This task has an unknown mutation outcome. Inspect the worktree before retiring it.');
    // Every worktree is checked read-only before any removal starts; one dirty worktree refuses the whole retirement.
    const present: Task[] = [];
    for (const member of members) {
      const exists = await fs.stat(member.worktreePath).then(stat => stat.isDirectory()).catch(() => false);
      if (!exists) continue;
      const dirty = await this.repositories.uncommittedPaths(member.worktreePath);
      if (dirty.length) throw new Error(`Worktree ${member.worktreePath} has uncommitted or untracked files (${dirty.slice(0, 10).join(', ')}${dirty.length > 10 ? ', …' : ''}). Commit, publish or discard them yourself before retiring; nothing was deleted.`);
      present.push(member);
    }
    const intent = this.store.intent('worktree.retire', { taskId, worktrees: present.map(member => member.worktreePath) });
    const removed: string[] = [];
    try {
      for (const member of present) {
        await this.repositories.removeWorktree(member.projectPath, member.worktreePath);
        removed.push(member.worktreePath);
      }
      const now = new Date().toISOString();
      this.store.transaction(() => {
        for (const member of members) this.store.saveTask({ ...this.store.task(member.id), status: 'retired', retiredAt: now, updatedAt: now });
        this.store.finishIntent(intent, 'complete');
      });
      this.publish('task.retired', { removedWorktrees: removed.length }, taskId);
      return { taskId, branch: task.branch, removedWorktrees: removed };
    } catch (error) {
      this.store.finishIntent(intent, removed.length || !(error instanceof RepositoryError && error.outcome === 'none') ? 'unknown' : 'complete');
      throw error;
    }
  }
}

function summarizeApproval(approval: Approval): Record<string, unknown> {
  return { id: approval.id, tool: approval.tool, state: approval.state, createdAt: approval.createdAt, path: approval.path ?? null, expectedHash: approval.expectedHash ?? null, resultingHash: approval.resultingHash ?? null, exitCode: approval.result?.exitCode ?? null, cleanupVerified: approval.result?.cleanupVerified ?? null, isError: approval.result?.isError ?? null, mcp: approval.mcp ? { serverKey: approval.mcp.serverKey, tool: approval.mcp.tool } : null };
}
function safeHost(endpoint: string): string | null { try { return new URL(endpoint).hostname; } catch { return null; } }
