import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ModelProfile, ProviderAdapter, ProviderEvent, Task } from '../../packages/protocol/src/index';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

let directory: string;
let store: Store;
let runtime: RuntimeService;
let project: string;
const events: { type: string; data: unknown }[] = [];
function git(...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', project, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-runtime-test-')); project = join(directory, 'source'); await mkdir(project);
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'hello.txt'), 'original\n'); git('add', 'hello.txt'); git('commit', '-m', 'fixture');
  store = new Store(join(directory, 'state', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event));
  events.length = 0;
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
async function createTask(): Promise<Task> { return await runtime.dispatch('task.create', { title: 'Fixture task', projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task; }
async function waitDone(id: string): Promise<void> { await expect.poll(() => store.task(id).status, { timeout: 3000 }).not.toBe('running'); }
describe('runtime integration', () => {
  it('creates an isolated task, persists a response, and leaves dirty source untouched', async () => {
    await writeFile(join(project, 'hello.txt'), 'dirty source\n');
    const task = await createTask();
    expect(task.worktreePath).not.toBe(project);
    expect((await runtime.dispatch('files.read', { taskId: task.id, path: 'hello.txt' }) as { content: string }).content).toBe('original\n');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'hello' }); await waitDone(task.id);
    expect(store.detail(task.id).messages.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(store.detail(task.id).messages[1]?.content).toContain('hello');
    expect(store.task(task.id).usedTokens).toBeGreaterThan(0);
    expect(git('status', '--porcelain')).toContain('hello.txt');
  });
  it('rejects invalid RPC input and forged verification', async () => {
    await expect(runtime.dispatch('task.create', { title: 'bad', projectPath: project, profileId: FAKE_PROFILE_ID, arbitrary: true })).rejects.toThrow();
    const profile = { ...store.profile(FAKE_PROFILE_ID)!, verifiedAt: 'forged', verificationFingerprint: 'forged' };
    const saved = await runtime.dispatch('profile.save', profile) as ModelProfile;
    expect(saved.verifiedAt).toBeUndefined(); expect(saved.verificationFingerprint).toBeUndefined();
  });
  it('does not poison future task creation after a preflight failure', async () => {
    await expect(runtime.dispatch('task.create', { title: 'bad', projectPath: join(directory, 'missing'), profileId: FAKE_PROFILE_ID })).rejects.toThrow();
    expect(store.unknownIntents()).toBe(0); expect((await createTask()).id).toBeTruthy();
  });
  it('fails closed before a request that cannot fit the task budget', async () => {
    const task = await createTask(); store.saveTask({ ...task, tokenBudget: 1024 });
    await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'hello' })).rejects.toThrow('budget');
    expect(store.detail(task.id).messages).toHaveLength(0);
  });
  it('reconciles interrupted history and conservatively retains its reserved usage', async () => {
    const task = await createTask();
    store.saveTask({ ...task, status: 'running', usedTokens: 1234 });
    store.saveMessage({ id: 'partial', taskId: task.id, role: 'assistant', content: 'partial response', status: 'streaming', createdAt: new Date().toISOString() });
    const intent = store.intent('worktree.create', { taskId: 'orphan' }); expect(intent).toBeTruthy();
    await runtime.shutdown();
    store = new Store(join(directory, 'state', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
    expect(store.task(task.id).status).toBe('interrupted'); expect(store.task(task.id).usedTokens).toBe(1234);
    expect(store.detail(task.id).messages[0]?.status).toBe('interrupted'); expect(store.unknownIntents()).toBe(1);
    await expect(createTask()).rejects.toThrow('unknown outcome');
  });
  it('does not leak a credential split across stream frames into persisted content or events', async () => {
    const task = await createTask(); await runtime.shutdown();
    store = new Store(join(directory, 'state', 'workspace.db'));
    const provider: ProviderAdapter = {
      probe: async () => { throw new Error('not used'); },
      async *streamTurn(): AsyncIterable<ProviderEvent> { yield { type: 'text', text: 'hello SECRET-' }; yield { type: 'text', text: 'CANARY-12345 end' }; yield { type: 'done' }; }
    };
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), () => provider);
    runtime.setCredential(FAKE_PROFILE_ID, 'SECRET-CANARY-12345');
    await runtime.dispatch('task.send', { taskId: task.id, content: 'answer' }); await waitDone(task.id);
    expect(store.detail(task.id).messages[1]?.content).toBe('hello [REDACTED] end');
    expect(JSON.stringify(events)).not.toContain('SECRET-CANARY');
    expect(store.task(task.id).usedTokens).toBeGreaterThan(2048);
  });
  it('cancels a running response without claiming completion or refunding unknown usage', async () => {
    const task = await createTask(); await runtime.shutdown(); store = new Store(join(directory, 'state', 'workspace.db'));
    const provider: ProviderAdapter = { probe: async () => { throw new Error('not used'); }, async *streamTurn(request) {
      yield { type: 'text', text: 'partial' };
      await new Promise<void>(resolve => { if (request.signal.aborted) resolve(); else request.signal.addEventListener('abort', () => resolve(), { once: true }); });
      throw new Error('aborted');
    } };
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), () => provider);
    await runtime.dispatch('task.send', { taskId: task.id, content: 'start' });
    await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'duplicate' })).rejects.toThrow('active');
    await runtime.dispatch('task.cancel', { taskId: task.id }); await waitDone(task.id);
    expect(store.task(task.id).status).toBe('cancelled'); expect(store.detail(task.id).messages[1]?.status).toBe('cancelled');
    expect(store.task(task.id).usedTokens).toBeGreaterThan(2048);
    expect(events.some(event => event.type === 'task.completed')).toBe(false);
  });
});
