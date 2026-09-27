import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ProviderAdapter } from '../../protocol/src/index';
import { V1_SCHEMA, V2_MIGRATION } from '../src/schema';
import { FAKE_PROFILE_ID, Store } from '../src/store';
import { RepositoryService } from '../src/repository';
import { RuntimeService } from '../src/service';
import { WorkspaceQueries } from '../src/workspace-queries';

let directory: string | undefined;
let runtime: RuntimeService | undefined;
let store: Store | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.shutdown(); store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  runtime = undefined; store = undefined; directory = undefined;
});

it('closes upgrade admission, drains an accepted bounded read, then upgrades the backed-up database', async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-upgrade-admission-'));
  const path = join(directory, 'workspace.db');
  const legacy = new Database(path); legacy.exec(V1_SCHEMA); legacy.pragma('user_version = 1'); legacy.close();
  store = new Store(path);
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
  const queries = (runtime as unknown as { queries: WorkspaceQueries }).queries;
  const original = queries.dispatch.bind(queries);
  vi.spyOn(queries, 'dispatch').mockImplementation((method, input) => method === 'workspace.summary'
    ? (started(), barrier.then(() => original(method, input))) : original(method, input));
  const read = runtime.dispatch('workspace.summary', {});
  await entered;
  const upgrade = runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' });
  try {
    await expect(runtime.dispatch('workspace.summary', {})).rejects.toThrow('upgrade is in progress');
    await expect(runtime.dispatch('profile.save', { ...store.profile(FAKE_PROFILE_ID)!, name: 'Too late' })).rejects.toThrow('upgrade is in progress');
    expect(() => runtime!.setCredential(FAKE_PROFILE_ID, 'not-admitted')).toThrow('upgrade is in progress');
    expect(store.schemaVersion).toBe(1);
  } finally { finish(); }
  await expect(read).resolves.toMatchObject({ runtime: 'ready' });
  await expect(upgrade).resolves.toMatchObject({ version: 3 });
  expect(store.schemaVersion).toBe(3);
});

it('rejects an upgrade promptly during active work while cancellation remains admitted', async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-upgrade-active-'));
  const path = join(directory, 'workspace.db');
  const legacy = new Database(path); legacy.exec(V1_SCHEMA); legacy.pragma('user_version = 1'); legacy.close();
  store = new Store(path);
  const taskId = randomUUID(); const now = new Date().toISOString();
  store.saveTask({ id: taskId, title: 'Active', projectPath: directory, worktreePath: directory, branch: 'codex/task/active',
    baseCommit: 'a'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle', createdAt: now, updatedAt: now, tokenBudget: 1000, usedTokens: 0, mode: 'chat' });
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const provider: ProviderAdapter = {
    probe: async () => { started(); await barrier; return { ok: false, detail: 'fixture', fingerprint: 'fixture', capabilities: { streaming: false, tools: false, continuation: false, cancellation: false, usage: false } }; },
    streamTurn() { throw new Error('unused'); }
  };
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {}, () => provider);
  const probe = runtime.dispatch('profile.probe', { profileId: FAKE_PROFILE_ID });
  await entered;
  try {
    await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).rejects.toThrow('Finish or cancel active work');
    await expect(runtime.dispatch('task.cancel', { taskId })).resolves.toEqual({ accepted: false });
    await expect(runtime.dispatch('workspace.summary', {})).resolves.toMatchObject({ runtime: 'ready' });
    expect(store.schemaVersion).toBe(1);
  } finally { finish(); }
  await probe;
  await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).resolves.toMatchObject({ version: 3 });
});

it('does not back up a v2 workspace while orchestrator background root work is active', async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-upgrade-orchestrator-'));
  const path = join(directory, 'workspace.db');
  const legacy = new Database(path); legacy.exec(V1_SCHEMA); legacy.exec(V2_MIGRATION); legacy.pragma('user_version = 2'); legacy.close();
  store = new Store(path);
  const taskId = randomUUID(); const now = new Date().toISOString();
  const task = { id: taskId, title: 'Coordinator', projectPath: directory, worktreePath: directory, branch: 'codex/task/root',
    baseCommit: 'a'.repeat(40), profileId: FAKE_PROFILE_ID, status: 'idle' as const, createdAt: now, updatedAt: now,
    tokenBudget: 1000, usedTokens: 0, mode: 'coordinated' as const };
  store.saveTask(task);
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const background = runtime.orchestrator.withRootLock(task, async () => { started(); await barrier; });
  await entered;
  try {
    expect(runtime.orchestrator.isBusy()).toBe(true);
    await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).rejects.toThrow('Finish or cancel active work');
    expect(store.schemaVersion).toBe(2);
    await expect(runtime.dispatch('workspace.summary', {})).resolves.toMatchObject({ runtime: 'ready' });
  } finally { finish(); }
  await background;
  expect(runtime.orchestrator.isBusy()).toBe(false);
  await expect(runtime.dispatch('workspace.upgrade', { confirm: 'backup-and-upgrade' })).resolves.toMatchObject({ version: 3 });
});
