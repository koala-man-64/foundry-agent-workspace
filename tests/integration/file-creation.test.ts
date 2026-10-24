import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Approval, GitTask, ProviderAdapter } from '../../packages/protocol/src/index';
import { FileCreationError, type FileCreation } from '../../packages/runtime/src/safe-file-creation';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService } from '../../packages/runtime/src/service';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

describe('new-file durable authority and recovery', () => {
  let directory: string, runtime: RuntimeService, store: Store, repositories: RepositoryService;
  let callId: string, currentTaskId: string;
  const identity = '0123456789abcdef:0123456789abcdef0123456789abcdef';
  const create = vi.fn<FileCreation['create']>();
  const provider: ProviderAdapter = {
    probe: async () => { throw new Error('unused'); },
    async *streamTurn(request) {
      if (!request.toolResults?.length) yield { type: 'tool_call', call: { id: callId, name: 'write_file', arguments: { path: 'new.txt', expectedHash: null, content: '' } } };
      else yield { type: 'text', text: 'Finished fixture turn.' };
      yield { type: 'done', continuation: { apiKind: 'fake', data: {} } };
    },
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'foundry-create-flow-')); callId = randomUUID(); create.mockReset();
    const source = path.join(directory, 'source'); await fs.mkdir(source);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, windowsHide: true });
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await fs.writeFile(path.join(source, 'README.md'), 'unchanged\n'); git('add', '.'); git('commit', '-qm', 'fixture');
    const creation: FileCreation = {
      async inspect(root, relative) {
        try { await fs.lstat(path.join(root, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [identity]; throw error; }
        throw new FileCreationError('Target already exists.', 'none');
      },
      create,
    };
    repositories = new RepositoryService(path.join(directory, 'wt'), creation);
    store = new Store(path.join(directory, 'state.db')); runtime = new RuntimeService(store, repositories, () => {}, () => provider);
    create.mockImplementation(async (root, relative, _identities, bytes) => {
      expect(store.approvals(currentTaskId)[0]!.state).toBe('executing');
      await fs.writeFile(path.join(root, relative), bytes, { flag: 'wx' });
    });
  });
  afterEach(async () => { await runtime.shutdown(); await fs.rm(directory, { recursive: true, force: true }); });
  const wait = async (predicate: () => boolean) => { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 10_000, interval: 10 }); };
  async function propose() {
    const task = await runtime.dispatch('task.create', { title: 'Create fixture', projectPath: path.join(directory, 'source'), profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 200000 }) as GitTask;
    currentTaskId = task.id;
    await runtime.dispatch('task.send', { taskId: task.id, content: 'Create the reviewed empty file.' });
    await wait(() => store.approvals(task.id).some(approval => approval.state === 'awaiting-approval'));
    return { task, approval: store.approvals(task.id).find(approval => approval.state === 'awaiting-approval')! };
  }
  const decide = (approval: Approval) => runtime.dispatch('approval.decide', { taskId: approval.taskId, approvalId: approval.id, nonce: approval.nonce, decision: 'approve' });
  const finished = (task: GitTask) => wait(() => store.task(task.id).status !== 'running');
  async function restart() { await runtime.shutdown(); store = new Store(path.join(directory, 'state.db')); runtime = new RuntimeService(store, repositories, () => {}, () => provider); }

  it('persists intent before empty creation and consumes approval even after external deletion', async () => {
    const { task, approval } = await propose();
    expect(approval).toMatchObject({ expectedHash: null, before: '', after: '', summary: 'Create new.txt' });
    await expect(fs.access(path.join(task.worktreePath, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await decide(approval); await finished(task);
    expect(store.approval(approval.id).state).toBe('complete');
    expect((await fs.stat(path.join(task.worktreePath, 'new.txt'))).size).toBe(0);
    await fs.unlink(path.join(task.worktreePath, 'new.txt'));
    await expect(decide(approval)).rejects.toThrow(/stale/i);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(directory, 'source', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not create after cancellation or restart of an awaiting approval', async () => {
    const { task, approval } = await propose();
    await runtime.dispatch('task.cancel', { taskId: task.id }); await finished(task);
    expect(create).not.toHaveBeenCalled();
    await restart();
    await expect(decide(approval)).rejects.toThrow(/stale/i);
    await expect(fs.access(path.join(task.worktreePath, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a lost reply after empty creation unknown through missing-file reconciliation and restart', async () => {
    const { task, approval } = await propose();
    create.mockImplementation(async (root, relative, _identities, bytes) => {
      expect(store.approval(approval.id).state).toBe('executing');
      await fs.writeFile(path.join(root, relative), bytes, { flag: 'wx' });
      throw new FileCreationError('lost reply after create', 'unknown');
    });
    await decide(approval); await finished(task);
    expect(store.approval(approval.id).state).toBe('unknown');
    await fs.unlink(path.join(task.worktreePath, 'new.txt'));
    const reconciled = await runtime.dispatch('approval.reconcile', { taskId: task.id, approvalId: approval.id }) as Approval;
    expect(reconciled.state).toBe('unknown');
    await restart(); expect(store.approval(approval.id).state).toBe('unknown');
    await expect(decide(approval)).rejects.toThrow(/stale/i);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
