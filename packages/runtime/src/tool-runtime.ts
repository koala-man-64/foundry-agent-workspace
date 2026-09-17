import { randomUUID } from 'node:crypto';
import type { Approval, ProviderToolResult, Task, ToolCall } from '../../protocol/src/index';
import { CommandRunner, CommandPreflightError, type PreparedCommand } from './command-runner';
import { RepositoryService, RepositoryError, type PreparedEdit } from './repository';
import { Redactor } from './redaction';
import { Store } from './store';
import { ToolArguments, type ToolName } from './tool-definitions';
import { ExecutionSlots } from './execution-slots';

/** One-shot decisions. Nothing in model output, repository text, or a saved intent grants approval. */
export class ToolRuntime {
  private readonly waiting = new Map<string, { taskId: string; resolve: (approved: boolean) => void }>();
  constructor(private readonly store: Store, private readonly repositories: RepositoryService, private readonly commands: CommandRunner, private readonly redactor: Redactor, private readonly publish: (type: string, data: unknown, taskId: string) => void, private readonly slots = new ExecutionSlots()) {}

  decide(taskId: string, id: string, nonce: string, decision: 'approve' | 'reject'): { accepted: boolean } {
    const approval = this.store.approval(id); const waiter = this.waiting.get(id);
    if (approval.taskId !== taskId || approval.nonce !== nonce || approval.state !== 'awaiting-approval' || waiter?.taskId !== taskId) throw new Error('This approval is stale or does not match the active task.');
    approval.state = decision === 'approve' ? 'approved' : 'rejected';
    this.save(approval); this.waiting.delete(id); waiter.resolve(decision === 'approve');
    return { accepted: true };
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
      if (!Object.hasOwn(ToolArguments, call.name)) throw new Error('Tool is not available.');
      this.assertNoSecrets(JSON.stringify(call.arguments));
      const name = call.name as ToolName;
      if (name === 'list_directory') { const args = ToolArguments.list_directory.parse(call.arguments); return result(JSON.stringify(await this.repositories.listFiles(task.worktreePath, args.path))); }
      if (name === 'read_file') { const args = ToolArguments.read_file.parse(call.arguments); return result(JSON.stringify(await this.repositories.readFile(task.worktreePath, args.path))); }
      if (name === 'search_text') { const args = ToolArguments.search_text.parse(call.arguments); return result(JSON.stringify(await this.repositories.search(task.worktreePath, args.query, args.path))); }
      let edit: PreparedEdit | undefined;
      const common = { id: randomUUID(), taskId: task.id, toolCallId: call.id, nonce: randomUUID(), tool: name, state: 'awaiting-approval' as const, createdAt: new Date().toISOString() };
      if (name === 'run_command') {
        const args = ToolArguments.run_command.parse(call.arguments);
        command = await this.commands.prepare(task.worktreePath, args);
        this.assertNoSecrets(JSON.stringify(command));
        approval = { ...common, summary: 'Run this exact PowerShell command with your Windows privileges.', ...command };
      } else {
        let relativePath: string; let expectedHash: string | null; let after: string;
        if (name === 'write_file') { const args = ToolArguments.write_file.parse(call.arguments); relativePath = args.path; expectedHash = args.expectedHash; after = args.content; }
        else {
          const args = ToolArguments.replace_text.parse(call.arguments); relativePath = args.path; expectedHash = args.expectedHash;
          const file = await this.repositories.readFile(task.worktreePath, args.path);
          if (file.hash !== args.expectedHash) throw new Error('File changed since it was read. Read it again before proposing an edit.');
          if (file.content.split(args.oldText).length !== 2) throw new Error('oldText must occur exactly once in the file.');
          after = file.content.replace(args.oldText, () => args.newText);
        }
        edit = await this.repositories.prepareEdit(task.worktreePath, relativePath, expectedHash, after);
        this.assertNoSecrets(edit.before ?? ''); this.assertNoSecrets(edit.after);
        approval = { ...common, summary: expectedHash === null ? `Create ${edit.path}` : `Edit ${edit.path}`, path: edit.path, before: edit.before, after: edit.after, expectedHash, resultingHash: edit.resultingHash, fingerprint: edit.fingerprint };
      }
      if (!await this.awaitDecision(approval, signal)) return result(signal.aborted ? 'Action cancelled before execution.' : 'User rejected this action. Do not repeat this proposal without new user instructions.', true);
      signal.throwIfAborted();
      // The executing intent is durable before any repository or process mutation.
      const approved = approval;
      await this.slots.use(signal, async () => {
      approved.state = 'executing'; this.save(approved);
      if (edit) {
        await this.repositories.applyEdit(edit);
        approved.state = 'complete'; approved.result = { content: JSON.stringify({ path: edit.path, hash: edit.resultingHash, applied: true }), isError: false };
      } else if (command) {
        const executed = await this.commands.execute(command, signal);
        const content = this.redactor.text(JSON.stringify(executed));
        approved.state = executed.cleanupVerified ? (executed.exitCode === 0 && !executed.cancelled && !executed.timedOut ? 'complete' : 'failed') : 'unknown';
        approved.result = { content, isError: approved.state !== 'complete', cleanupVerified: executed.cleanupVerified, ...(executed.exitCode !== null ? { exitCode: executed.exitCode } : {}) };
      }
      });
      this.save(approval);
      return result(approval.result!.content, approval.result!.isError);
    } catch (error) {
      const content = this.redactor.text(error instanceof Error ? error.message : 'Tool failed.');
      if (approval) {
        const knownUnstarted = error instanceof CommandPreflightError || (error instanceof RepositoryError && error.outcome === 'none');
        approval.state = approval.state === 'executing' && !knownUnstarted ? 'unknown' : signal.aborted ? 'revoked' : 'failed';
        approval.result = { content, isError: true, ...(approval.command ? { cleanupVerified: false } : {}) }; this.save(approval);
      }
      return result(content, true);
    } finally {
      if (command) this.commands.discard?.(command);
    }
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
