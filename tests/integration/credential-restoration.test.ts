import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProfile, ProviderAdapter, GitTask } from '../../packages/protocol/src/index';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { RuntimeService, profileFingerprint } from '../../packages/runtime/src/service';
import { Store } from '../../packages/runtime/src/store';

const capabilities = { streaming: true, tools: true, continuation: true, cancellation: true, usage: true };
const secret = 'synthetic-restoration-credential';
const binding = (profile: ModelProfile): string => JSON.stringify([profile.apiKind, profile.endpoint, profile.deployment]);
let directory: string;
let project: string;
let store: Store;
let runtime: RuntimeService;
const sentCredentials: (string | undefined)[] = [];
const provider: ProviderAdapter = {
  async probe() { return { ok: true, capabilities, detail: 'Injected offline probe', fingerprint: '' }; },
  async *streamTurn(request) {
    sentCredentials.push(request.credential);
    yield { type: 'text', text: 'Synthetic reply' };
    yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
    yield { type: 'done', continuation: { apiKind: request.profile.apiKind, data: { input: [...request.messages, { role: 'assistant', content: 'Synthetic reply' }] } } };
  }
};
function openRuntime(): void {
  store = new Store(join(directory, 'data', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => undefined, () => provider);
}
async function qualifiedProfile(name: string): Promise<ModelProfile> {
  const profile = await runtime.dispatch('profile.save', { id: randomUUID(), name, apiKind: 'responses', endpoint: 'https://fixture.openai.azure.com', deployment: 'fixture', contextLimit: 32000, outputLimit: 2048 }) as ModelProfile;
  runtime.setCredential(profile.id, secret, binding(profile));
  await runtime.dispatch('profile.probe', { profileId: profile.id });
  return store.profile(profile.id)!;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-credential-restore-'));
  project = join(directory, 'source'); await mkdir(project);
  const git = (...args: string[]): void => { execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { windowsHide: true, stdio: 'pipe' }); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'README.md'), '# Isolated credential fixture\n'); git('add', '.'); git('commit', '-m', 'fixture');
  sentCredentials.length = 0; openRuntime();
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });

describe('trusted initial vault restoration', () => {
  it('retains root and child profile qualification across restart and permits the first real-API-kind send', async () => {
    const root = await qualifiedProfile('Coordinator'); const child = await qualifiedProfile('Child');
    const task = await runtime.dispatch('task.create', { title: 'Resume after restart', projectPath: project, profileId: root.id, mode: 'chat', tokenBudget: 100000 }) as GitTask;
    await runtime.shutdown(); openRuntime();
    for (const profile of [root, child]) {
      runtime.setCredential(profile.id, secret, binding(profile), true);
      expect(store.profile(profile.id)?.verificationFingerprint).toBe(profileFingerprint(profile));
      expect(store.profile(profile.id)?.capabilities).toEqual(capabilities);
      expect(store.profile(profile.id)?.verifiedAt).toBe(profile.verifiedAt);
    }
    await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'First message after restart' })).resolves.toEqual({ accepted: true });
    await expect.poll(() => store.task(task.id).status).toBe('idle');
    expect(sentCredentials).toEqual([secret]);
    expect(JSON.stringify(store.detail(task.id))).not.toContain(secret);
  });

  it('refuses a stale endpoint binding or an attempted restoration over a different initialized credential', async () => {
    const profile = await qualifiedProfile('Bound profile');
    expect(() => runtime.setCredential(profile.id, secret, 'wrong-binding', true)).toThrow('Profile changed');
    expect(() => runtime.setCredential(profile.id, 'different-synthetic-secret', binding(profile), true)).toThrow('uninitialized');
    expect(store.profile(profile.id)?.verificationFingerprint).toBe(profileFingerprint(profile));
    expect(() => runtime.setCredential(profile.id, secret, undefined, true)).toThrow('uninitialized');
  });

  it('still invalidates qualification for replacement, including replacement before the first vault hydration', async () => {
    const profile = await qualifiedProfile('Rotated profile');
    await runtime.shutdown(); openRuntime();
    // Main uses this default path before saving a new vault value. No restore claim
    // can turn a supported credential replacement into a qualified credential.
    runtime.setCredential(profile.id, 'replacement-synthetic-secret', binding(profile));
    expect(store.profile(profile.id)?.verificationFingerprint).toBeUndefined();
    expect(store.profile(profile.id)?.capabilities).toBeUndefined();
    expect(store.profile(profile.id)?.verifiedAt).toBeUndefined();
    await runtime.dispatch('profile.probe', { profileId: profile.id });
    expect(store.profile(profile.id)?.verificationFingerprint).toBe(profileFingerprint(profile));
    runtime.setCredential(profile.id, 'another-synthetic-secret', binding(profile));
    expect(store.profile(profile.id)?.verificationFingerprint).toBeUndefined();
  });

  it('does not adopt a replacement when durable invalidation fails, so the same-secret retry still invalidates', async () => {
    const profile = await qualifiedProfile('Failure-atomic rotation');
    const save = vi.spyOn(store, 'saveProfile').mockImplementationOnce(() => { throw new Error('Injected SQLite write failure'); });
    try {
      expect(() => runtime.setCredential(profile.id, 'replacement-after-write-failure', binding(profile))).toThrow('SQLite write failure');
      expect(store.profile(profile.id)?.verificationFingerprint).toBe(profileFingerprint(profile));
    } finally { save.mockRestore(); }
    runtime.setCredential(profile.id, 'replacement-after-write-failure', binding(profile));
    expect(store.profile(profile.id)?.verificationFingerprint).toBeUndefined();
    expect(store.profile(profile.id)?.capabilities).toBeUndefined();
  });
});
