import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Approval, ProviderAdapter, Task } from '../../packages/protocol/src/index';
import { RuntimeService, profileFingerprint } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { CommandRunner, CommandPreflightError, type PreparedCommand } from '../../packages/runtime/src/command-runner';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

describe('coding approvals and recovery', () => {
  let directory: string; let store: Store; let runtime: RuntimeService; let repository: RepositoryService;
  const execute = vi.fn(async () => ({ stdout: 'Foundry command demo completed', stderr: '', exitCode: 0, cancelled: false, timedOut: false, cleanupVerified: true }));
  const commands = { prepare: async (root: string, args: { command: string; timeoutMs: number }) => ({ ...args, cwd: root, shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', environment: {}, fingerprint: 'bound-test-command' } as PreparedCommand), execute } as unknown as CommandRunner;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foundry-coding-'));
    execFileSync('git', ['init', '-q', join(directory, 'source')]);
    const git = (...args: string[]): void => { execFileSync('git', ['-C', join(directory, 'source'), ...args]); };
    git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(directory, 'source', 'README.md'), '# Fixture\n'); git('add', '.'); git('commit', '-qm', 'fixture');
    store = new Store(join(directory, 'state.db')); repository = new RepositoryService(join(directory, 'wt'));
    runtime = new RuntimeService(store, repository, () => {}, undefined, commands); execute.mockClear();
  });
  afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const task = async (): Promise<Task> => await runtime.dispatch('task.create', { title: 'Coding', projectPath: join(directory, 'source'), profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 200000 }) as Task;
  const waitFor = async (check: () => boolean): Promise<void> => { await vi.waitFor(() => expect(check()).toBe(true), { timeout: 10000, interval: 10 }); };
  const proposal = async (id: string): Promise<Approval> => { await waitFor(() => store.approvals(id).some(item => item.state === 'awaiting-approval')); return store.approvals(id).find(item => item.state === 'awaiting-approval')!; };
  const decide = (approval: Approval, decision: 'approve' | 'reject' = 'approve') => runtime.dispatch('approval.decide', { taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, decision });
  const start = (id: string) => runtime.dispatch('task.send', { taskId: id, content: '/demo' });
  const done = (id: string) => waitFor(() => store.task(id).status !== 'running');

  it('runs read/edit/command only after exact one-shot decisions and retains evidence', async () => {
    const created = await task(); await start(created.id); const edit = await proposal(created.id);
    expect(edit.tool).toBe('replace_text'); expect(execute).not.toHaveBeenCalled();
    expect(await readFile(join(created.worktreePath, 'README.md'), 'utf8')).toBe('# Fixture\n');
    await expect(runtime.dispatch('approval.decide', { taskId: created.id, approvalId: edit.id, nonce: randomUUID(), decision: 'approve' })).rejects.toThrow('stale');
    await expect(runtime.dispatch('approval.decide', { taskId: randomUUID(), approvalId: edit.id, nonce: edit.nonce, decision: 'approve' })).rejects.toThrow('stale');
    await decide(edit); await expect(decide(edit)).rejects.toThrow('stale');
    const command = await proposal(created.id); expect(command.command).toContain('Write-Output'); expect(execute).not.toHaveBeenCalled();
    await decide(command); await done(created.id);
    expect(store.task(created.id).status).toBe('idle'); expect(execute).toHaveBeenCalledTimes(1);
    expect(await readFile(join(created.worktreePath, 'README.md'), 'utf8')).toBe(edit.after);
    expect(await readFile(join(directory, 'source', 'README.md'), 'utf8')).toBe('# Fixture\n');
    expect(store.detail(created.id).approvals?.[0]?.after).toBe(edit.after);
    expect(store.providerState(created.id)?.pending).toEqual([]);
  });
  it('records rejection without editing or executing a command', async () => {
    const created = await task(); await start(created.id); const edit = await proposal(created.id); await decide(edit, 'reject'); await done(created.id);
    expect(await readFile(join(created.worktreePath, 'README.md'), 'utf8')).toBe('# Fixture\n');
    expect(execute).not.toHaveBeenCalled(); expect(store.approval(edit.id).state).toBe('rejected');
    expect(store.detail(created.id).messages.at(-1)?.content).toContain('rejected');
  });
  it('revokes waiting approval on cancellation and rejects replay', async () => {
    const created = await task(); await start(created.id); const edit = await proposal(created.id);
    await runtime.dispatch('task.cancel', { taskId: created.id }); await done(created.id);
    expect(store.task(created.id).status).toBe('cancelled'); expect(store.approval(edit.id).state).toBe('revoked');
    await expect(decide(edit)).rejects.toThrow('stale'); expect(execute).not.toHaveBeenCalled();
  });
  it('does not occupy execution slots while awaiting approval', async () => {
    const tasks = await Promise.all(Array.from({ length: 4 }, () => task()));
    for (const created of tasks) await start(created.id);
    await Promise.all(tasks.map(created => proposal(created.id)));
    expect(tasks.every(created => store.task(created.id).status === 'running')).toBe(true);
    for (const created of tasks) await runtime.dispatch('task.cancel', { taskId: created.id });
    await Promise.all(tasks.map(created => done(created.id)));
  });
  it('detects a stale edit and never overwrites intervening user content', async () => {
    const created = await task(); await start(created.id); const edit = await proposal(created.id);
    await writeFile(join(created.worktreePath, 'README.md'), 'User changed this\n'); await decide(edit); await done(created.id);
    expect(store.approval(edit.id).state).toBe('failed');
    expect(await readFile(join(created.worktreePath, 'README.md'), 'utf8')).toBe('User changed this\n');
    expect(store.task(created.id).status).toBe('idle'); expect(execute).not.toHaveBeenCalled();
  });
  it('reconciles exact file state read-only after restart without replaying a tool', async () => {
    const created = await task(); await start(created.id); const edit = await proposal(created.id);
    await runtime.dispatch('task.cancel', { taskId: created.id }); await done(created.id);
    store.saveApproval({ ...edit, state: 'executing' });
    await writeFile(join(created.worktreePath, edit.path!), edit.after!); await runtime.shutdown();
    store = new Store(join(directory, 'state.db')); runtime = new RuntimeService(store, repository, () => {}, undefined, commands);
    expect(store.approval(edit.id).state).toBe('unknown');
    const checked = await runtime.dispatch('approval.reconcile', { taskId: created.id, approvalId: edit.id }) as Approval;
    expect(checked.state).toBe('complete'); expect(execute).not.toHaveBeenCalled();
  });
  it('never guesses successful command cleanup from a runner exception', async () => {
    execute.mockRejectedValueOnce(new Error('helper lost'));
    const created = await task(); await start(created.id); await decide(await proposal(created.id));
    const command = await proposal(created.id); await decide(command); await done(created.id);
    expect(store.approval(command.id)).toMatchObject({ state: 'unknown', result: { isError: true, cleanupVerified: false } });
    await expect(start(created.id)).rejects.toThrow('unknown mutation');
    await runtime.dispatch('approval.reconcile', { taskId: created.id, approvalId: command.id }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('distinguishes a proven command preflight rejection from unknown execution', async () => {
    execute.mockRejectedValueOnce(new CommandPreflightError('Prepared command fingerprint is stale.'));
    const created = await task(); await start(created.id); await decide(await proposal(created.id));
    const command = await proposal(created.id); await decide(command); await done(created.id);
    expect(store.approval(command.id)).toMatchObject({ state: 'failed', result: { isError: true, cleanupVerified: false } });
    expect(store.task(created.id).status).toBe('idle');
  });
  it('does not persist secret-bearing opaque native continuation or execute its tools', async () => {
    const created = await task(); await runtime.shutdown(); store = new Store(join(directory, 'state.db'));
    const provider: ProviderAdapter = { probe: async () => { throw new Error('unused'); }, async *streamTurn() {
      yield { type: 'tool_call', call: { id: 'bad', name: 'run_command', arguments: { command: 'Write-Output 1' } } };
      yield { type: 'done', continuation: { apiKind: 'fake', data: 'secret-canary-value' } };
    } };
    runtime = new RuntimeService(store, repository, () => {}, () => provider, commands); runtime.setCredential(FAKE_PROFILE_ID, 'secret-canary-value');
    await start(created.id); await done(created.id);
    expect(store.task(created.id).status).toBe('failed'); expect(store.providerState(created.id)).toBeUndefined(); expect(store.approvals(created.id)).toEqual([]);
    expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(store.detail(created.id))).not.toContain('secret-canary-value');
  });
  it('repairs missing interrupted tool results as errors and does not replay them', async () => {
    const created = await task(); const profile = store.profile(FAKE_PROFILE_ID)!;
    store.saveProviderState(created.id, { fingerprint: profileFingerprint(profile), continuation: { apiKind: 'fake', data: {} }, pending: [{ id: 'interrupted', name: 'run_command', arguments: {} }], results: [] });
    await runtime.shutdown(); store = new Store(join(directory, 'state.db'));
    const provider: ProviderAdapter = { probe: async () => { throw new Error('unused'); }, async *streamTurn(request) {
      expect(request.messages).toEqual([{ role: 'user', content: 'continue' }]);
      expect(request.toolResults).toEqual([expect.objectContaining({ id: 'interrupted', isError: true })]);
      yield { type: 'text', text: 'Stopped action was not replayed.' }; yield { type: 'done', continuation: { apiKind: 'fake', data: {} } };
    } };
    runtime = new RuntimeService(store, repository, () => {}, () => provider, commands);
    await runtime.dispatch('task.send', { taskId: created.id, content: 'continue' }); await done(created.id);
    expect(store.task(created.id).status).toBe('idle'); expect(execute).not.toHaveBeenCalled();
  });
  it('rejects a tool-call ID reused by a later model response', async () => {
    const created = await task(); await runtime.shutdown(); store = new Store(join(directory, 'state.db')); let responses = 0;
    const provider: ProviderAdapter = { probe: async () => { throw new Error('unused'); }, async *streamTurn() {
      responses++; yield { type: 'tool_call', call: { id: 'reused', name: 'read_file', arguments: { path: 'README.md' } } };
      yield { type: 'done', continuation: { apiKind: 'fake', data: { responses } } };
    } };
    runtime = new RuntimeService(store, repository, () => {}, () => provider, commands);
    await start(created.id); await done(created.id);
    expect(responses).toBe(2); expect(store.task(created.id).status).toBe('failed');
    expect(store.providerState(created.id)?.seenToolCallIds).toEqual(['reused']); expect(execute).not.toHaveBeenCalled();
  });
});
