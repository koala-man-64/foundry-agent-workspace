import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Project, Task } from '../../protocol/src/index';
import { AgentChannel } from '../src/agent-channel';
import { prepareRequest } from '../src/agent-loop';
import { Redactor } from '../src/redaction';
import { RepositoryService } from '../src/repository';
import { RuntimeService } from '../src/service';
import { FAKE_PROFILE_ID, Store } from '../src/store';

let directory: string;
let folder: string;
let store: Store;
let runtime: RuntimeService;
const start = (projectId: string | null, requestId = randomUUID()) => runtime.dispatch('task.start', {
  requestId, projectId, content: 'A first line\nmore detail', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000
}) as Promise<Task>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-projects-'));
  folder = join(directory, 'notes'); await mkdir(folder);
  await writeFile(join(folder, 'readme.txt'), 'folder content');
  await writeFile(join(folder, '.env'), 'secret');
  store = new Store(join(directory, 'data', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });

describe('saved projects and first-send creation', () => {
  it('deduplicates a folder, persists name, visibility and preferences, and marks a missing folder unavailable', async () => {
    const project = await runtime.dispatch('project.add', { path: folder }) as Project;
    expect(project).toMatchObject({ name: 'notes', kind: 'folder', hidden: false });
    expect((await runtime.dispatch('project.add', { path: join(folder, '.') }) as Project).id).toBe(project.id);
    await runtime.dispatch('project.update', { projectId: project.id, name: 'Notes archive', hidden: true });
    await runtime.dispatch('workspace.preferences.save', { profileId: FAKE_PROFILE_ID, mode: 'coding', collapsedProjectIds: [project.id, 'none', project.id] });
    let snapshot = await runtime.dispatch('workspace.summary', {}) as { projects: Project[]; preferences: { mode: string; collapsedProjectIds: string[] } };
    expect(snapshot.projects[0]).toMatchObject({ id: project.id, name: 'Notes archive', hidden: true });
    expect(snapshot.preferences).toMatchObject({ mode: 'coding', collapsedProjectIds: [project.id, 'none'] });
    await runtime.dispatch('project.update', { projectId: project.id, hidden: false });
    await rm(folder, { recursive: true });
    snapshot = await runtime.dispatch('workspace.summary', {}) as typeof snapshot;
    expect(snapshot.projects[0]).toMatchObject({ kind: 'unavailable', unavailableReason: expect.any(String) });
  });

  it('keeps same-named folders distinct and rejects invalid preference references', async () => {
    const other = join(directory, 'other', 'notes'); await mkdir(other, { recursive: true });
    const first = await runtime.dispatch('project.add', { path: folder }) as Project;
    const second = await runtime.dispatch('project.add', { path: other }) as Project;
    expect(first.name).toBe('notes'); expect(second.name).toBe('notes'); expect(first.id).not.toBe(second.id);
    if (process.platform === 'win32') expect((await runtime.dispatch('project.add', { path: folder.toUpperCase() }) as Project).id).toBe(first.id);
    await expect(runtime.dispatch('workspace.preferences.save', { profileId: randomUUID() })).rejects.toThrow('existing model profile');
    await expect(runtime.dispatch('workspace.preferences.save', { collapsedProjectIds: [randomUUID()] })).rejects.toThrow('no longer exists');
  });

  it('starts ordinary-folder chat once and exposes only safe read-only file access', async () => {
    const project = await runtime.dispatch('project.add', { path: folder }) as Project;
    const requestId = randomUUID();
    const first = await start(project.id, requestId);
    expect(first).toMatchObject({ workspaceKind: 'folder', projectId: project.id, projectPath: project.path, title: 'A first line' });
    expect('worktreePath' in first).toBe(false);
    expect((await start(project.id, requestId)).id).toBe(first.id);
    expect(store.detail(first.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
    await expect(runtime.dispatch('task.start', { requestId, projectId: project.id, content: 'different', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000 })).rejects.toThrow('different chat settings');
    expect(await runtime.dispatch('files.read', { taskId: first.id, path: 'readme.txt' })).toMatchObject({ content: 'folder content' });
    await expect(runtime.dispatch('files.read', { taskId: first.id, path: '.env' })).rejects.toThrow();
    await expect(runtime.dispatch('files.read', { taskId: first.id, path: '../data/workspace.db' })).rejects.toThrow();
    for (const method of ['task.diff', 'task.commit', 'task.push', 'task.reconcilePublication', 'task.retire'] as const) {
      const params = method === 'task.commit' ? { taskId: first.id, message: 'x' } : method === 'task.push' ? { taskId: first.id, confirm: 'push' } : method === 'task.retire' ? { taskId: first.id, confirm: 'retire' } : { taskId: first.id };
      await expect(runtime.dispatch(method, params)).rejects.toThrow('Git worktree');
    }
    await expect(runtime.dispatch('channel.get', { taskId: first.id })).rejects.toThrow('Git worktree');
    await expect(runtime.dispatch('channel.send', { taskId: first.id, requestId: randomUUID(), recipientTaskId: null, content: 'x' })).rejects.toThrow();
    const request = prepareRequest(store, first, store.profile(FAKE_PROFILE_ID)!, '', 'hello', undefined, new AbortController().signal, undefined, [], new AgentChannel(store, new Redactor(), () => {}));
    expect(request.tools).toBeUndefined();
    expect(request.messages).toEqual(expect.arrayContaining([{ role: 'user', content: 'hello' }]));
  });

  it('starts a projectless chat with no file access and rejects coding and forged project IDs', async () => {
    const task = await start(null);
    expect(task.workspaceKind).toBe('none');
    expect('projectPath' in task).toBe(false);
    await expect(runtime.dispatch('files.list', { taskId: task.id })).rejects.toThrow('no folder access');
    await expect(runtime.dispatch('files.read', { taskId: task.id, path: 'readme.txt' })).rejects.toThrow('no folder access');
    await expect(runtime.dispatch('channel.get', { taskId: task.id })).rejects.toThrow('Git worktree');
    await expect(runtime.dispatch('channel.send', { taskId: task.id, requestId: randomUUID(), recipientTaskId: null, content: 'x' })).rejects.toThrow();
    const request = prepareRequest(store, task, store.profile(FAKE_PROFILE_ID)!, '', 'hello', undefined, new AbortController().signal, undefined, [], new AgentChannel(store, new Redactor(), () => {}));
    expect(request.tools).toBeUndefined();
    await expect(runtime.dispatch('task.start', { requestId: randomUUID(), projectId: null, content: 'coding', profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 100000 })).rejects.toThrow('Git project');
    await expect(start(randomUUID())).rejects.toThrow('Project not found');
  });

  it('returns one task and one first message for repeated or concurrent request IDs, including after restart', async () => {
    const requestId = randomUUID();
    const [a, b] = await Promise.all([start(null, requestId), start(null, requestId)]);
    expect(a.id).toBe(b.id);
    expect(store.detail(a.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
    await runtime.shutdown();
    store = new Store(join(directory, 'data', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
    expect((await start(null, requestId)).id).toBe(a.id);
    expect(store.detail(a.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('never replays an interrupted pending start and retries a known first-message failure on the same task', async () => {
    const interruptedId = randomUUID();
    const input = { requestId: interruptedId, projectId: null, content: 'A first line\nmore detail', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 100000 };
    store.reserveTaskStart(interruptedId, createHash('sha256').update(JSON.stringify(input)).digest('hex'), randomUUID());
    await runtime.shutdown();
    store = new Store(join(directory, 'data', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), () => {});
    await expect(start(null, interruptedId)).rejects.toThrow('unknown outcome');
    expect(store.allTasks()).toHaveLength(0);

    const requestId = randomUUID();
    const shortBudget = () => runtime.dispatch('task.start', { requestId, projectId: null, content: 'A first line\nmore detail', profileId: FAKE_PROFILE_ID, mode: 'chat', tokenBudget: 1024 }) as Promise<Task>;
    await expect(shortBudget()).rejects.toThrow('budget');
    const reserved = store.taskStart(requestId)!;
    expect(reserved.state).toBe('failed');
    expect(store.detail(reserved.taskId).messages).toHaveLength(0);
    store.saveTask({ ...store.task(reserved.taskId), tokenBudget: 100000 });
    const retried = await shortBudget();
    expect(retried.id).toBe(reserved.taskId);
    expect(store.detail(retried.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('treats a nested Git folder as an ordinary folder', async () => {
    execFileSync('git', ['-C', folder, 'init', '-b', 'main'], { windowsHide: true });
    const nested = join(folder, 'nested'); await mkdir(nested);
    const rootProject = await runtime.dispatch('project.add', { path: folder }) as Project;
    const nestedProject = await runtime.dispatch('project.add', { path: nested }) as Project;
    expect(rootProject.kind).toBe('git');
    expect(nestedProject.kind).toBe('folder');
    await expect(runtime.dispatch('task.start', { requestId: randomUUID(), projectId: nestedProject.id, content: 'code', profileId: FAKE_PROFILE_ID, mode: 'coding', tokenBudget: 100000 })).rejects.toThrow('Git project');
  });

  it('retains an unknown worktree intent if persistence fails after Git created it', async () => {
    execFileSync('git', ['-C', folder, 'init', '-b', 'main'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'config', 'user.name', 'Fixture'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'config', 'user.email', 'fixture@example.invalid'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'add', 'readme.txt'], { windowsHide: true });
    execFileSync('git', ['-C', folder, '-c', 'core.hooksPath=NUL', 'commit', '-m', 'fixture'], { windowsHide: true });
    const project = await runtime.dispatch('project.add', { path: folder }) as Project;
    const original = store.saveTask.bind(store);
    store.saveTask = () => { throw new Error('injected persistence failure'); };
    try { await expect(start(project.id)).rejects.toThrow('unknown outcome'); }
    finally { store.saveTask = original; }
    expect(store.unknownIntents()).toBe(1);
    await expect(start(project.id)).rejects.toThrow('unknown outcome');
  });

  it('coalesces concurrent Git starts with the same ID before either creates a worktree', async () => {
    execFileSync('git', ['-C', folder, 'init', '-b', 'main'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'config', 'user.name', 'Fixture'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'config', 'user.email', 'fixture@example.invalid'], { windowsHide: true });
    execFileSync('git', ['-C', folder, 'add', 'readme.txt'], { windowsHide: true });
    execFileSync('git', ['-C', folder, '-c', 'core.hooksPath=NUL', 'commit', '-m', 'fixture'], { windowsHide: true });
    const project = await runtime.dispatch('project.add', { path: folder }) as Project;
    const requestId = randomUUID();
    const [first, second] = await Promise.all([start(project.id, requestId), start(project.id, requestId)]);
    expect(first.id).toBe(second.id);
    expect(first.workspaceKind).toBe('git');
    expect(store.allTasks()).toHaveLength(1);
    expect(store.detail(first.id).messages.filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('rejects a saved folder replaced by a junction or symlink before browsing or starting', async () => {
    const project = await runtime.dispatch('project.add', { path: folder }) as Project;
    const task = await start(project.id);
    const moved = join(directory, 'old-notes');
    await rename(folder, moved);
    const other = join(directory, 'other-notes'); await mkdir(other); await writeFile(join(other, 'readme.txt'), 'wrong folder');
    await symlink(other, folder, process.platform === 'win32' ? 'junction' : 'dir');
    expect((await runtime.dispatch('workspace.summary', {}) as { projects: Project[] }).projects[0]).toMatchObject({ kind: 'unavailable' });
    await expect(runtime.dispatch('files.list', { taskId: task.id })).rejects.toThrow('different location');
    await expect(runtime.dispatch('files.read', { taskId: task.id, path: 'readme.txt' })).rejects.toThrow('different location');
    await expect(start(project.id)).rejects.toThrow('different location');
  });
});
