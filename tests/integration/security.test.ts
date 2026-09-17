import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProfile, ProviderAdapter, Task } from '../../packages/protocol/src/index';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store } from '../../packages/runtime/src/store';

const profile: ModelProfile = {
  id: 'f4e2076f-6025-4f91-b58a-61c5c0321e86', name: 'Remote', apiKind: 'responses',
  endpoint: 'https://resource.openai.azure.com', deployment: 'model', credentialRef: 'f4e2076f-6025-4f91-b58a-61c5c0321e86',
  contextLimit: 8192, outputLimit: 256
};

describe('runtime credential generation', () => {
  let directory: string;
  let store: Store;
  let runtime: RuntimeService;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'foundry-security-test-'));
    store = new Store(join(directory, 'workspace.db'));
  });

  afterEach(async () => {
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it('rejects a probe result captured before its credential changes', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const startedGate = new Promise<void>(resolve => { started = resolve; });
    let probedCredential: string | undefined;
    const provider: ProviderAdapter = {
      streamTurn: () => { throw new Error('not used'); },
      probe: async (_profile, credential) => {
        probedCredential = credential;
        started();
        await gate;
        return { ok: true, capabilities: { streaming: true, tools: false, continuation: false, cancellation: true, usage: true }, detail: 'ok', fingerprint: 'provider' };
      }
    };
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {}, () => provider);
    await runtime.dispatch('profile.save', profile);
    runtime.setCredential(profile.id, 'first-secret');

    const probing = runtime.dispatch('profile.probe', { profileId: profile.id });
    await startedGate;
    expect(probedCredential).toBe('first-secret');
    runtime.setCredential(profile.id, 'second-secret');
    release();

    await expect(probing).rejects.toThrow('credential changed during probe');
    expect(store.profile(profile.id)?.verificationFingerprint).toBeUndefined();
  });

  it('drains an already-started worktree creation before closing SQLite', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const startedGate = new Promise<void>(resolve => { started = resolve; });
    const repository = {
      createTaskWorktree: async () => {
        started();
        await gate;
        return { worktreePath: join(directory, 'worktree'), branch: 'agent/test', baseCommit: '0123456789abcdef0123456789abcdef01234567' };
      }
    } as unknown as RepositoryService;
    runtime = new RuntimeService(store, repository, () => {});

    const creating = runtime.dispatch('task.create', { title: 'Drain', projectPath: join(directory, 'source'), profileId: '00000000-0000-4000-8000-000000000001', tokenBudget: 10_000 });
    await startedGate;
    const stopping = runtime.shutdown();
    await expect(runtime.dispatch('workspace.snapshot', {})).rejects.toThrow('shutting down');
    release();
    const task = await creating as Task;
    await stopping;

    const reopened = new Store(join(directory, 'workspace.db'));
    expect(reopened.task(task.id).status).toBe('idle');
    reopened.close();
  });
});
