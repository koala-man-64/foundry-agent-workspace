import { randomUUID } from 'node:crypto';
import type { Approval, ProviderToolResult, Task, ToolCall } from '../../protocol/src/index';
import { CommandRunner, CommandPreflightError, type CommandResult, type PreparedCommand } from './command-runner';
import { RepositoryService, RepositoryError, type PreparedEdit } from './repository';
import { Redactor } from './redaction';
import { Store } from './store';
import { ToolArguments, type ToolName } from './tool-definitions';
import { ExecutionSlots } from './execution-slots';
import { agentRole, isOrchestrationTool, ROLE_TOOLS } from './orchestration-tools';
import { covers, inScope, normalizeScopePath } from './scope';
import { McpError, McpManager } from './mcp';

export interface ApprovalBinding { rootTaskId: string; assignmentId: string | null; generation: number; targetLabel: string }
/** Orchestration extension points. Only the runtime supplies them; nothing in model output does. */
export interface OrchestrationToolHooks {
  execute(task: Task, call: ToolCall, signal: AbortSignal): Promise<ProviderToolResult>;
  binding(task: Task): ApprovalBinding | undefined;
  scopes(task: Task): { read: string[]; write: string[] } | undefined;
  /** Serialize coordinator commands with integration on the same worktree. */
  withRootLock<T>(task: Task, action: () => Promise<T>): Promise<T>;
  /** Called inside the execution slot immediately before and after an approved command. */
  commandStarting(task: Task): Promise<unknown>;
  /** `requestedEnvironment` is the model-supplied environment change set; validation evidence requires it to be empty. */
  commandFinished(task: Task, approval: Approval, before: unknown, executed: CommandResult, requestedEnvironment: Record<string, string>): Promise<{ evidenceId: string; passed: boolean } | undefined>;
  denied(task: Task, tool: string, reason: string): void;
}

/** One-shot decisions. Nothing in model output, repository text, or a saved intent grants approval. */
export class ToolRuntime {
  private readonly waiting = new Map<string, { taskId: string; resolve: (approved: boolean) => void }>();
  private orchestration?: OrchestrationToolHooks;
  private mcp?: McpManager;
  constructor(private readonly store: Store, private readonly repositories: RepositoryService, private readonly commands: CommandRunner, private readonly redactor: Redactor, private readonly publish: (type: string, data: unknown, taskId: string) => void, private readonly slots = new ExecutionSlots()) {}

  attachOrchestration(hooks: OrchestrationToolHooks): void { this.orchestration = hooks; }
  attachMcp(manager: McpManager): void { this.mcp = manager; }

  decide(taskId: string, id: string, nonce: string, decision: 'approve' | 'reject'): { accepted: boolean } {
    const approval = this.store.approval(id);
    // Coordinated approvals must carry their full root/target/revision/generation binding.
    if (approval.rootTaskId) throw new Error('This approval belongs to a coordinated task and requires its bound decision.');
    return this.resolveDecision(approval, taskId, nonce, decision);
  }

  decideBound(input: { rootTaskId: string; taskId: string; approvalId: string; nonce: string; assignmentId: string | null; generation: number; fingerprint: string; decision: 'approve' | 'reject' }, currentGeneration: number): { accepted: boolean } {
    const approval = this.store.approval(input.approvalId);
    if (!approval.rootTaskId || approval.rootTaskId !== input.rootTaskId || (approval.assignmentId ?? null) !== input.assignmentId || approval.generation !== input.generation || approval.generation !== currentGeneration || approval.fingerprint !== input.fingerprint) {
      throw new Error('This approval is stale or does not match the selected agent, revision or generation.');
    }
    return this.resolveDecision(approval, input.taskId, input.nonce, input.decision);
  }

  private resolveDecision(approval: Approval, taskId: string, nonce: string, decision: 'approve' | 'reject'): { accepted: boolean } {
    const waiter = this.waiting.get(approval.id);
    if (approval.taskId !== taskId || approval.nonce !== nonce || approval.state !== 'awaiting-approval' || waiter?.taskId !== taskId) throw new Error('This approval is stale or does not match the active task.');
    approval.state = decision === 'approve' ? 'approved' : 'rejected';
    this.save(approval); this.waiting.delete(approval.id); waiter.resolve(decision === 'approve');
    return { accepted: true };
  }

  /** Revoke every waiting decision for a task (used by scoped cancellation). */
  revokeWaiting(taskId: string): void {
    for (const [id, waiter] of [...this.waiting]) {
      if (waiter.taskId !== taskId) continue;
      const approval = this.store.approval(id);
      if (approval.state === 'awaiting-approval') { approval.state = 'revoked'; this.save(approval); }
      this.waiting.delete(id); waiter.resolve(false);
    }
  }

  async reconcile(taskId: string, id: string): Promise<Approval> {
    const approval = this.store.approval(id);
    if (approval.taskId !== taskId || approval.state !== 'unknown') throw new Error('Only an unknown outcome for this task can be checked.');
    if (approval.path && approval.resultingHash) {
      try {
        const file = await this.repositories.readFile(this.store.task(taskId).worktreePath, approval.path);
        if (file.hash === approval.resultingHash) { approval.state = 'complete'; approval.result = { content: 'Read-only reconciliation found the exact approved file content.', isError: false }; }
        else if (file.hash === approval.expectedHash) { approval.state = 'failed'; approval.result = { content: 'Read-only reconciliation found the original content. No retry was performed.', isError: true }; }
        else approval.result = { content: 'File content matches neither the original nor approved result. Outcome remains unknown; inspect the worktree.', isError: true };
      } catch { approval.result = { content: 'The file could not be checked safely. Outcome remains unknown.', isError: true }; }
    } else if (approval.handoff || approval.integration) {
      approval.result = { content: 'Use the orchestration operation check for this Git action. Its outcome is reconciled from repository state, never replayed.', isError: true };
    } else if (approval.mcp) {
      approval.result = { content: 'An external MCP tool outcome cannot be reconstructed by the runtime. Inspect the server\'s own state; this call will not be replayed.', isError: true };
    } else approval.result = { content: 'Command outcome cannot be reconstructed safely. Inspect the worktree and any external effects. This command will not be replayed.', isError: true, cleanupVerified: false };
    this.save(approval); return approval;
  }

  async execute(task: Task, call: ToolCall, signal: AbortSignal): Promise<ProviderToolResult> {
    const result = (content: string, isError = false): ProviderToolResult => {
      const clean = this.redactor.text(content);
      if (Buffer.byteLength(clean, 'utf8') > 192 * 1024) return { id: call.id, name: call.name, content: 'Tool output exceeded the result limit. Request a smaller result.', isError: true };
      return { id: call.id, name: call.name, content: clean, isError };
    };
    let approval: Approval | undefined;
    let command: PreparedCommand | undefined;
    try {
      signal.throwIfAborted();
      const role = agentRole(task);
      if (role !== 'coding' && !(ROLE_TOOLS[role] as string[]).includes(call.name)) {
        // Policy boundary: a fabricated coordinator-only call from a child (or edit call from a coordinator) is denied here even if an adapter accepted it.
        this.orchestration?.denied(task, call.name, `Tool is not available to the ${role} role.`);
        throw new Error(`Tool is not available to the ${role} role.`);
      }
      if (isOrchestrationTool(call.name)) {
        if (role === 'coding' || !this.orchestration) throw new Error('Tool is not available.');
        this.assertNoSecrets(JSON.stringify(call.arguments));
        return await this.orchestration.execute(task, call, signal);
      }
      if (McpManager.isMcpToolName(call.name)) {
        // External tools follow the same policy as repository tools: user-allowlisted read-only tools run within policy; everything else needs a one-shot decision.
        const resolved = this.mcp?.resolve(call.name);
        if (!resolved || role !== 'coding') throw new Error('Tool is not available.');
        const serialized = JSON.stringify(call.arguments ?? {});
        this.assertNoSecrets(serialized);
        if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) throw new Error('MCP tool arguments must be a JSON object.');
        const mcpCall = async (): Promise<ProviderToolResult> => {
          const outcome = await this.mcp!.call(resolved.server, resolved.tool.name, call.arguments, signal);
          return result(outcome.content, outcome.isError);
        };
        if (resolved.readOnly) return await this.slots.use(signal, mcpCall);
        approval = { id: randomUUID(), taskId: task.id, toolCallId: call.id, nonce: randomUUID(), tool: call.name, state: 'awaiting-approval', createdAt: new Date().toISOString(), summary: `Call external MCP tool "${resolved.tool.name}" on server "${resolved.server.name}" with these exact arguments. External tools act outside this worktree with your Windows privileges.`, fingerprint: randomUUID(), mcp: { serverId: resolved.server.id, serverKey: resolved.server.key, serverName: resolved.server.name, tool: resolved.tool.name, arguments: serialized } };
        if (!await this.requestApproval(approval, signal)) return result(signal.aborted ? 'Action cancelled before execution.' : 'User rejected this action. Do not repeat this proposal without new user instructions.', true);
        signal.throwIfAborted();
        const approvedMcp = approval;
        await this.slots.use(signal, async () => {
          approvedMcp.state = 'executing'; this.save(approvedMcp);
          try {
            const outcome = await this.mcp!.call(resolved.server, resolved.tool.name, call.arguments, signal);
            approvedMcp.state = outcome.isError ? 'failed' : 'complete';
            approvedMcp.result = { content: outcome.content, isError: outcome.isError };
          } catch (error) {
            // A timeout or broken transport after the request was sent leaves the external effect unknown.
            approvedMcp.state = error instanceof McpError && !error.unknownOutcome ? 'failed' : 'unknown';
            approvedMcp.result = { content: this.redactor.text(error instanceof Error ? error.message : 'MCP call failed.'), isError: true };
          }
        });
        this.save(approval);
        return result(approval.result!.content, approval.result!.isError);
      }
      if (!Object.hasOwn(ToolArguments, call.name)) throw new Error('Tool is not available.');
      this.assertNoSecrets(JSON.stringify(call.arguments));
      const name = call.name as ToolName;
      const scopes = role === 'child' ? this.orchestration?.scopes(task) : undefined;
      if (role === 'child' && !scopes) throw new Error('Child scope is unavailable; no repository access was performed.');
      if (name === 'list_directory') {
        const args = ToolArguments.list_directory.parse(call.arguments);
        if (scopes && !this.readableDirectory(scopes.read, args.path)) throw new Error('Path is outside this assignment read scope.');
        const entries = await this.repositories.listFiles(task.worktreePath, args.path);
        return result(JSON.stringify(scopes ? entries.filter(entry => entry.kind === 'directory' ? this.readableDirectory(scopes.read, entry.path) : inScope(scopes.read, entry.path) || scopes.read.includes('')) : entries));
      }
      if (name === 'read_file') {
        const args = ToolArguments.read_file.parse(call.arguments);
        if (scopes && !this.readable(scopes.read, args.path)) throw new Error('Path is outside this assignment read scope.');
        return result(JSON.stringify(await this.repositories.readFile(task.worktreePath, args.path)));
      }
      if (name === 'search_text') {
        const args = ToolArguments.search_text.parse(call.arguments);
        if (scopes && !this.readableDirectory(scopes.read, args.path)) throw new Error('Path is outside this assignment read scope.');
        const found = await this.repositories.search(task.worktreePath, args.query, args.path);
        return result(JSON.stringify(scopes ? { ...found, matches: found.matches.filter(match => this.readable(scopes.read, match.path)) } : found));
      }
      let edit: PreparedEdit | undefined;
      let requestedEnvironment: Record<string, string> = {};
      const binding = this.orchestration?.binding(task);
      if (role !== 'coding' && !binding) throw new Error('This agent is fenced or no longer active; no action was proposed.');
      const common = { id: randomUUID(), taskId: task.id, toolCallId: call.id, nonce: randomUUID(), tool: name, state: 'awaiting-approval' as const, createdAt: new Date().toISOString(), ...(binding ?? {}) };
      if (name === 'run_command') {
        const args = ToolArguments.run_command.parse(call.arguments);
        requestedEnvironment = args.environment;
        command = await this.commands.prepare(task.worktreePath, args);
        this.assertNoSecrets(JSON.stringify(command));
        approval = { ...common, summary: 'Run this exact PowerShell command with your Windows privileges.', ...command };
      } else {
        let relativePath: string; let expectedHash: string | null; let after: string;
        if (name === 'write_file') { const args = ToolArguments.write_file.parse(call.arguments); relativePath = args.path; expectedHash = args.expectedHash; after = args.content; }
        else {
          const args = ToolArguments.replace_text.parse(call.arguments); relativePath = args.path; expectedHash = args.expectedHash;
          if (scopes && !inScope(scopes.write, relativePath)) throw new Error('Path is outside this assignment write scope.');
          const file = await this.repositories.readFile(task.worktreePath, args.path);
          if (file.hash !== args.expectedHash) throw new Error('File changed since it was read. Read it again before proposing an edit.');
          if (file.content.split(args.oldText).length !== 2) throw new Error('oldText must occur exactly once in the file.');
          after = file.content.replace(args.oldText, () => args.newText);
        }
        // Scope is enforced before any file access for the edit.
        if (scopes && !inScope(scopes.write, relativePath)) throw new Error('Path is outside this assignment write scope.');
        edit = await this.repositories.prepareEdit(task.worktreePath, relativePath, expectedHash, after);
        if (scopes && !inScope(scopes.write, edit.path)) throw new Error('Path is outside this assignment write scope.');
        this.assertNoSecrets(edit.before ?? ''); this.assertNoSecrets(edit.after);
        approval = { ...common, summary: expectedHash === null ? `Create ${edit.path}` : `Edit ${edit.path}`, path: edit.path, before: edit.before, after: edit.after, expectedHash, resultingHash: edit.resultingHash, fingerprint: edit.fingerprint };
      }
      if (!await this.requestApproval(approval, signal)) return result(signal.aborted ? 'Action cancelled before execution.' : 'User rejected this action. Do not repeat this proposal without new user instructions.', true);
      signal.throwIfAborted();
      // The executing intent is durable before any repository or process mutation.
      const approved = approval;
      let evidence: { evidenceId: string; passed: boolean } | undefined;
      const perform = () => this.slots.use(signal, async () => {
        approved.state = 'executing'; this.save(approved);
        if (edit) {
          await this.repositories.applyEdit(edit);
          approved.state = 'complete'; approved.result = { content: JSON.stringify({ path: edit.path, hash: edit.resultingHash, applied: true }), isError: false };
        } else if (command) {
          const before = role !== 'coding' ? await this.orchestration!.commandStarting(task).catch(() => undefined) : undefined;
          const executed = await this.commands.execute(command, signal);
          approved.state = executed.cleanupVerified ? (executed.exitCode === 0 && !executed.cancelled && !executed.timedOut ? 'complete' : 'failed') : 'unknown';
          if (role !== 'coding') {
            evidence = await this.orchestration!.commandFinished(task, approved, before, executed, requestedEnvironment).catch(() => undefined);
            if (evidence) approved.evidenceId = evidence.evidenceId;
          }
          const content = this.redactor.text(JSON.stringify(evidence ? { ...executed, evidenceId: evidence.evidenceId, validationPassed: evidence.passed } : executed));
          approved.result = { content, isError: approved.state !== 'complete', cleanupVerified: executed.cleanupVerified, ...(executed.exitCode !== null ? { exitCode: executed.exitCode } : {}) };
        }
      });
      if (command && role === 'coordinator') await this.orchestration!.withRootLock(task, perform);
      else await perform();
      this.save(approval);
      return result(approval.result!.content, approval.result!.isError);
    } catch (error) {
      const content = this.redactor.text(error instanceof Error ? error.message : 'Tool failed.');
      if (approval) {
        const knownUnstarted = error instanceof CommandPreflightError || (error instanceof RepositoryError && error.outcome === 'none');
        approval.state = approval.state === 'executing' && !knownUnstarted ? 'unknown' : approval.state === 'complete' || approval.state === 'failed' || approval.state === 'unknown' ? approval.state : signal.aborted ? 'revoked' : approval.state === 'rejected' ? 'rejected' : 'failed';
        approval.result = { content, isError: true, ...(approval.command ? { cleanupVerified: false } : {}) }; this.save(approval);
      }
      return result(content, true);
    } finally {
      if (command) this.commands.discard?.(command);
    }
  }

  /** Persist a proposal and wait for its one-shot decision without holding an execution slot. */
  requestApproval(approval: Approval, signal: AbortSignal): Promise<boolean> { return this.awaitDecision(approval, signal); }
  saveApproval(approval: Approval): void { this.save(approval); }

  private readable(scopes: string[], candidate: string): boolean {
    try { return scopes.some(scope => covers(scope, normalizeScopePath(candidate, false))); } catch { return false; }
  }
  /** A directory is navigable when it is inside a read scope or is an ancestor of one. */
  private readableDirectory(scopes: string[], candidate: string): boolean {
    let normalized: string;
    try { normalized = normalizeScopePath(candidate, true); } catch { return false; }
    return scopes.some(scope => covers(scope, normalized) || covers(normalized, scope));
  }
  private assertNoSecrets(value: string): void { if (this.redactor.text(value) !== value) throw new Error('This action contains secret-like content and cannot be persisted or executed.'); }
  private save(approval: Approval): void { this.store.saveApproval(approval); this.publish('approval.changed', { approvalId: approval.id, state: approval.state }, approval.taskId); }
  private awaitDecision(approval: Approval, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    return new Promise(resolve => {
      const finish = (approved: boolean): void => { signal.removeEventListener('abort', cancel); resolve(approved); };
      const cancel = (): void => { this.waiting.delete(approval.id); approval.state = 'revoked'; this.save(approval); finish(false); };
      this.waiting.set(approval.id, { taskId: approval.taskId, resolve: finish });
      signal.addEventListener('abort', cancel, { once: true });
      this.save(approval);
      if (signal.aborted && this.waiting.has(approval.id)) cancel();
    });
  }
}
