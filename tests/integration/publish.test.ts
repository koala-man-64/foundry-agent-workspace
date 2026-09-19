import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ZodError } from 'zod';
import type { CommitResult, DiagnosticsExport, PushResult, RetireResult, Task } from '../../packages/protocol/src/index';
import { RuntimeService } from '../../packages/runtime/src/service';
import { RepositoryService } from '../../packages/runtime/src/repository';
import { Store, FAKE_PROFILE_ID } from '../../packages/runtime/src/store';

let directory: string; let store: Store; let runtime: RuntimeService; let project: string; let remote: string;
const events: { type: string; taskId?: string; data: unknown }[] = [];
function git(cwd: string, ...args: string[]): string { return execFileSync('git', ['-c', 'core.hooksPath=NUL', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim(); }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'foundry-publish-')); project = join(directory, 'source'); remote = join(directory, 'remote.git'); await mkdir(project);
  execFileSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
  git(project, 'init', '-b', 'main'); git(project, 'config', 'user.name', 'Fixture'); git(project, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(project, 'hello.txt'), 'original\n'); git(project, 'add', 'hello.txt'); git(project, 'commit', '-m', 'fixture'); git(project, 'remote', 'add', 'origin', remote);
  store = new Store(join(directory, 'state', 'workspace.db'));
  runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event));
  events.length = 0;
});
afterEach(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true }); });
const createTask = async (title = 'Publish'): Promise<Task> => await runtime.dispatch('task.create', { title, projectPath: project, profileId: FAKE_PROFILE_ID, tokenBudget: 100000 }) as Task;

describe('explicit commit, push and worktree retirement', () => {
  it('commits only on explicit request, refuses secret-named paths, and leaves the source checkout untouched', async () => {
    const task = await createTask();
    await expect(runtime.dispatch('task.commit', { taskId: task.id, message: 'nothing' })).rejects.toThrow('no changes');
    await writeFile(join(task.worktreePath, 'hello.txt'), 'changed\n');
    await writeFile(join(task.worktreePath, 'new.txt'), 'new file\n');
    await writeFile(join(task.worktreePath, '.env'), 'API_KEY=should-never-be-committed\n');
    await expect(runtime.dispatch('task.commit', { taskId: task.id, message: 'with secret' })).rejects.toThrow('secret-named');
    expect(git(task.worktreePath, 'rev-list', '--count', 'HEAD')).toBe('1');
    await rm(join(task.worktreePath, '.env'));
    runtime.setCredential(FAKE_PROFILE_ID, 'commit-canary-value-1234');
    await expect(runtime.dispatch('task.commit', { taskId: task.id, message: 'token commit-canary-value-1234' })).rejects.toThrow('secret-like');
    const result = await runtime.dispatch('task.commit', { taskId: task.id, message: 'Task change' }) as CommitResult;
    expect(result.branch).toBe(task.branch);
    expect(result.changedPaths.sort()).toEqual(['hello.txt', 'new.txt']);
    expect(git(task.worktreePath, 'rev-parse', 'HEAD')).toBe(result.commit);
    expect(git(task.worktreePath, 'log', '-1', '--format=%s')).toBe('Task change');
    expect(git(task.worktreePath, 'status', '--porcelain')).toBe('');
    expect(git(project, 'rev-parse', 'HEAD')).toBe(task.baseCommit);
    expect(git(project, 'status', '--porcelain')).toBe('');
    expect(events.some(event => event.type === 'task.committed' && event.taskId === task.id)).toBe(true);
  });

  it('refuses to commit when a Git filter could run during staging', async () => {
    const task = await createTask();
    await writeFile(join(task.worktreePath, 'hello.txt'), 'changed\n');
    // A .gitattributes edit is an ordinary file change; `git add` would otherwise run the clean filter with the user's privileges.
    await writeFile(join(task.worktreePath, '.gitattributes'), '*.txt filter=stamp\n');
    await expect(runtime.dispatch('task.commit', { taskId: task.id, message: 'filtered' })).rejects.toThrow('filters');
    expect(git(task.worktreePath, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(task.worktreePath, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('pushes the task branch to a configured remote without forcing and rejects unknown remotes', async () => {
    const task = await createTask();
    await writeFile(join(task.worktreePath, 'hello.txt'), 'pushed\n');
    const commit = await runtime.dispatch('task.commit', { taskId: task.id, message: 'Push me' }) as CommitResult;
    await expect(runtime.dispatch('task.push', { taskId: task.id, remote: 'upstream', confirm: 'push' })).rejects.toThrow('not configured');
    await expect(runtime.dispatch('task.push', { taskId: task.id, remote: 'origin' })).rejects.toBeInstanceOf(ZodError);
    const pushed = await runtime.dispatch('task.push', { taskId: task.id, remote: 'origin', confirm: 'push' }) as PushResult;
    expect(pushed).toMatchObject({ remote: 'origin', branch: task.branch });
    expect(git(remote, 'rev-parse', `refs/heads/${task.branch}`)).toBe(commit.commit);
    expect(git(remote, 'show-ref', '--heads')).not.toContain('refs/heads/main');
    // A second push of the same branch is a no-op; a diverged remote would be rejected by Git, never forced.
    await runtime.dispatch('task.push', { taskId: task.id, remote: 'origin', confirm: 'push' });
    git(remote, 'update-ref', `refs/heads/${task.branch}`, task.baseCommit);
    git(project, 'commit', '--allow-empty', '-m', 'diverge');
    git(remote, 'fetch', project, `main:refs/heads/${task.branch}`, '--force');
    await expect(runtime.dispatch('task.push', { taskId: task.id, remote: 'origin', confirm: 'push' })).rejects.toThrow();
    expect(git(remote, 'rev-parse', `refs/heads/${task.branch}`)).toBe(git(project, 'rev-parse', 'main'));
  });

  it('retires only clean worktrees, keeps the branch and history, and blocks further sends', async () => {
    const task = await createTask();
    await runtime.dispatch('task.send', { taskId: task.id, content: 'hello' });
    await expect.poll(() => store.task(task.id).status, { timeout: 5000 }).toBe('idle');
    await writeFile(join(task.worktreePath, 'draft.txt'), 'uncommitted user file\n');
    await expect(runtime.dispatch('task.retire', { taskId: task.id, confirm: 'retire' })).rejects.toThrow('draft.txt');
    expect((await stat(task.worktreePath)).isDirectory()).toBe(true);
    expect(await readFile(join(task.worktreePath, 'draft.txt'), 'utf8')).toBe('uncommitted user file\n');
    expect(store.task(task.id).status).toBe('idle');
    await runtime.dispatch('task.commit', { taskId: task.id, message: 'Keep draft' });
    const result = await runtime.dispatch('task.retire', { taskId: task.id, confirm: 'retire' }) as RetireResult;
    expect(result.removedWorktrees).toEqual([task.worktreePath]);
    await expect(stat(task.worktreePath)).rejects.toThrow();
    expect(git(project, 'rev-parse', '--verify', task.branch)).toHaveLength(40);
    expect(git(project, 'worktree', 'list')).not.toContain(task.worktreePath);
    expect(store.task(task.id)).toMatchObject({ status: 'retired', retiredAt: expect.any(String) });
    expect(store.detail(task.id).messages).toHaveLength(2);
    await expect(runtime.dispatch('task.send', { taskId: task.id, content: 'more' })).rejects.toThrow('retired');
    await expect(runtime.dispatch('task.retire', { taskId: task.id, confirm: 'retire' })).rejects.toThrow('already retired');
    await expect(runtime.dispatch('task.commit', { taskId: task.id, message: 'x' })).rejects.toThrow('retired');
    expect(git(project, 'status', '--porcelain')).toBe('');
    // The snapshot keeps the retired task in history and later tasks are unaffected.
    expect((await createTask('Next')).id).toBeTruthy();
  });

  it('refuses to retire or publish a coordinated root while any run is non-terminal', async () => {
    await runtime.shutdown(); store = new Store(join(directory, 'state', 'workspace.db'));
    runtime = new RuntimeService(store, new RepositoryService(join(directory, 'worktrees')), event => events.push(event), undefined, undefined, { coordinatedMode: true });
    const root = await runtime.dispatch('task.create', { title: 'Root', projectPath: project, profileId: FAKE_PROFILE_ID, mode: 'coordinated', tokenBudget: 600000, coordination: { childProfileIds: [], requiredValidation: { command: 'Write-Output ok', cwd: '', timeoutMs: 60000 } } }) as Task;
    await expect(runtime.dispatch('task.retire', { taskId: root.id, confirm: 'retire' })).rejects.toThrow('terminal');
    await expect(runtime.dispatch('task.commit', { taskId: root.id, message: 'x' })).rejects.toThrow('Coordinated');
    await expect(runtime.dispatch('task.push', { taskId: root.id, remote: 'origin', confirm: 'push' })).rejects.toThrow('Coordinated');
    expect((await stat(root.worktreePath)).isDirectory()).toBe(true);
    expect(store.task(root.id).status).toBe('idle');
  });

  it('serializes concurrent worktree creation in one repository', async () => {
    const tasks = await Promise.all(Array.from({ length: 6 }, (_, index) => createTask(`Parallel ${index}`)));
    expect(new Set(tasks.map(task => task.worktreePath)).size).toBe(6);
    expect(store.unknownIntents()).toBe(0);
  });

  it('exports sanitized diagnostics without credentials, canaries or private file contents', async () => {
    const canary = 'diagnostic-canary-secret-5678';
    const task = await createTask('Diag');
    await writeFile(join(task.worktreePath, 'private.txt'), 'PRIVATE-FILE-CONTENT-XYZ\n');
    runtime.setCredential(FAKE_PROFILE_ID, canary);
    await runtime.dispatch('task.send', { taskId: task.id, content: `my key is ${canary} and PRIVATE-FILE-CONTENT-XYZ` });
    await expect.poll(() => store.task(task.id).status, { timeout: 5000 }).toBe('idle');
    const result = await runtime.dispatch('diagnostics.export', {}) as DiagnosticsExport;
    const text = await readFile(result.path, 'utf8');
    expect(result.path.startsWith(join(directory, 'state', 'diagnostics'))).toBe(true);
    expect(Buffer.byteLength(text, 'utf8')).toBe(result.bytes);
    const bundle = JSON.parse(text) as { tasks: { id: string; messageCount: number; usage: { requests: number } }[]; recentEvents: unknown[]; profiles: { endpointHost: string | null }[] };
    expect(bundle.tasks.map(item => item.id)).toContain(task.id);
    expect(bundle.tasks.find(item => item.id === task.id)).toMatchObject({ messageCount: 2, usage: { requests: 1 } });
    expect(bundle.recentEvents.length).toBeGreaterThan(0);
    expect(text).not.toContain(canary);
    expect(text).not.toContain('PRIVATE-FILE-CONTENT-XYZ');
    expect(text).not.toContain('my key is');
  });
});
